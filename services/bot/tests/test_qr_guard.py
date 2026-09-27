# -*- coding: utf-8 -*-
"""qr_guard 插件：群内 MAID 二维码检测与「只有管理员才撤」判定。

CI 的 bot 步骤只装 pytest（不装 nonebot），所以这里用 importorskip 跳过。
"""
import asyncio
import time

import pytest

pytest.importorskip("nonebot")

from plugins.qr_guard import _is_group_admin, _text_has_maid  # noqa: E402


def test_text_has_maid_matches_prefix_case_insensitive():
    assert _text_has_maid("/b50 sgwcmaid260927AA...")
    assert _text_has_maid("帮我看看 SGWCMAID0123")
    assert not _text_has_maid("")
    assert not _text_has_maid("/help")
    assert not _text_has_maid("二维码是图片，文本里没有码串")


class _FakeBot:
    """假 OneBot：记录调用次数，可切换 role 或抛错。"""

    self_id = "10001"

    def __init__(self, role="owner", error=False):
        self.calls = 0
        self._role = role
        self._error = error

    async def get_group_member_info(self, group_id, user_id):
        self.calls += 1
        if self._error:
            raise RuntimeError("bot not in group")
        return {"role": self._role}


@pytest.fixture
def _clear_role_cache():
    from plugins import qr_guard

    qr_guard._role_cache.clear()
    yield
    qr_guard._role_cache.clear()


def test_group_admin_decision_and_cache(_clear_role_cache):
    from plugins import qr_guard
    from plugins.qr_guard import _ROLE_CACHE_TTL

    bot = _FakeBot(role="admin")
    assert asyncio.run(_is_group_admin(bot, 123)) is True
    assert asyncio.run(_is_group_admin(bot, 123)) is True
    assert bot.calls == 1                     # 第二次命中缓存

    member = _FakeBot(role="member")
    assert asyncio.run(_is_group_admin(member, 456)) is False

    broken = _FakeBot(error=True)
    assert asyncio.run(_is_group_admin(broken, 789)) is False
    # 查不到身份也进缓存（避免每条消息都打一次接口），但到期会重查
    assert qr_guard._role_cache[789][1] > time.time()
    assert _ROLE_CACHE_TTL > 0


def test_role_cache_expires(_clear_role_cache):
    from plugins import qr_guard

    bot = _FakeBot(role="owner")
    asyncio.run(_is_group_admin(bot, 999))
    qr_guard._role_cache[999] = ("member", time.time() - 1)   # 已过期的旧身份
    assert asyncio.run(_is_group_admin(bot, 999)) is True
    assert bot.calls == 2                                     # 过期后重新查过
