# -*- coding: utf-8 -*-
"""queue_notify 判定逻辑测试：队首变化动态轮询，同一队首只 @ 一次。"""
from __future__ import annotations

import sys
from pathlib import Path

_BOT_DIR = Path(__file__).resolve().parents[1]
if str(_BOT_DIR) not in sys.path:
    sys.path.insert(0, str(_BOT_DIR))

from plugins.helpers import build_head_key, should_notify


def test_head_change_notifies_immediately() -> None:
    # 队首从 A 变成 B -> 立即提醒（即使 A 的冷却还在）
    assert should_notify(
        prev_head_key="machine-a_111",
        head_key="machine-a_222",
        now=100.0,
        cooldown_until={"machine-a_111": 500.0},
        cooldown_sec=300,
    ) is True


def test_same_head_within_cooldown_is_suppressed() -> None:
    # 同一队首且在冷却期内 -> 不重复提醒
    assert should_notify(
        prev_head_key="machine-a_111",
        head_key="machine-a_111",
        now=200.0,
        cooldown_until={"machine-a_111": 500.0},
        cooldown_sec=300,
    ) is False


def test_same_head_after_cooldown_still_suppressed() -> None:
    # 同一队首即使冷却已过也不重复提醒（只 @ 一次；3 分钟后 Web 会排到队尾）
    assert should_notify(
        prev_head_key="machine-a_111",
        head_key="machine-a_111",
        now=501.0,
        cooldown_until={"machine-a_111": 500.0},
        cooldown_sec=300,
    ) is False


def test_empty_previous_head_notifies() -> None:
    # 上次记录为空（例如上机后清空）-> 新队首直接提醒
    assert should_notify(
        prev_head_key="",
        head_key="machine-a_111",
        now=100.0,
        cooldown_until={},
        cooldown_sec=300,
    ) is True


def test_no_cooldown_entry_notifies() -> None:
    assert should_notify(
        prev_head_key=None,
        head_key="machine-a_111",
        now=100.0,
        cooldown_until={},
        cooldown_sec=300,
    ) is True


def test_head_key_builds_sorted_qq_combination() -> None:
    players = [
        {"qq": "222", "displayName": "B"},
        {"qq": "111", "displayName": "A"},
    ]
    assert build_head_key("machine-a", players) == "machine-a_111_222"