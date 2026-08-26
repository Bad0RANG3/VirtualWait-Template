# -*- coding: utf-8 -*-
"""NoneBot2 插件：VirtualWait 机台空闲排队 @ 通知。

从 AstrBot 插件 `plugins/astrbot_plugin_virtualwait_queue` 移植，统一到 NoneBot2：
- 轮询 VirtualWait Web 的 Bot API（`/api/bot/catalog` + `/api/bot/queues/{venue}/{machine}`）；
- 机台空闲且存在队首时，向对应 QQ 群发送队列文本 + 真实 @ 提醒；
- 同一队首组合默认 5 分钟冷却，启动预热 2 轮，429/网络错误指数退避。

配置（.env，键名大写；NoneBot 读取为小写属性）：
    QUEUE_NOTIFY_ENABLED=true
    QUEUE_NOTIFY_BASE_URL=http://127.0.0.1:3000
    QUEUE_NOTIFY_BOT_TOKEN=<与 Web BOT_API_TOKEN 一致>
    QUEUE_NOTIFY_POLL_INTERVAL_SEC=8
    QUEUE_NOTIFY_COOLDOWN_SEC=300
    QUEUE_NOTIFY_REMINDER_MINUTES=3
    QUEUE_NOTIFY_WARMUP_ROUNDS=2
    QUEUE_NOTIFY_DEFAULT_GROUP=<兜底群号，纯数字>
    QUEUE_NOTIFY_ROUTING={"venue-slug":"123456"}
    QUEUE_NOTIFY_DISTRICT_ROUTING={}
    QUEUE_NOTIFY_STATS_INTERVAL_SEC=600
    QUEUE_NOTIFY_MAX_BACKOFF_SEC=120

路由优先级：API 返回的 groupUmo（场地管理台配置）-> QUEUE_NOTIFY_ROUTING[venueSlug]
-> QUEUE_NOTIFY_DISTRICT_ROUTING -> QUEUE_NOTIFY_DEFAULT_GROUP。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import httpx
from nonebot import get_bots, get_driver, on_command
from nonebot.adapters.onebot.v11 import Bot, Message, MessageSegment

from .helpers import (
    build_call_reminder,
    build_head_key,
    build_queue_status_text,
    normalize_group_id,
    parse_json_object,
    resolve_group_id,
    should_notify,
)

logger = logging.getLogger("virtualwait.bot.queue_notify")

_DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024

driver = get_driver()
_config = driver.config


def _cfg(key: str, default: Any = None) -> Any:
    """NoneBot 配置读取（.env 键转小写属性；未配置返回 default）。"""
    try:
        value = getattr(_config, key, None)
    except Exception:
        return default
    if value is None or value == "":
        return default
    return value


# ---------------------------------------------------------------------------
# 轮询状态
# ---------------------------------------------------------------------------

_task: asyncio.Task | None = None
_session: httpx.AsyncClient | None = None
_stop = asyncio.Event()
_last_head: dict[str, str] = {}
_cooldown_until: dict[str, float] = {}
_round = 0
_backoff = 0.0
_skipped_no_qq = 0
_last_stats_at = time.time()


async def _fetch(session: httpx.AsyncClient, path: str) -> dict[str, Any]:
    """请求 VirtualWait Bot API（有界读取，不把错误体写入日志）。"""
    base = str(_cfg("queue_notify_base_url", "") or "").rstrip("/")
    token = str(_cfg("queue_notify_bot_token", "") or "")
    if not base or not token:
        raise RuntimeError("queue_notify_base_url/bot_token not configured")
    max_bytes = int(_cfg("queue_notify_max_response_bytes", _DEFAULT_MAX_RESPONSE_BYTES) or _DEFAULT_MAX_RESPONSE_BYTES)
    url = f"{base}{path}"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    resp = await session.get(url, headers=headers)
    try:
        chunks: list[bytes] = []
        total = 0
        async for chunk in resp.aiter_bytes():
            total += len(chunk)
            if total > max_bytes:
                raise RuntimeError("response exceeds %d bytes" % max_bytes)
            chunks.append(chunk)
        body_bytes = b"".join(chunks)
        try:
            body = json.loads(body_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            if resp.status_code >= 400:
                raise RuntimeError("HTTP %d (non-json error body)" % resp.status_code)
            raise RuntimeError("invalid JSON response")
        if resp.status_code == 429:
            retry = 5
            if isinstance(body, dict):
                err = body.get("error") or {}
                retry = int(err.get("retryAfterSec") or retry)
            global _backoff
            _backoff = min(
                float(_cfg("queue_notify_max_backoff_sec", 120) or 120),
                max(float(retry), (_backoff or 5.0) * 2),
            )
            raise RuntimeError("RATE_LIMITED retryAfter=%d" % retry)
        if resp.status_code >= 400:
            raise RuntimeError("HTTP %d" % resp.status_code)
        return body if isinstance(body, dict) else {}
    finally:
        await resp.aclose()


def _maybe_log_stats() -> None:
    global _last_stats_at
    every = float(_cfg("queue_notify_stats_interval_sec", 600) or 600)
    now = time.time()
    if now - _last_stats_at >= every:
        logger.info(
            json.dumps(
                {
                    "event": "skipped_no_qq_stats",
                    "skipped_no_qq_count": _skipped_no_qq,
                    "ts": int(now),
                },
                ensure_ascii=False,
            )
        )
        _last_stats_at = now


async def _poll_once(session: httpx.AsyncClient) -> None:
    global _round
    catalog = await _fetch(session, "/api/bot/catalog")
    machines = catalog.get("machines") or []
    hot = [
        m
        for m in machines
        if int(m.get("activeCount") or 0) > 0 or bool(m.get("hasPlaying"))
    ]
    _round += 1
    warmup = int(_cfg("queue_notify_warmup_rounds", 2) or 2)
    is_warmup = _round <= warmup

    routing = parse_json_object(_cfg("queue_notify_routing", "{}"))
    district_routing = parse_json_object(_cfg("queue_notify_district_routing", "{}"))
    default_group = str(_cfg("queue_notify_default_group", "") or "")
    cooldown_sec = float(_cfg("queue_notify_cooldown_sec", 300) or 300)

    tasks = [
        _handle_machine(
            session,
            m,
            is_warmup=is_warmup,
            routing=routing,
            district_routing=district_routing,
            default_group=default_group,
            cooldown_sec=cooldown_sec,
        )
        for m in hot
    ]
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _handle_machine(
    session: httpx.AsyncClient,
    machine: dict[str, Any],
    *,
    is_warmup: bool,
    routing: dict[str, str],
    district_routing: dict[str, str],
    default_group: str,
    cooldown_sec: float,
) -> None:
    global _skipped_no_qq, _last_head, _cooldown_until
    venue = str(machine.get("venueSlug") or "")
    mslug = str(machine.get("machineSlug") or "")
    if not venue or not mslug:
        return
    detail = await _fetch(session, f"/api/bot/queues/{venue}/{mslug}")
    cache_key = f"{venue}/{mslug}"
    head = detail.get("head")
    if not head or not detail.get("machineIdle"):
        _last_head[cache_key] = ""
        return

    players = list(head.get("players") or [])
    head_key = build_head_key(mslug, players)
    qqs = [
        str(p.get("qq") or "").strip()
        for p in players
        if str(p.get("qq") or "").strip()
    ]
    if not qqs:
        _skipped_no_qq += 1
        _last_head[cache_key] = head_key
        return

    prev = _last_head.get(cache_key)
    if is_warmup:
        _last_head[cache_key] = head_key
        return
    now = time.time()
    # 跟随队首变化动态轮询：队首变化立即提醒；同一队首冷却期内不重复，
    # 冷却过后再次提醒（避免队列里的人全部上机后，最后轮到的人漏叫）。
    if not should_notify(
        prev_head_key=prev,
        head_key=head_key,
        now=now,
        cooldown_until=_cooldown_until,
        cooldown_sec=cooldown_sec,
    ):
        return

    group_id = resolve_group_id(
        api_group_umo=detail.get("groupUmo") or machine.get("groupUmo"),
        venue_slug=venue,
        district_slug=machine.get("districtSlug") or None,
        routing=routing,
        district_routing=district_routing,
        default_group=default_group,
    )
    if not group_id:
        logger.warning("no group for venue=%s machine=%s", venue, mslug)
        return

    queue_text = build_queue_status_text(
        waiting_queue=list(detail.get("waitingQueue") or []),
        city_name=str(detail.get("cityName") or machine.get("cityName") or ""),
        district_name=str(detail.get("districtName") or machine.get("districtName") or ""),
        venue_name=str(detail.get("venueName") or machine.get("venueName") or ""),
    )
    try:
        reminder_minutes = max(1, int(_cfg("queue_notify_reminder_minutes", 3) or 3))
    except (TypeError, ValueError):
        reminder_minutes = 3

    message = Message(queue_text + "\n\n")
    for qq in qqs:
        message += MessageSegment.at(user_id=int(qq) if qq.isdigit() else qq)
    message += Message(build_call_reminder(reminder_minutes))

    bots = get_bots()
    if not bots:
        logger.warning("no connected bot for venue=%s machine=%s", venue, mslug)
        _last_head[cache_key] = prev if prev is not None else ""
        return
    bot: Bot = next(iter(bots.values()))
    try:
        await bot.send_group_msg(group_id=int(group_id), message=message)
    except Exception:
        # 脱敏日志；不设置冷却，下轮重试
        logger.warning(
            "send_group_msg failed venue=%s machine=%s recipients=%d",
            venue, mslug, len(qqs),
        )
        _last_head[cache_key] = prev if prev is not None else ""
        return

    _last_head[cache_key] = head_key
    _cooldown_until[head_key] = now + cooldown_sec
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


async def _loop() -> None:
    global _backoff
    while not _stop.is_set():
        try:
            assert _session is not None
            await _poll_once(_session)
            _backoff = 0.0
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("poll cycle failed (backoff=%.1f)", _backoff)
            _backoff = min(
                float(_cfg("queue_notify_max_backoff_sec", 120) or 120),
                max(5.0, (_backoff or 5.0) * 2),
            )
        interval = float(_cfg("queue_notify_poll_interval_sec", 8) or 8)
        wait = interval + _backoff
        try:
            await asyncio.wait_for(_stop.wait(), timeout=wait)
        except asyncio.TimeoutError:
            pass
        _maybe_log_stats()


@driver.on_startup
async def _start_polling() -> None:
    global _task, _session
    if not _cfg("queue_notify_enabled", True):
        logger.info("queue_notify disabled (QUEUE_NOTIFY_ENABLED=false)")
        return
    _stop.clear()
    _session = httpx.AsyncClient(timeout=httpx.Timeout(20.0), trust_env=False)
    _task = asyncio.create_task(_loop())
    logger.info("queue_notify started")


@driver.on_shutdown
async def _stop_polling() -> None:
    global _task, _session
    _stop.set()
    if _task:
        _task.cancel()
        try:
            await _task
        except Exception:
            pass
        _task = None
    if _session:
        await _session.aclose()
        _session = None
    logger.info("queue_notify stopped")


status_cmd = on_command("vw_queue_status", aliases={"排队状态"}, priority=1, block=True)


@status_cmd.handle()
async def handle_status(bot: Bot) -> None:
    """查看轮询状态（仅私聊/管理员群可用；简单起见直接输出脱敏统计）。"""
    await status_cmd.finish(
        f"rounds={_round} last_heads={len(_last_head)} "
        f"skipped_no_qq={_skipped_no_qq} backoff={_backoff:.1f}"
    )