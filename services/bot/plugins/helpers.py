# -*- coding: utf-8 -*-
"""NoneBot 版队列通知辅助函数（从 AstrBot 插件 helpers.py 移植，UMO 语义改为群号）。"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger("virtualwait.bot.queue_notify")

_UMO_GROUP_RE = re.compile(r"(?:^|:)(\d{5,20})$")


def build_head_key(machine_slug: str, players: list[dict[str, Any]]) -> str:
    """同一队首组合的冷却键。QQ 为空时不会进入通知路径。"""
    qqs = sorted(
        {
            str(p.get("qq") or "").strip()
            for p in players
            if str(p.get("qq") or "").strip()
        }
    )
    return f"{machine_slug}_{'_'.join(qqs)}"


def parse_json_object(raw: Any) -> dict[str, str]:
    """Safely parse a routing/config value into a str->str dict."""
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}
    if not raw:
        return {}
    try:
        data = json.loads(str(raw))
    except (json.JSONDecodeError, TypeError, ValueError):
        logger.warning("invalid routing json (parse failed, raw omitted)")
        return {}
    if isinstance(data, dict):
        return {str(k): str(v) for k, v in data.items()}
    logger.warning("routing json is not a dict (type=%s)", type(data).__name__)
    return {}


def normalize_group_id(value: str | None) -> str | None:
    """把各种群标识归一化为纯数字群号。

    支持：
    - 纯数字群号 "123456"
    - AstrBot UMO 字符串 "aiocqhttp:GroupMessage:123456"
    - 任意以数字结尾的标识
    """
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        return text
    match = _UMO_GROUP_RE.search(text)
    if match:
        return match.group(1)
    return None


def resolve_group_id(
    *,
    api_group_umo: str | None,
    venue_slug: str,
    district_slug: str | None,
    routing: dict[str, str],
    district_routing: dict[str, str],
    default_group: str,
) -> str | None:
    """路由优先级：API groupUmo -> venue routing -> district routing -> default。"""
    if api_group_umo and str(api_group_umo).strip():
        group = normalize_group_id(str(api_group_umo).strip())
        if group:
            return group
    if venue_slug in routing and routing[venue_slug].strip():
        group = normalize_group_id(routing[venue_slug].strip())
        if group:
            return group
    if district_slug:
        key = f"district:{district_slug}"
        if key in district_routing and district_routing[key].strip():
            group = normalize_group_id(district_routing[key].strip())
            if group:
                return group
        if district_slug in district_routing and district_routing[district_slug].strip():
            group = normalize_group_id(district_routing[district_slug].strip())
            if group:
                return group
    if default_group and str(default_group).strip():
        return normalize_group_id(str(default_group).strip())
    return None


def build_queue_status_text(
    *,
    waiting_queue: list[dict[str, Any]],
    city_name: str,
    district_name: str,
    venue_name: str,
) -> str:
    """构建 @ 前的队列文本。``waiting_queue`` 按槽位计，双人占一位。"""
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
    """@ 之后的提醒文本。"""
    return f"，请在{max(1, reminder_minutes)}分钟内上机游玩"


def should_notify(
    *,
    prev_head_key: str | None,
    head_key: str,
    now: float,
    cooldown_until: dict[str, float],
    cooldown_sec: float,
) -> bool:
    """判断当前轮询是否应该发送提醒（跟随队首变化动态轮询）。

    规则：队首变化（prev != head_key）才提醒；同一队首**只提醒一次**，
    不再重复 @。轮询每 3 秒进行；队首 3 分钟未确认上机时 Web 会把
    其排到队尾，新队首（head_key 变化）会再次被提醒。
    """
    return prev_head_key != head_key
