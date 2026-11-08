# -*- coding: utf-8 -*-
"""queue_notify 判定逻辑测试：队首键变化即提醒，同一队首只 @ 一次。"""
from __future__ import annotations

import sys
from pathlib import Path

_BOT_DIR = Path(__file__).resolve().parents[1]
if str(_BOT_DIR) not in sys.path:
    sys.path.insert(0, str(_BOT_DIR))

from plugins.helpers import build_head_key, should_notify


def test_head_change_notifies() -> None:
    # 队首从 A 变成 B -> 提醒
    assert should_notify(prev_head_key="machine-a_0_111", head_key="machine-a_0_222") is True


def test_same_head_is_suppressed() -> None:
    # 同一队首（同一轮叫号）-> 不重复提醒
    assert should_notify(prev_head_key="machine-a_0_111", head_key="machine-a_0_111") is False


def test_empty_previous_head_notifies() -> None:
    # 上次记录为空（例如机台重新空闲）-> 直接提醒
    assert should_notify(prev_head_key="", head_key="machine-a_0_111") is True


def test_no_previous_head_notifies() -> None:
    assert should_notify(prev_head_key=None, head_key="machine-a_0_111") is True


def test_missed_call_round_notifies_again() -> None:
    """单人队列超时回队尾后必须被重新 @（missCount 递增使键变化）。"""
    assert (
        should_notify(prev_head_key="machine-a_0_111", head_key="machine-a_1_111") is True
    )


def test_head_key_includes_sorted_qq_and_miss_count() -> None:
    players = [
        {"qq": "222", "displayName": "B"},
        {"qq": "111", "displayName": "A"},
    ]
    assert build_head_key("machine-a", players) == "machine-a_0_111_222"
    assert build_head_key("machine-a", players, 2) == "machine-a_2_111_222"


def test_head_key_ignores_players_without_qq() -> None:
    players = [{"qq": None, "displayName": "A"}, {"qq": "111", "displayName": "B"}]
    assert build_head_key("machine-a", players, 1) == "machine-a_1_111"
