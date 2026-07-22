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


def build_queue_status_text(
    *,
    waiting_queue: list[dict[str, Any]],
    city_name: str,
    district_name: str,
    venue_name: str,
) -> str:
    """Build the plain-text portion before the real AstrBot @ component.

    ``waiting_queue`` is slot-based so a duo remains one queue position, matching
    the ordering shown by the Web queue board.
    """
    place = "".join(
        part.strip()
        for part in [city_name, district_name, venue_name]
        if str(part).strip()
    ) or "本机厅"
    lines = [f"{place}队伍情况：", ""]
    for index, slot in enumerate(waiting_queue, start=1):
        players = slot.get("players") if isinstance(slot, dict) else None
        names = [
            str(player.get("displayName") or "").strip() or "未命名玩家"
            for player in (players if isinstance(players, list) else [])
            if isinstance(player, dict)
        ]
        lines.append(f"{index}、{'、'.join(names) if names else '未命名玩家'}")
    if len(lines) == 2:
        lines.append("（当前暂无等待玩家）")
    return "\n".join(lines)


def build_call_reminder(reminder_minutes: int = 3) -> str:
    """Text sent immediately after AstrBot's real @ mention(s)."""
    return f"，请在{max(1, reminder_minutes)}分钟内上机游玩"


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
