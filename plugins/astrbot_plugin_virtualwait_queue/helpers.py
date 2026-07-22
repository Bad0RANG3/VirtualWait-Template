"""Pure helpers for VirtualWait queue notify (no AstrBot imports)."""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger("astrbot.plugin.virtualwait_queue")


def build_head_key(machine_slug: str, players: list[dict[str, Any]]) -> str:
    qqs = sorted(
        {
            str(p.get("qq") or "").strip()
            for p in players
            if str(p.get("qq") or "").strip()
        }
    )
    return f"{machine_slug}_{'_'.join(qqs)}"


def resolve_umo(
    *,
    api_group_umo: str | None,
    venue_slug: str,
    district_slug: str | None,
    routing: dict[str, str],
    district_routing: dict[str, str],
    default_umo: str,
) -> str | None:
    if api_group_umo and str(api_group_umo).strip():
        return str(api_group_umo).strip()
    if venue_slug in routing and routing[venue_slug].strip():
        return routing[venue_slug].strip()
    if district_slug:
        key = f"district:{district_slug}"
        if key in district_routing and district_routing[key].strip():
            return district_routing[key].strip()
        if district_slug in district_routing and district_routing[district_slug].strip():
            return district_routing[district_slug].strip()
    if default_umo and default_umo.strip():
        return default_umo.strip()
    return None


def build_notify_text(
    *,
    players: list[dict[str, Any]],
    district_name: str,
    venue_name: str,
    machine_name: str,
) -> str:
    place = "/".join([p for p in [district_name, venue_name] if p]) or venue_name or "本店"
    machine = machine_name or "机台"
    names = [str(p.get("displayName") or "玩家") for p in players]
    if len(players) > 1:
        teammates = "、".join(names[1:]) if len(names) > 1 else "队友"
        prefix = f"您与【{teammates}】"
    else:
        prefix = "您"
    return f"{prefix}排队的{place}的{machine}已空闲，请速去前台开卡上机！"


def parse_json_object(raw: Any) -> dict[str, str]:
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}
    if not raw:
        return {}
    try:
        data = json.loads(str(raw))
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}
    except Exception:
        logger.warning("invalid routing json: %s", raw)
    return {}
