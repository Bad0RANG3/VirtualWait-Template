# -*- coding: utf-8 -*-
"""写操作封装：发票（QQ 机器人命令与 CLI 共用）。

纪律：
- 每次写操作都必须用新二维码换新 token，不跨操作复用
- 发票必须两步组合（实机验证路径）：
  UpsertUserChargelogApi（购买记录，price=chargeId-1）-> 30s -> 单独上传 playlog ->
  30s -> UpsertUserAllApi（userChargeList 库存镜像 + 内嵌 playlog）；
  跳过 Chargelog 时服务器返回成功但不入账（静默忽略）
- 上传前按服务器时序要求"模拟游玩"等待（默认 60s，勿贪快）
- 所有流程先探测 isLogin（小黑屋）直接拒绝，不硬闯
- 登录后 finally 必登出；token 与登录 cookie 缺一不可，流程中断会强制 isLogin=1
- 回查验证默认关闭（verify=True 才做），信任写接口返回码
- 只查构建请求体需要的 7 个接口（全量查询会触发小黑屋）
"""
import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path

from .runtime import DATA_DIR
from typing import Awaitable, Callable, Optional

import httpx

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
TOKEN_CACHE = DATA_DIR / "token_cache.json"

Progress = Optional[Callable[[str], Awaitable[None]]]

# 构建 UpsertUserAllApi 请求体需要的只读接口（按此顺序查询）
API_ORDER = [
    "GetUserDataApi",
    "GetUserExtendApi",
    "GetUserOptionApi",
    "GetUserRatingApi",
    "GetUserChargeApi",
    "GetUserActivityApi",
    "GetUserMissionDataApi",
]


def build_music_detail(music_id: int, achievement: int) -> dict:
    """构造本局游玩记录（UserMusicDetail 条目，字段与 settings.musicData 一致）。"""
    return {
        "musicId": music_id,
        "level": 3,
        "playCount": 1,
        "achievement": achievement,
        "comboStatus": 4,
        "syncStatus": 4,
        "deluxscoreMax": 0,
        "scoreRank": 13,
        "extNum1": 0,
    }


async def _noop(_msg: str) -> None:
    pass


def _cache_token(qr: str, user_id: int, token: str) -> None:
    """记录最近一次写操作的 userID 与时间（排障用）；绝不落盘原始二维码或 token。

    qr/token 仅作为参数保持调用兼容，绝不写入磁盘。
    """
    try:
        TOKEN_CACHE.write_text(
            json.dumps({"userID": user_id,
                        "time": datetime.now().isoformat()},
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:  # noqa: BLE001
        logger.warning("写 token_cache 失败(可忽略)", exc_info=True)


def _check_write_response(resp: dict, api: str) -> None:
    """写接口响应校验：空响应=会话无效失败；returnCode 0/1/102=成功。"""
    if resp.get("_emptyResponse"):
        raise RuntimeError(
            f"{api} 返回空响应（登录会话无效或仍在小黑屋），未写入任何数据。"
        )
    rc = resp.get("returnCode")
    if rc is not None and rc not in (0, 1, 102):
        raise RuntimeError(f"{api} returnCode={rc}：{resp}")


def _charge_list_patcher(charge_id: int, stock: int = 1):
    """往 upsertUserAll.userChargeList 里把 charge_id 的 stock 置位（不存在则追加）。

    发票统一走 UpsertUserAllApi 携带 userChargeList，服务器按此 upsert 票据
    （实测主路径；单独 UpsertUserChargelogApi 经常不入账，已不再主用）。
    validDate = 当天 04:00 + 90 天。
    """
    import pytz
    from datetime import timedelta

    now = datetime.now(pytz.timezone("Asia/Shanghai"))
    purchase = now.strftime("%Y-%m-%d %H:%M:%S") + ".0"
    valid = (now.replace(hour=4, minute=0, second=0) + timedelta(days=90)
             ).strftime("%Y-%m-%d %H:%M:%S")

    def merge(d: dict) -> None:
        charges = d.get("userChargeList")
        if not isinstance(charges, list):
            charges = []
            d["userChargeList"] = charges
        found = False
        for c in charges:
            if isinstance(c, dict) and c.get("chargeId") == charge_id:
                c["stock"] = stock
                c["purchaseDate"] = purchase
                c["validDate"] = valid
                c["extNum1"] = 0
                found = True
        if not found:
            charges.append(
                {
                    "chargeId": charge_id,
                    "stock": stock,
                    "purchaseDate": purchase,
                    "validDate": valid,
                    "extNum1": 0,
                }
            )

    return merge


async def _ticket_upsert(
    client, h, login: dict, user_id: int, token: str,
    *, charge_id: int, stock: int, sleep_seconds: int, say,
) -> dict:
    """发票通用核心（实机验证路径，票据必须走两步组合）：

    登录后 -> 拉 7 个只读接口 -> 模拟游玩等待 ->
    UpsertUserChargelogApi（购买记录，price=chargeId-1；服务器只认这一步创建票据）-> 等 30s ->
    单独 UploadUserPlaylogListApi（本局 playlog）-> 等 30s ->
    UpsertUserAllApi（userChargeList 库存镜像 + 顶层内嵌 playlog）-> 完成。

    实测：跳过 Chargelog 时 UpsertUserAllApi 返回 0 但票据不入账（静默忽略）。
    前提：client 已完成 UserLoginApi（capture_cookie 捕获 JSESSIONID），
    login = {"loginResponse":..., "loginDateTime":...}。
    """
    from .payload import (
        UserAll_payload,
        build_charge_data,
        build_playlog,
        build_playlog_list_data,
    )
    from .settings import musicData as DEFAULT_MUSIC_DATA

    login_id = login["loginResponse"]["loginId"]
    login_date = login["loginResponse"]["lastLoginDate"]

    await say("登录成功，拉取账号数据…")
    info = await client.query(user_id, token, api_types=API_ORDER)
    # 查询失败会污染 UserAll_payload（version 等字段变成兜底值导致服务器 500），显式中止
    bad = [t for t in API_ORDER
           if isinstance(info.get(t), dict) and "error" in info[t]]
    if bad:
        raise RuntimeError(
            f"UpsertUserAllApi 前置查询失败（{', '.join(bad)}）："
            f"{[info[t]['error'] for t in bad][:2]}，已中止上传。"
        )
    general = [json.dumps(info[t]) for t in API_ORDER]

    if sleep_seconds > 0:
        await say(f"⏳ 模拟游玩 {sleep_seconds} 秒（服务器时序要求，请稍候）…")
        await asyncio.sleep(sleep_seconds)

    try:
        ud = (info.get("GetUserDataApi") or {}).get("userData") or {}
        player_rating = int(ud.get("playerRating") or 0)
    except Exception:  # noqa: BLE001
        player_rating = 0

    # 1) 购买记录（Chargelog：price=chargeId-1、playCount=1、playerRating、loginDateTime）
    charge_data = build_charge_data(
        user_id,
        charge_id=charge_id,
        stock=stock,
        play_count=1,
        player_rating=player_rating,
        login_date_time=login["loginDateTime"],
    )
    c_resp = await client.call_api(h, "UpsertUserChargelogApi", charge_data, user_id)
    _check_write_response(c_resp, "UpsertUserChargelogApi")
    await say("购买记录已写入，等 30 秒（服务器时序要求）…")
    await asyncio.sleep(30)

    # 2) 单独上传本局 playlog（UpsertUserAllApi 前置；跳过会不入账/500）
    playlog = build_playlog(
        playlog_id=login_id,
        music_id=int(DEFAULT_MUSIC_DATA.get("musicId", 417)),
        level=int(DEFAULT_MUSIC_DATA.get("level", 3)),
        achievement=int(DEFAULT_MUSIC_DATA.get("achievement", 1010000)),
        deluxscore=int(DEFAULT_MUSIC_DATA.get("deluxscoreMax", 2277)),
        score_rank=int(DEFAULT_MUSIC_DATA.get("scoreRank", 13)),
        player_rating=player_rating,
    )
    pl_resp = await client.call_api(
        h, "UploadUserPlaylogListApi",
        build_playlog_list_data(user_id, [playlog]), user_id,
    )
    _check_write_response(pl_resp, "UploadUserPlaylogListApi")
    await say("playlog 已上传，等 30 秒（服务器时序要求）…")
    await asyncio.sleep(30)

    # 3) 库存镜像 + 内嵌 playlog，一次 UpsertUserAllApi
    session_music = build_music_detail(
        int(DEFAULT_MUSIC_DATA.get("musicId", 417)),
        int(DEFAULT_MUSIC_DATA.get("achievement", 1010000)),
    )
    session_music["deluxscoreMax"] = int(DEFAULT_MUSIC_DATA.get("deluxscoreMax", 2277))
    request_data = UserAll_payload(
        login_id, login_date, session_music, general, user_id=user_id,
        login_date_time=login["loginDateTime"], user_playlog_list=[playlog],
    )
    _charge_list_patcher(charge_id, stock)(request_data["upsertUserAll"])

    resp = await client.call_api(h, "UpsertUserAllApi", request_data, user_id)
    _check_write_response(resp, "UpsertUserAllApi")
    return resp


async def issue_ticket_with_qr(
    qr: str,
    charge_id: int = 3,
    force: bool = False,
    sleep_seconds: int = 60,
    progress: Progress = None,
    verify: bool = False,
) -> str:
    """发票（发功能票语义，实机验证路径）：

      - 目标 Ticket 库存非 0 时默认拒绝（出于安全考虑，不会继续发票）
      - 固定只发 1 张（不允许指定票数）
      - 登录后强制等待 sleep_seconds（60s）再上传

    流程（两步组合，票据必须走 Chargelog 购买记录）：
    新二维码换 token -> GetUserChargeApi 查库存（非 0 拒绝） ->
    GetUserPreviewApi（playerRating + isLogin 小黑屋探测）-> UserLoginApi ->
    模拟游玩等待 -> UpsertUserChargelogApi（price=chargeId-1）-> 30s ->
    UploadUserPlaylogListApi -> 30s -> UpsertUserAllApi（userChargeList 库存镜像 +
    内嵌 playlog）-> （verify=True 才回查验证）-> 登出。

    跳过 Chargelog 时服务器返回成功但票据不入账（实测）。
    """
    import time

    from .chime import qr_api
    from .payload import (
        build_login_data,
        build_preview_data,
        build_user_data,
    )
    from .sdgb import MaimaiClient

    if not 1 <= charge_id <= 5:
        raise RuntimeError("Ticket ID 需在 1~5 之间（可用 2/3/4/5 倍，6 已废除）。")

    stock = 1  # 发票固定 1 张
    login_ts = None  # 登录成功后赋值；finally 里据此决定是否需要登出

    say = progress or _noop
    client = MaimaiClient()

    # 1) 新二维码换新 token（每次操作必须新换，不跨操作复用）
    qr_resp = qr_api(qr)
    user_id = qr_resp["userID"]
    token = qr_resp["token"]
    _cache_token(qr, user_id, token)

    try:
        async with httpx.AsyncClient(verify=False) as h:
            # 2) 查库存（免登录；GetUserChargeApi 仅需二维码 token）
            await say("查询当前票据…")
            before = await client.call_api(
                h, "GetUserChargeApi", build_user_data(user_id, token), user_id
            )
            before_stock = next(
                (c.get("stock") for c in (before.get("userChargeList") or [])
                 if c.get("chargeId") == charge_id), 0
            )
            if before_stock and not force:
                return (
                    f"❌ 当前 {charge_id} 号票库存为 {before_stock}（非 0）。"
                    "出于安全考虑，不会继续发票。\n"
                    "（确认票已用掉再发）"
                )

            # 3) GetUserPreviewApi：playerRating + isLogin 小黑屋探测
            preview = await client.call_api(
                h, "GetUserPreviewApi", build_preview_data(user_id, token), user_id
            )
            if preview.get("isLogin"):
                raise RuntimeError(
                    "isLogin=1（小黑屋）：15 分钟后再试，期间不要反复登录/操作。"
                )

            # 4) 登录（capture_cookie 捕获 JSESSIONID 会话 cookie，后续写操作自动携带——
            #    token 与 cookie 缺一不可，缺失会导致写操作被服务器静默忽略/会话失败）
            login_ts = int(time.time())
            login_resp = await client.call_api(
                h, "UserLoginApi",
                build_login_data(user_id, token, timestamp=login_ts), user_id,
                capture_cookie=True,
            )
            rc = login_resp.get("returnCode")
            if rc not in (1, 102):
                raise RuntimeError(
                    f"登录失败 returnCode={rc}（会话标识已隐藏）。"
                    "可能仍在小黑屋：等待 15 分钟以上且期间不要反复尝试。"
                )
            login = {
                "loginResponse": login_resp,
                "loginDateTime": login_ts,
                "previewResponse": preview,
                "token": token,
                "userId": user_id,
            }

            # 5) 两步组合上传：Chargelog 购买记录 + playlog + UpsertAll 库存镜像
            await say(f"下发 1 张 {charge_id} 号票（Chargelog + playlog + UpsertAll 两步组合）…")
            await _ticket_upsert(
                client, h, login, user_id, token,
                charge_id=charge_id, stock=stock,
                sleep_seconds=sleep_seconds, say=say,
            )

            # 6) 回查验证：默认关（信任返回码）；verify=True 才查 GetUserChargeApi
            if not verify:
                return f"✅ {charge_id}倍票已上传"
            after = await client.call_api(
                h, "GetUserChargeApi", build_user_data(user_id, token), user_id
            )
            after_stock = next(
                (c.get("stock") for c in (after.get("userChargeList") or [])
                 if c.get("chargeId") == charge_id), 0
            )
        if after_stock >= before_stock + stock:
            verdict = "✅ 验证通过：服务器已确认票据到账"
        else:
            verdict = (
                f"⚠️ 验证异常：预期 ≥{before_stock + stock}，实际 {after_stock}，建议机台复核"
            )
        return (
            f"✅ 发票完成：{charge_id} 号票 ×{after_stock}\n"
            f"（本次下发 1 张，原持有 {before_stock} 张）\n{verdict}"
        )
    finally:
        # 登出必须回传本次登录时刻（UserLogoutApi 按 loginDateTime 校验会话）。
        # 注意：finally 里不能 return（会吞掉 try 的返回值）。
        if login_ts is not None:
            try:
                out = await client.logout(user_id, timestamp=login_ts)
                logger.info("UserLogoutApi resp: %s", out)
                await say("✅ 账号已登出。")
            except Exception as e:  # noqa: BLE001
                logger.warning("登出失败: %s", e)
                await say(f"⚠️ 登出失败：{e}")
