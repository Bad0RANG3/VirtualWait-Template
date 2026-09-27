# -*- coding: utf-8 -*-
"""NoneBot2 插件：maimai DX B50 完整成绩图（扫码查询）+ 写操作命令。

用法（QQ）:
    /help              查看全部命令说明
    /b50 <二维码>      完整版 B50 图（每次使用新码；查完自动登出）
    /fp <二维码> <数字>  发票：数字=发几倍票（2~5），该票库存为 0 才下发，免费，固定 1 张
    /giveitem ...      写道具 / 收藏品
    /score ...         传分（写成绩）

凭证纪律:
    - 每条命令都要 maimai 机台登录界面的新二维码：换 token -> 登录 -> 操作 -> 登出。
      一旦登录成功这个码就废了（哪怕后续没发写包），中途失败也要重新扫码。
    - 查询结束必登出（UserLogoutApi 回传登录时刻，服务器按此校验会话）。
    - 写命令是**真实写入账号**：只对你自己有权限的账号使用；流程被打断会触发
      isLogin=1（约 15 分钟的小黑屋），期间任何码都登录不上。

依赖:
    pip install nonebot2 nonebot-adapter-onebot
"""
import sys
from pathlib import Path

import httpx
from nonebot import on_command
from nonebot.adapters.onebot.v11 import (
    Bot,
    MessageEvent,
    MessageSegment,
)
from nonebot.exception import FinishedException
from nonebot.rule import to_me

# 保证能 import 共享 sdgb 包（packages/sdgb-client，NoneBot 运行时 cwd 不确定）
_PLUGIN_DIR = Path(__file__).resolve().parent       # services/bot/plugins
_REPO_ROOT = _PLUGIN_DIR.parent.parent.parent      # 仓库根
for _p in (str(_REPO_ROOT), str(_REPO_ROOT / "packages" / "sdgb-client")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from sdgb.b50 import load_music_db, render_oneshot  # noqa: E402
from sdgb.records import (  # noqa: E402
    exchange_qr,
    fetch_b50_payload_full,
    load_records_cache,
    login_with_token,
    logout_session,
    music_index,
    rating_to_payload_full,
)
from sdgb.sdgb import MaimaiClient  # noqa: E402

DB = load_music_db()

b50_cmd = on_command(
    "b50", aliases={"B50", "查b50", "查B50", "b50full", "完整b50", "b50完整", "查完整b50", "完整B50"},
    rule=to_me(), priority=5, block=True,
)
help_cmd = on_command(
    "help", aliases={"帮助", "菜单", "命令", "用法"},
    rule=to_me(), priority=1, block=True,
)
fp_cmd = on_command("fp", aliases={"发票", "发功能票", "FP"}, rule=to_me(), priority=5, block=True)
giveitem_cmd = on_command(
    "giveitem", aliases={"写道具", "发放道具", "give"},
    rule=to_me(), priority=5, block=True,
)
score_cmd = on_command(
    "score", aliases={"传分", "传成绩", "transfer"},
    rule=to_me(), priority=5, block=True,
)
# 单次写入道具数量上限（防止误操作一次性写入过多）
MAX_GIVE_ITEMS = 10

# 单次传分谱面数上限
MAX_TRANSFER_SCORES = 5

HELP_TEXT = """📋 功能列表
/b50 <二维码>  查询完整 B50 成绩图
/fp <二维码> 数字  开发票（数字=几倍票，2~5）
/giveitem <二维码> KIND:ID [KIND:ID ...]  写道具/收藏品（真实写操作）
/score <二维码> MUSICID:LEVEL:ACH[:COMBO[:SYNC]]  传分（写成绩，真实写操作）

itemKind：1姓名框 2称号 3头像 4礼物 5歌曲 6Master 7Re:Master
          8宴谱 9角色 10搭档 11背景板 12功能票
例：/giveitem <二维码> 3:250103 10:350001

传分 ACH 可写 1010000 / 101.0000 / 100.5%；COMBO=0无1FC2FC+3AP4AP+，SYNC=0~5
例：/score <二维码> 417:3:101.0000:4:4

⚠️ 写命令每次都换新码；登录成功后这个码就作废，流程中断会进约 15 分钟小黑屋"""

# 连续失败计数（按用户）：>=3 次提示找管理员，成功或提示后清零
_fail_counts: dict = {}


def _fail_text(user_id: str) -> str:
    """失败提示：中断/单次失败请重试；连续失败请找管理员。"""
    n = _fail_counts.get(user_id, 0) + 1
    if n >= 3:
        _fail_counts[user_id] = 0
        return "❌ 持续失败，请联系管理员"
    _fail_counts[user_id] = n
    return "❌ 失败，请重试"


@help_cmd.handle()
async def handle_help(bot: Bot, event: MessageEvent):
    await help_cmd.finish(HELP_TEXT)


@b50_cmd.handle()
async def handle_b50(bot: Bot, event: MessageEvent):
    """/b50 <二维码>：完整版 B50 图（每次使用新码；查完自动登出）。同账号 10 分钟内重复查询走本地缓存。"""
    parts = str(event.get_plaintext()).strip().split()
    qr = parts[1] if len(parts) > 1 else ""
    if len(qr) < 20:
        await b50_cmd.finish(
            "格式：/b50 <二维码字符串>\n"
            "（机台登录界面二维码解析出的字符串，每次查询都要新码；私聊发送更安全）"
        )
        return
    user_id = event.get_user_id()
    client = MaimaiClient()
    try:
        await b50_cmd.send("📋 任务已开始")
        async with httpx.AsyncClient() as http:  # 启用 TLS 证书校验
            uid, token, _preview = await exchange_qr(client, http, qr)
            # 同账号 10 分钟内缓存命中则零登录（避免反复登录触发小黑屋）
            cached = load_records_cache(uid)
            if cached and cached.get("rating") and cached.get("records"):
                payload = rating_to_payload_full(
                    cached["rating"], DB, music_index(cached["records"])
                )
            else:
                login_ts = await login_with_token(client, http, uid, token)
                try:
                    payload = await fetch_b50_payload_full(
                        client, http, uid, token, DB, use_cache=True
                    )
                finally:
                    # 查询结束必登出（UserLogoutApi 回传登录时刻，服务器按此校验会话）
                    try:
                        await logout_session(client, http, uid, timestamp=login_ts)
                    except Exception:  # noqa: BLE001
                        pass
        b35 = len(payload["calculatedEntries"]["b35"])
        b15 = len(payload["calculatedEntries"]["b15"])
        if b35 == 0 and b15 == 0:
            await b50_cmd.finish("❌ 未获取到 B50 数据（该账号无成绩或曲库缺名）。")
            return
        img = await render_oneshot(payload)
        _fail_counts.pop(user_id, None)
        await b50_cmd.finish(MessageSegment.image(img))
    except FinishedException:
        raise
    except Exception:  # noqa: BLE001
        await b50_cmd.finish(_fail_text(user_id))


@fp_cmd.handle()
async def handle_fp(bot: Bot, event: MessageEvent):
    """/fp <二维码> [Ticket ID 2~5]：发票（该票库存为 0 才下发，固定 1 张，免费；真实写操作）。"""
    parts = str(event.get_plaintext()).strip().split()
    qr = parts[1] if len(parts) > 1 else ""
    if len(qr) < 20:
        await fp_cmd.finish(
            "格式：/fp <二维码字符串> [Ticket ID 2~5]\n"
            "例：/fp SGWCMAID... 3\n"
            "（发票：该 Ticket 库存非 0 时拒绝下发；免费；固定 1 张；提交后需等待约 2 分钟）"
        )
        return
    charge_id = 3
    if len(parts) > 2 and parts[2].isdigit():
        charge_id = int(parts[2])
    if not 2 <= charge_id <= 5:
        await fp_cmd.finish("Ticket ID 需在 2~5 之间（3=3倍票；6 倍已废除）。")
        return

    from sdgb.write_ops import issue_ticket_with_qr

    user_id = event.get_user_id()
    try:
        await fp_cmd.send(
            "📋 开始任务：开发票…\n"
            "提交后需等待约 2 分钟，期间请勿重复提交或退出"
        )
        msg = await issue_ticket_with_qr(qr, charge_id=charge_id, progress=None)
        _fail_counts.pop(user_id, None)
        await fp_cmd.finish(msg)
    except FinishedException:
        raise
    except Exception:  # noqa: BLE001
        await fp_cmd.finish(_fail_text(user_id))


@giveitem_cmd.handle()
async def handle_giveitem(bot: Bot, event: MessageEvent):
    """/giveitem <二维码> KIND:ID [KIND:ID ...]：写道具/收藏品（真实写操作）。"""
    parts = str(event.get_plaintext()).strip().split()
    qr = parts[1] if len(parts) > 1 else ""
    specs = parts[2:]
    if len(qr) < 20:
        await giveitem_cmd.finish(
            "格式：/giveitem <二维码字符串> KIND:ID [KIND:ID ...]\n"
            "例：/giveitem SGWCMAID... 3:250103 10:350001\n"
            "（itemKind：1姓名框 2称号 3头像 4礼物 5歌曲 6Master 7Re:Master "
            "8宴谱 9角色 10搭档 11背景板 12功能票）"
        )
        return
    if not specs:
        await giveitem_cmd.finish("至少要给一个道具，例如：/giveitem <二维码> 3:250103")
        return
    if len(specs) > MAX_GIVE_ITEMS:
        await giveitem_cmd.finish(f"一次最多写 {MAX_GIVE_ITEMS} 条道具（本次 {len(specs)} 条）。")
        return
    from sdgb.write_ops import give_items_with_qr, parse_item_specs

    try:
        items = parse_item_specs(specs)
    except ValueError as e:
        await giveitem_cmd.finish(f"❌ 格式错误：{e}")
        return

    user_id = event.get_user_id()
    try:
        await giveitem_cmd.send(
            "📋 开始写入道具…（⚠️ 真实写操作，约需 2 分钟，期间请勿重复提交）"
        )
        msg = await give_items_with_qr(qr, items, music_db=DB)
        _fail_counts.pop(user_id, None)
        await giveitem_cmd.finish(msg)
    except FinishedException:
        raise
    except Exception:  # noqa: BLE001
        await giveitem_cmd.finish(_fail_text(user_id))


@score_cmd.handle()
async def handle_score(bot: Bot, event: MessageEvent):
    """/score <二维码> MUSICID:LEVEL:ACH[:COMBO[:SYNC]]：传分（真实写操作）。"""
    parts = str(event.get_plaintext()).strip().split()
    qr = parts[1] if len(parts) > 1 else ""
    specs = parts[2:]
    if len(qr) < 20 or not specs:
        await score_cmd.finish(
            "格式：/score <二维码字符串> MUSICID:LEVEL:ACH[:COMBO[:SYNC]]\n"
            "例：/score SGWCMAID... 417:3:101.0000:4:4\n"
            "（ACH：1010000 / 101.0000 / 100.5%；COMBO=0无1FC2FC+3AP4AP+；SYNC=0~5）"
        )
        return
    if len(specs) > MAX_TRANSFER_SCORES:
        await score_cmd.finish(f"一次最多传 {MAX_TRANSFER_SCORES} 个谱面（本次 {len(specs)} 个）。")
        return
    from sdgb.write_ops import parse_score_specs, transfer_score_with_qr

    try:
        parse_score_specs(specs)  # 先校验格式，避免登录后才报错
    except ValueError as e:
        await score_cmd.finish(f"❌ 格式错误：{e}")
        return

    user_id = event.get_user_id()
    try:
        await score_cmd.send("📋 开始传分…（⚠️ 真实写操作，约需 2 分钟，期间请勿重复提交）")
        msg = await transfer_score_with_qr(qr, specs, dx_max=True, music_db=DB)
        _fail_counts.pop(user_id, None)
        await score_cmd.finish(msg)
    except FinishedException:
        raise
    except Exception:  # noqa: BLE001
        await score_cmd.finish(_fail_text(user_id))

