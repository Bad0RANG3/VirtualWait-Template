"""VirtualWait queue idle notify plugin for AstrBot."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import aiohttp

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star, register
from astrbot.api.message_components import At, Plain
from astrbot.api import AstrBotConfig
from astrbot.core.message.message_event_result import MessageChain

logger = logging.getLogger("astrbot.plugin.virtualwait_queue")

from helpers import (
    build_head_key,
    build_call_reminder,
    build_queue_status_text,
    parse_json_object,
    resolve_umo,
)

# Cap on upstream response bytes before we reject (prevents unbounded
# buffering on a compromised/misconfigured upstream).
_DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024


@register(
    "virtualwait_queue",
    "VirtualWait",
    "VirtualWait 机台空闲排队 @ 通知",
    "0.1.0",
)
class VirtualWaitQueueNotify(Star):
    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)
        self.config = config or {}
        self._task: asyncio.Task | None = None
        self._session: aiohttp.ClientSession | None = None
        self._stop = asyncio.Event()
        self._last_head: dict[str, str] = {}
        self._cooldown_until: dict[str, float] = {}
        self._round = 0
        self._backoff = 0.0
        self._skipped_no_qq = 0
        self._last_stats_at = time.time()

    def _cfg(self, key: str, default: Any = None) -> Any:
        try:
            if hasattr(self.config, "get"):
                return self.config.get(key, default)
        except Exception:
            pass
        if isinstance(self.config, dict):
            return self.config.get(key, default)
        return default

    async def initialize(self):
        self._stop.clear()
        self._session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=20)
        )
        self._task = asyncio.create_task(self._loop())
        logger.info("virtualwait_queue started")

    async def terminate(self):
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except Exception:
                pass
        if self._session:
            await self._session.close()
            self._session = None
        logger.info("virtualwait_queue stopped")

    async def _loop(self):
        while not self._stop.is_set():
            try:
                await self._poll_once()
                self._backoff = 0.0
            except asyncio.CancelledError:
                raise
            except Exception:
                # Log a de-identified event — never include the exception text
                # which may carry upstream response bodies.
                logger.warning("poll cycle failed (backoff=%.1f)", self._backoff)
                self._backoff = min(
                    float(self._cfg("max_backoff_sec", 120) or 120),
                    max(5.0, (self._backoff or 5.0) * 2),
                )
            interval = float(self._cfg("poll_interval_sec", 8) or 8)
            wait = interval + self._backoff
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=wait)
            except asyncio.TimeoutError:
                pass
            self._maybe_log_stats()

    def _maybe_log_stats(self):
        every = float(self._cfg("stats_interval_sec", 600) or 600)
        now = time.time()
        if now - self._last_stats_at >= every:
            logger.info(
                json.dumps(
                    {
                        "event": "skipped_no_qq_stats",
                        "skipped_no_qq_count": self._skipped_no_qq,
                        "ts": int(now),
                    },
                    ensure_ascii=False,
                )
            )
            self._last_stats_at = now

    async def _request(self, path: str) -> dict[str, Any]:
        """Fetch a VirtualWait Bot API endpoint with bounded response reading.

        The response is read in chunks and capped at *max_response_bytes*.
        HTTP error bodies are never interpolated into log messages.
        """
        base = str(self._cfg("base_url", "") or "").rstrip("/")
        token = str(self._cfg("bot_token", "") or "")
        if not base or not token:
            raise RuntimeError("base_url/bot_token not configured")
        assert self._session is not None
        max_bytes = int(self._cfg("max_response_bytes", _DEFAULT_MAX_RESPONSE_BYTES)
                        or _DEFAULT_MAX_RESPONSE_BYTES)
        url = f"{base}{path}"
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        async with self._session.get(url, headers=headers) as resp:
            # Read the response body in bounded chunks.
            chunks: list[bytes] = []
            total = 0
            async for chunk, _ in resp.content.iter_chunks():
                total += len(chunk)
                if total > max_bytes:
                    raise RuntimeError(
                        "HTTP %d: response exceeds %d bytes" % (resp.status, max_bytes)
                    )
                chunks.append(chunk)
            body_bytes = b"".join(chunks)
            try:
                body = json.loads(body_bytes.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                if resp.status >= 400:
                    raise RuntimeError("HTTP %d (non-json error body)" % resp.status)
                raise RuntimeError("invalid JSON response")

            if resp.status == 429:
                retry = 5
                if isinstance(body, dict):
                    err = body.get("error") or {}
                    retry = int(err.get("retryAfterSec") or retry)
                self._backoff = min(
                    float(self._cfg("max_backoff_sec", 120) or 120),
                    max(float(retry), (self._backoff or 5.0) * 2),
                )
                raise RuntimeError("RATE_LIMITED retryAfter=%d" % retry)
            if resp.status >= 400:
                raise RuntimeError("HTTP %d" % resp.status)
            return body if isinstance(body, dict) else {}

    async def _poll_once(self):
        catalog = await self._request("/api/bot/catalog")
        machines = catalog.get("machines") or []
        hot = [
            m
            for m in machines
            if int(m.get("activeCount") or 0) > 0 or bool(m.get("hasPlaying"))
        ]
        self._round += 1
        warmup = int(self._cfg("warmup_rounds", 2) or 2)
        is_warmup = self._round <= warmup

        routing = parse_json_object(self._cfg("routing", "{}"))
        district_routing = parse_json_object(self._cfg("district_routing", "{}"))
        default_umo = str(self._cfg("default_umo", "") or "")
        cooldown_sec = float(self._cfg("cooldown_sec", 300) or 300)

        tasks = [
            self._handle_machine(
                m,
                is_warmup=is_warmup,
                routing=routing,
                district_routing=district_routing,
                default_umo=default_umo,
                cooldown_sec=cooldown_sec,
            )
            for m in hot
        ]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _handle_machine(
        self,
        machine: dict[str, Any],
        *,
        is_warmup: bool,
        routing: dict[str, str],
        district_routing: dict[str, str],
        default_umo: str,
        cooldown_sec: float,
    ):
        venue = str(machine.get("venueSlug") or "")
        mslug = str(machine.get("machineSlug") or "")
        if not venue or not mslug:
            return
        detail = await self._request(
            f"/api/bot/queues/{venue}/{mslug}"
        )
        cache_key = f"{venue}/{mslug}"
        head = detail.get("head")
        if not head or not detail.get("machineIdle"):
            self._last_head[cache_key] = ""
            return

        players = list(head.get("players") or [])
        head_key = build_head_key(mslug, players)
        qqs = [
            str(p.get("qq") or "").strip()
            for p in players
            if str(p.get("qq") or "").strip()
        ]
        if not qqs:
            self._skipped_no_qq += 1
            self._last_head[cache_key] = head_key
            return

        prev = self._last_head.get(cache_key)
        self._last_head[cache_key] = head_key
        if is_warmup:
            return
        if prev == head_key:
            return
        now = time.time()
        until = self._cooldown_until.get(head_key, 0)
        if until > now:
            return

        umo = resolve_umo(
            api_group_umo=detail.get("groupUmo") or machine.get("groupUmo"),
            venue_slug=venue,
            district_slug=machine.get("districtSlug") or None,
            routing=routing,
            district_routing=district_routing,
            default_umo=default_umo,
        )
        if not umo:
            logger.warning("no umo for venue=%s machine=%s", venue, mslug)
            return

        queue_text = build_queue_status_text(
            waiting_queue=list(detail.get("waitingQueue") or []),
            city_name=str(detail.get("cityName") or machine.get("cityName") or ""),
            district_name=str(
                detail.get("districtName") or machine.get("districtName") or ""
            ),
            venue_name=str(detail.get("venueName") or machine.get("venueName") or ""),
        )
        try:
            reminder_minutes = max(1, int(self._cfg("reminder_minutes", 3) or 3))
        except (TypeError, ValueError):
            reminder_minutes = 3
        # Keep the @ as an AstrBot component, rather than inserting an @ name
        # into Plain text. QQ can therefore render a clickable mention.
        chain_parts: list[Any] = [Plain(queue_text + "\n\n")]
        for qq in qqs:
            chain_parts.append(At(qq=int(qq) if qq.isdigit() else qq))
        chain_parts.append(Plain(build_call_reminder(reminder_minutes)))
        try:
            # AstrBot versions differ slightly; try MessageChain then raw list.
            try:
                chain = MessageChain(chain_parts)
            except Exception:
                chain = chain_parts  # type: ignore
            await self.context.send_message(umo, chain)
        except Exception:
            # Log de-identified; never emit UMO or QQ in failure logs.
            logger.warning(
                "send_message failed venue=%s machine=%s recipients=%d",
                venue, mslug, len(qqs),
            )
            # Do not set cooldown on failure so next round can retry.
            self._last_head[cache_key] = prev if prev is not None else ""
            return

        self._cooldown_until[head_key] = now + cooldown_sec
        # Success event is de-identified: count and venue/machine slugs only.
        logger.info(
            json.dumps(
                {
                    "event": "queue_notify",
                    "venueSlug": venue,
                    "machineSlug": mslug,
                    "recipients": len(qqs),
                },
                ensure_ascii=False,
            )
        )

    @filter.command("vw_queue_status")
    async def status_cmd(self, event: AstrMessageEvent):
        """查看插件轮询状态。"""
        yield event.plain_result(
            f"rounds={self._round} last_heads={len(self._last_head)} "
            f"skipped_no_qq={self._skipped_no_qq} backoff={self._backoff}"
        )
