# -*- coding: utf-8 -*-
"""NoneBot2 插件：群 MAID 二维码守护（撤回含凭证的群消息）。

maimai 机台登录二维码字符串（SGWCMAID...）临时携带 AiMe token，属于敏感凭证：
群里发出来可能被其他人拿去登录/刷分/发票。本插件在群消息文本里检测到 SGWCMAID
时调用 delete_msg 撤回；不处理图片（截图里的码撤不掉，只能靠用户别发）。

权限：仅当机器人在该群是群主/管理员时撤回（delete_msg 需要该权限）；
无权限或查不到身份就静默跳过，不影响 /b50 等命令在私聊里的使用。
"""
import re
import time
from typing import Dict, Tuple

from nonebot import on_message
from nonebot.adapters.onebot.v11 import Bot, GroupMessageEvent
from nonebot.log import logger

qr_guard = on_message(priority=1, block=False)

# maimai 机台登录二维码字符串前缀
_QR_PREFIX_RE = re.compile(r"SGWCMAID", re.I)

# 群管理身份缓存：group_id -> (role, 过期时间戳)，减少 get_group_member_info 调用
_ROLE_CACHE_TTL = 120.0
_role_cache: Dict[int, Tuple[str, float]] = {}


def _text_has_maid(text: str) -> bool:
    """文本是否包含 MAID 二维码凭证字符串（SGWCMAID...）。"""
    if not text:
        return False
    return bool(_QR_PREFIX_RE.search(text))


async def _is_group_admin(bot: Bot, group_id: int) -> bool:
    """机器人在群里是否为群主/管理员（结果缓存 _ROLE_CACHE_TTL 秒）。"""
    now = time.time()
    cached = _role_cache.get(group_id)
    if cached and cached[1] > now:
        return cached[0] in ("owner", "admin")
    try:
        info = await bot.get_group_member_info(
            group_id=group_id, user_id=int(bot.self_id)
        )
        role = str((info or {}).get("role", ""))
    except Exception:  # noqa: BLE001
        role = ""
    _role_cache[group_id] = (role, now + _ROLE_CACHE_TTL)
    return role in ("owner", "admin")


@qr_guard.handle()
async def handle_qr_guard(bot: Bot, event: GroupMessageEvent):
    # 机器人自己发的消息不处理（命令回执里可能引用格式示例）
    if str(event.user_id) == str(event.self_id):
        return

    if not _text_has_maid(event.get_plaintext()):
        return

    # 没有管理权限就不撤（delete_msg 需要群主/管理员权限）
    if not await _is_group_admin(bot, event.group_id):
        return

    # 撤回；失败（权限变化/超过两分钟等）记录原因，方便排查
    try:
        await bot.delete_msg(message_id=event.message_id)
        logger.info(f"[qr_guard] 已撤回 MAID 消息 group={event.group_id} user={event.user_id}")
    except Exception:  # noqa: BLE001
        logger.warning(
            f"[qr_guard] 撤回失败 group={event.group_id} user={event.user_id}",
            exc_info=True,
        )
