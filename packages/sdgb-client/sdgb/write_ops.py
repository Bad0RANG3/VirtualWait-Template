# -*- coding: utf-8 -*-
"""写操作封装：发票 / 道具 / 传分（QQ 机器人命令与 CLI 共用）。

纪律（实机验证）：
- 每次写操作都必须用新二维码换新 token，不跨操作复用
- 所有流程先探测 isLogin（小黑屋）直接拒绝，不硬闯
- 登录后 finally 必登出；token 与登录 cookie 缺一不可，流程中断会强制 isLogin=1
- 只查构建请求体需要的接口（`API_ORDER`：7 个快照 + 1 个旅行伙伴槽位；
  全量查询会触发小黑屋）。槽位接口不能省：`charaSlot` 只在它里面返回，
  漏查会让整包落库把账号正在用的 5 个旅行伙伴写成默认值
- 上传前按服务器时序要求"模拟游玩"等待（默认 60s，勿贪快）
- 回查验证默认关闭（verify=True 才做），信任写接口返回码
- 这是真实写操作：只对有权限的账号使用

三条写路径共用一条机台实测时序（`_settle_then_upsert`）：
    登录 -> GetData×7 -> 模拟游玩等待 -> GetUserNewItemListApi（请求里带本局 playlog，
    服务器在这一步采纳本局数据）-> 30s -> UpsertUserAllApi（同一批 playlog + 目标列表）
跳过结算直接 Upsert 会被静默忽略（传分实测踩过这个坑；
UploadUserPlaylogListApi 单独上报的成绩服务器根本不入账）。
「本局」由 `build_session_pair` 伪装：原样重放账号自己 B50 里的一条已有记录，
判定按曲库音符数填满，因此既自洽（判定不能全 0）又不会写入新成绩。

- 发票（issue_ticket_with_qr）：额外需要 Chargelog 创建票据，走自己的三步组合
    UpsertUserChargelogApi（购买记录，price=chargeId-1）
      -> 30s -> UploadUserPlaylogListApi（本局 playlog）
      -> 30s -> UpsertUserAllApi（userChargeList 库存镜像 + 内嵌 playlog）
  跳过 Chargelog 时服务器返回成功但不入账（静默忽略）。
- 道具（give_items_with_qr）：整包快照里只回写目标 userItemList 行，
  isNewItemList 按行给标志（本次新增 "1"、镜像已有行 "0"）。
  收藏品（姓名框/称号/头像/搭档/背景板/功能票）与歌曲解锁共用 userItemList，
  只靠 itemKind 区分。尚未实机确认。
- 传分（transfer_score_with_qr）：额外写 userMusicDetailList 目标成绩，
  isNewMusicDetailList="1"，comboStatus/syncStatus 决定 FC/AP/同步徽标，
  deluxscoreMax 决定 DX 分（机台刻度 = 每颗音符 3 分）。已实机落地。
"""
import asyncio
import inspect
import json
import logging
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Awaitable, Callable, Optional

import httpx
import pytz

from .payload import (
    CHARA_SLOT_API_TYPE,
    ITEM_INDEX_STRIDE,
    USER_ITEM_KINDS,
)
from .runtime import DATA_DIR

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
TOKEN_CACHE = DATA_DIR / "token_cache.json"
SHANGHAI = pytz.timezone("Asia/Shanghai")

Progress = Optional[Callable[[str], Awaitable[None]]]

# 构建 UpsertUserAllApi 请求体需要的只读接口（按此顺序查询，顺序即 GeneralUserInfo 下标）
API_ORDER = [
    "GetUserDataApi",
    "GetUserExtendApi",
    "GetUserOptionApi",
    "GetUserRatingApi",
    "GetUserChargeApi",
    "GetUserActivityApi",
    "GetUserMissionDataApi",
    CHARA_SLOT_API_TYPE,
]

#: 单次传分最多写入的谱面数（防止误操作一次改写过多成绩）。
MAX_TRANSFER_SCORES = 5

#: achievement -> scoreRank 近似表（降序，第一个命中的阈值生效）。
#: 服务器会按 achievement 重算评级，此处仅供客户端镜像；可用 score_rank 覆盖。
#: 仓库默认曲目 achievement=1010000 对应 scoreRank=13，故最高档取 1010000。
_SCORE_RANK_STEPS = [
    (1010000, 13), (1005000, 12), (1000000, 11), (995000, 10),
    (990000, 9), (980000, 8), (970000, 7), (950000, 6),
    (900000, 5), (800000, 4), (700000, 3), (600000, 2),
    (500000, 1), (0, 0),
]

#: WriteResult.status：写请求已被服务器采纳（未回查）
WRITE_SUBMITTED = "SUBMITTED"
#: WriteResult.status：verify=True 且回查达到目标成绩
WRITE_CONFIRMED = "CONFIRMED"
#: WriteResult.status：verify=True 但回查未达目标（提交成功、结果存疑）
WRITE_UNCONFIRMED = "UNCONFIRMED"


class WriteResult(str):
    """写流程回执：给人看的中文文案，同时带结构化字段给程序化调用方。

    继承 str 让机器人/CLI 现有的 `print(result)` 和字符串比较保持不变；
    gateway 这类调用方读 `status` / `written_count`，不用解析 emoji 前缀。
    """

    __slots__ = ("status", "written_count")

    def __new__(cls, message: str, *, status: str, written_count: int) -> "WriteResult":
        obj = super().__new__(cls, message)
        obj.status = status
        obj.written_count = written_count
        return obj


async def _noop(_msg: str) -> None:
    pass


def _make_sayer(progress: Progress):
    """把调用方的进度回调包成 awaitable。

    NoneBot 那边传的是协程（`await cmd.send(...)`），CLI 传的是同步 `print` ——
    直接 await 同步回调会在第一个进度点抛 TypeError（实机踩过）。
    """
    if progress is None:
        return _noop

    async def say(msg: str) -> None:
        try:
            out = progress(msg)
            if inspect.isawaitable(out):
                await out
        except Exception as e:  # noqa: BLE001
            # 进度回调只是显示层（实机踩过 TypeError 与 Windows GBK 控制台打印 emoji
            # 抛 UnicodeEncodeError）——不能让它打断写入流程或登出收尾。
            logger.warning("progress 回调失败: %s", e)

    return say


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


def _exchange(qr: str) -> tuple:
    """机台二维码 -> (user_id, token)。失败只回显 userID，绝不回显 token。"""
    from .chime import qr_api

    qr = (qr or "").strip()
    if len(qr) < 20:
        raise RuntimeError("二维码字符串太短或为空（需要机台登录二维码解析出的字符串）。")
    resp = qr_api(qr)
    user_id, token = resp.get("userID"), resp.get("token")
    if not token or user_id == -1:
        raise RuntimeError(f"二维码换 token 失败（userID={resp.get('userID')}），请重新扫码。")
    return user_id, token


def _check_write_response(resp: dict, api: str) -> None:
    """写接口响应校验：空响应=会话无效失败；returnCode 0/1/102=成功。"""
    if resp.get("_emptyResponse"):
        raise RuntimeError(
            f"{api} 返回空响应（登录会话无效或仍在小黑屋），未写入任何数据。"
        )
    rc = resp.get("returnCode")
    if rc is not None and rc not in (0, 1, 102):
        raise RuntimeError(f"{api} returnCode={rc}：{resp}")


# ---------------------------------------------------------------
# 快照读取
# ---------------------------------------------------------------

def _snapshot_general(info: dict) -> list:
    """把 API_ORDER 的读回结果序列化成 UserAll_payload 的 GeneralUserInfo。

    任一接口查询失败都会污染整包（version 等字段落到兜底值 -> 服务器 500），
    所以直接中止而不是带伤上传。
    """
    bad = [t for t in API_ORDER
           if isinstance(info.get(t), dict) and "error" in info[t]]
    if bad:
        raise RuntimeError(
            f"UpsertUserAllApi 前置查询失败（{', '.join(bad)}）："
            f"{[info[t]['error'] for t in bad][:2]}，已中止上传。"
        )
    return [json.dumps(info[t]) for t in API_ORDER]


async def _query_snapshot(client, user_id: int, token: str, *, say, sleep_seconds: int):
    """登录态下拉整包快照，并按服务器时序要求先「模拟游玩」等待。

    只返回 info：GeneralUserInfo 由 `_snapshot_general(info)` 在每次拼包时现算 ——
    写流程会就地改 info 里的 userData（累计计数），
    提前序列化会让这些改动丢失。
    """
    await say("登录成功，拉取账号数据…")
    info = await client.query(user_id, token, api_types=API_ORDER)
    _snapshot_general(info)
    if sleep_seconds > 0:
        await say(f"⏳ 模拟游玩 {sleep_seconds} 秒（服务器时序要求，请稍候）…")
        await asyncio.sleep(sleep_seconds)
    return info


async def _preview_and_login(client, h, user_id: int, token: str) -> dict:
    """isLogin 探测 -> UserLoginApi（捕获会话 cookie）。返回 login dict。"""
    from .payload import build_login_data, build_preview_data

    preview = await client.call_api(
        h, "GetUserPreviewApi", build_preview_data(user_id, token), user_id
    )
    if preview.get("isLogin"):
        raise RuntimeError("isLogin=1（小黑屋）：15 分钟后再试，期间不要反复登录/操作。")

    login_ts = int(time.time())
    login_resp = await client.call_api(
        h, "UserLoginApi",
        build_login_data(user_id, token, timestamp=login_ts), user_id,
    )
    rc = login_resp.get("returnCode")
    if rc not in (1, 102):
        raise RuntimeError(
            f"登录失败 returnCode={rc}（loginId={login_resp.get('loginId')}）。"
            "可能仍在小黑屋：等待 15 分钟以上且期间不要反复尝试。"
        )
    return {
        "loginResponse": login_resp,
        "loginDateTime": login_ts,
        "previewResponse": preview,
        "token": token,
        "userId": user_id,
    }


async def _logout_quietly(client, user_id: int, login_ts, say) -> None:
    """登出失败只报告不抛：写操作已经做完，别让收尾错误掩盖结果。"""
    if login_ts is None:
        return
    try:
        out = await client.logout(user_id, timestamp=login_ts)
        logger.info("UserLogoutApi resp: %s", out)
        await say("✅ 账号已登出。")
    except Exception as e:  # noqa: BLE001
        logger.warning("登出失败: %s", e)
        await say(f"⚠️ 登出失败：{e}")


async def fetch_items(client, h, user_id: int, token: str, kinds, cookie=None) -> list:
    """按 itemKind 拉取 userItemList（每个 kind 内自动翻页）。"""
    from .payload import build_user_item_data

    out: list = []
    for kind in kinds:
        next_index = kind * ITEM_INDEX_STRIDE
        for _ in range(200):  # 防死循环
            resp = await client.call_api(
                h, "GetUserItemApi",
                build_user_item_data(user_id, token, item_kind=kind, next_index=next_index),
                user_id, cookie=cookie,
            )
            out.extend(resp.get("userItemList") or [])
            next_index = resp.get("nextIndex") or 0
            if next_index == 0:
                break
    return out


# ---------------------------------------------------------------
# 成绩 / 道具的入参解析
# ---------------------------------------------------------------

def derive_score_rank(achievement: int) -> int:
    """achievement(×10000) -> scoreRank 近似值（0=D … 13=SSS+）。"""
    for threshold, rank in _SCORE_RANK_STEPS:
        if achievement >= threshold:
            return rank
    return 0


def build_music_detail(
    music_id: int,
    achievement: int,
    *,
    level: int = 3,
    combo_status: int = 4,
    sync_status: int = 4,
    play_count: int = 1,
    deluxscore_max: int = 0,
    score_rank=None,
) -> dict:
    """构造一条 UserMusicDetail（userMusicDetailList 行）。

    默认值与旧发票流程一致（level=3 / AP+ / FS DX+ / rank13），
    传分时按目标分数覆盖 level / combo / sync / deluxscore。
    comboStatus: 0无 1FC 2FC+ 3AP 4AP+；syncStatus: 0无 1FS 2FS+ 3FSDX 4FSDX+ 5同步。
    """
    if score_rank is None:
        score_rank = derive_score_rank(achievement)
    return {
        "musicId": music_id,
        "level": level,
        "playCount": play_count,
        "achievement": achievement,
        "comboStatus": combo_status,
        "syncStatus": sync_status,
        "deluxscoreMax": deluxscore_max,
        "scoreRank": score_rank,
        "extNum1": 0,
    }


def parse_item_specs(specs) -> list:
    """解析 "KIND:ID[:数量]" -> [(kind, id, stock)]；非法格式/越界抛 ValueError。

    itemKind 必须落在 USER_ITEM_KINDS（1~12）。QQ 命令与 CLI 共用。
    """
    items = []
    for spec in specs or []:
        parts = str(spec).replace(",", ":").split(":")
        if not 2 <= len(parts) <= 3:
            raise ValueError(f"{spec!r} 应为 KIND:ID 或 KIND:ID:数量")
        try:
            kind, item_id = int(parts[0]), int(parts[1])
            stock = int(parts[2]) if len(parts) == 3 else 1
        except ValueError as e:
            raise ValueError(f"{spec!r} 必须是整数") from e
        if kind not in USER_ITEM_KINDS:
            raise ValueError(f"itemKind {kind} 不在 1~12")
        if stock < 1:
            raise ValueError(f"{spec!r} 数量必须 ≥1")
        items.append((kind, item_id, stock))
    return items


def normalize_items(items) -> list:
    """把多种写法的道具输入统一成 userItemList 行（去重）。

    接受：
      - dict：{"itemKind": 3, "itemId": 250103, "stock": 1, "isValid": True}
      - (itemKind, itemId[, stock]) 元组/列表
      - 以上两者的列表
    """
    from .payload import build_item_entry, merge_user_items

    if items is None:
        return []
    if isinstance(items, dict) or (
        isinstance(items, (tuple, list))
        and len(items) == 2
        and not isinstance(items[0], (tuple, list, dict))
    ):
        items = [items]

    rows = []
    for it in items:
        if isinstance(it, dict):
            kind = it.get("itemKind", it.get("item_kind"))
            item_id = it.get("itemId", it.get("item_id"))
            stock = it.get("stock", 1)
            is_valid = it.get("isValid", it.get("is_valid", True))
            rows.append(build_item_entry(kind, item_id, stock, is_valid))
        elif isinstance(it, (tuple, list)) and len(it) >= 2:
            rows.append(build_item_entry(it[0], it[1], it[2] if len(it) > 2 else 1))
        else:
            raise ValueError(f"无法识别的道具项：{it!r}（用 dict 或 (itemKind, itemId)）")
    return merge_user_items(rows)


def _parse_achievement(text: str) -> int:
    """解析 achievement：`1010000` 视为已 ×10000；`101.0000` / `100.5%` 视为百分比。"""
    t = str(text).strip()
    if not t:
        raise ValueError("achievement 不能为空")
    if t.endswith("%"):
        return int(round(float(t[:-1]) * 10000))
    if "." in t:
        return int(round(float(t) * 10000))
    return int(t)


def parse_score_specs(specs) -> list:
    """解析 "MUSICID:LEVEL:ACHIEVEMENT[:COMBO[:SYNC]]" -> [score dict]。

    ACHIEVEMENT 支持三种写法：`1010000`（已 ×10000）、`101.0000`、`100.5%`。
    COMBO=0~4（0无 1FC 2FC+ 3AP 4AP+），SYNC=0~5，缺省 0。
    """
    out = []
    for spec in specs or []:
        parts = str(spec).replace(",", ":").split(":")
        if not 3 <= len(parts) <= 5:
            raise ValueError(f"{spec!r} 应为 MUSICID:LEVEL:ACHIEVEMENT[:COMBO[:SYNC]]")
        try:
            music_id, level = int(parts[0]), int(parts[1])
            achievement = _parse_achievement(parts[2])
            combo = int(parts[3]) if len(parts) >= 4 and parts[3] != "" else 0
            sync = int(parts[4]) if len(parts) >= 5 and parts[4] != "" else 0
        except ValueError as e:
            raise ValueError(f"{spec!r} 含非法数字") from e
        if not 0 <= level <= 4:
            raise ValueError(f"{spec!r} level 需在 0~4（basic~remaster）")
        if not 0 <= achievement <= 1010000:
            raise ValueError(f"{spec!r} achievement 需在 0~1010000（即 0~101%）")
        if not 0 <= combo <= 4:
            raise ValueError(f"{spec!r} combo 需在 0~4")
        if not 0 <= sync <= 5:
            raise ValueError(f"{spec!r} sync 需在 0~5")
        out.append({
            "musicId": music_id, "level": level, "achievement": achievement,
            "comboStatus": combo, "syncStatus": sync,
        })
    return out


def _normalize_score_dict(s: dict) -> dict:
    def pick(*names, default=None):
        for n in names:
            if n in s and s[n] is not None:
                return s[n]
        return default

    music_id = pick("musicId", "music_id")
    achievement = pick("achievement")
    if music_id is None or achievement is None:
        raise ValueError(f"成绩项缺少 musicId / achievement：{s!r}")
    level = int(pick("level", default=3))
    achievement = int(achievement)
    combo = int(pick("comboStatus", "combo_status", default=0))
    sync = int(pick("syncStatus", "sync_status", default=0))
    if not 0 <= level <= 4:
        raise ValueError(f"成绩项 level 需在 0~4：{s!r}")
    if not 0 <= achievement <= 1010000:
        raise ValueError(f"成绩项 achievement 需在 0~1010000：{s!r}")
    if not 0 <= combo <= 4:
        raise ValueError(f"成绩项 comboStatus 需在 0~4：{s!r}")
    if not 0 <= sync <= 5:
        raise ValueError(f"成绩项 syncStatus 需在 0~5：{s!r}")
    return {
        "musicId": int(music_id),
        "level": level,
        "achievement": achievement,
        "comboStatus": combo,
        "syncStatus": sync,
        "deluxscoreMax": pick("deluxscoreMax", "deluxscore_max"),
        "scoreRank": pick("scoreRank", "score_rank"),
        "playCount": pick("playCount", "play_count", default=1),
    }


def normalize_scores(scores) -> list:
    """把字符串 spec / dict / 它们的列表统一成成绩 dict（按 (musicId, level) 去重）。"""
    if scores is None:
        return []
    if isinstance(scores, (str, dict)):
        scores = [scores]
    out: list = []
    for s in scores:
        if isinstance(s, str):
            out.extend(parse_score_specs([s]))
        elif isinstance(s, dict):
            out.append(_normalize_score_dict(s))
        else:
            raise ValueError(f"无法识别的成绩项：{s!r}（用字符串或 dict）")
    return list({(s["musicId"], s["level"]): s for s in out}.values())


# ---------------------------------------------------------------
# 「本局」伪装：非成绩类写操作也要结算一局，且不能改动成绩
# ---------------------------------------------------------------

def _rating_rows(snapshot: dict) -> list:
    """账号 B50 行（GetUserRatingApi 的 ratingList + newRatingList）。

    每行只有 {musicId, level, romVersion, achievement}，徽标要另查本地成绩缓存。
    """
    rating = (snapshot.get("GetUserRatingApi") or {}).get("userRating") or {}
    rows: list = []
    for key in ("ratingList", "newRatingList"):
        rows.extend(r for r in (rating.get(key) or []) if isinstance(r, dict))
    return rows


def load_music_db() -> dict:
    """曲库（只为补音符数 / DX 上限用），加载失败返回空表而不是中断写操作。"""
    from .b50 import load_music_db as _load

    try:
        return _load()
    except Exception as e:  # noqa: BLE001
        logger.warning("曲库加载失败，本局伪装将不带音符判定：%s", e)
        return {}


def cached_music_index(user_id: int) -> dict:
    """本地成绩缓存里的 {(musicId, level): 成绩行}（无网络成本）。

    镜像 comboStatus/syncStatus/deluxscoreMax 用，避免把账号已有徽标写成 0。
    """
    from .records import load_records_cache, music_index

    cached = load_records_cache(user_id, allow_stale=True) or {}
    records = cached.get("records") or []
    return music_index(records) if records else {}


def _session_row(src: dict, notes, mirror: dict = None) -> dict:
    """把一行「已有记录」镜像成 userMusicDetailList 行（判定/DX 与音符数自洽）。"""
    from .payload import dx_score_max

    try:
        music_id = int(src["musicId"])
        level = int(src.get("level") or 0)
        achievement = int(src.get("achievement") or 0)
    except (KeyError, TypeError, ValueError):
        return None
    mirror = mirror or {}
    if achievement <= 0:
        return None

    def field(name, default=0):
        return int(mirror.get(name) or src.get(name) or default)

    return build_music_detail(
        music_id, achievement,
        level=level,
        combo_status=field("comboStatus"),
        sync_status=field("syncStatus"),
        play_count=field("playCount", 1),
        deluxscore_max=field("deluxscoreMax") or (dx_score_max(notes) if notes else 0),
        score_rank=field("scoreRank") or None,
    )


def pick_session_music_list(
    snapshot: dict,
    music_db,
    *,
    limit: int,
    fallback: dict,
    known: dict = None,
) -> list:
    """挑 `limit` 条互不重复的谱面用来伪装本局（优先账号 B50 里已有的记录）。"""
    rows = [*_rating_rows(snapshot), fallback]
    from .records import chart_notes

    out: list = []
    seen: set = set()
    for index, src in enumerate(rows):
        if len(out) >= limit:
            break
        notes = None
        try:
            music_id, level = int(src["musicId"]), int(src.get("level") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        if music_db:
            notes = chart_notes(music_db, music_id, level)
            if not notes and index < len(rows) - 1:
                continue
        row = _session_row(src, notes, (known or {}).get((music_id, level)))
        if row is None or (row["musicId"], row["level"]) in seen:
            continue
        seen.add((row["musicId"], row["level"]))
        out.append(row)
    if not out:
        raise RuntimeError(
            "挑不出可伪装的「本局」谱面：账号没有 B50 记录，"
            "且配置 musicData 不完整（需 musicId / level / achievement）。"
        )
    return out


def pick_session_music(
    snapshot: dict,
    music_db,
    *,
    fallback: dict,
    known: dict = None,
) -> dict:
    """挑一局来伪装的谱面：原样重放账号 B50 里已有的记录。

    服务器只在结算本局后采纳整包数据，所以写道具等非成绩写操作也必须伪打一局；
    直接塞配置里的默认曲目（417 Master 101%）会真的写进成绩表并污染 B50，
    重放已有记录时 achievement 不变 -> 不产生新纪录、不改评分。
    曲库里有音符数才敢选（判定必须与 achievement 自洽），否则一路挑到末项，
    退回配置曲目保持旧行为。
    """
    return pick_session_music_list(
        snapshot, music_db, limit=1, fallback=fallback, known=known,
    )[0]


def build_session_plays(
    snapshot: dict,
    music_db,
    *,
    count: int,
    login_id: int,
    player_rating: int,
    fallback: dict,
    known: dict = None,
) -> list:
    """造 `count` 局「无害」游玩：[(userMusicDetailList 行, 自洽的 playlog), ...]。"""
    from .payload import build_playlog
    from .records import chart_notes

    pairs = []
    for i, detail in enumerate(pick_session_music_list(
        snapshot, music_db, limit=count, fallback=fallback, known=known,
    )):
        notes = (
            chart_notes(music_db, detail["musicId"], detail["level"]) if music_db else None
        )
        playlog = build_playlog(
            playlog_id=login_id,
            music_id=detail["musicId"],
            level=detail["level"],
            achievement=detail["achievement"],
            deluxscore=detail["deluxscoreMax"],
            score_rank=detail["scoreRank"],
            player_rating=player_rating,
            notes=notes,
            comboStatus=detail["comboStatus"],
            syncStatus=detail["syncStatus"],
            orderId=i,
            trackNo=i + 1,
        )
        pairs.append((detail, playlog))
    return pairs


def build_session_pair(
    snapshot: dict,
    music_db,
    *,
    login_id: int,
    player_rating: int,
    fallback: dict,
    known: dict = None,
) -> tuple:
    """造一局「无害」游玩：(userMusicDetailList 行, 与之自洽的 playlog)。"""
    return build_session_plays(
        snapshot, music_db, count=1, login_id=login_id,
        player_rating=player_rating, fallback=fallback, known=known,
    )[0]


# userData 里按难度累加的字段名（下标 = level 0~4）。
_LEVEL_STAT_KEYS = (
    ("totalBasicAchievement", "totalBasicDeluxscore"),
    ("totalAdvancedAchievement", "totalAdvancedDeluxscore"),
    ("totalExpertAchievement", "totalExpertDeluxscore"),
    ("totalMasterAchievement", "totalMasterDeluxscore"),
    ("totalReMasterAchievement", "totalReMasterDeluxscore"),
)


def bump_play_totals(user_data: dict, details: list) -> dict:
    """把本局成绩累加进 userData 的累计字段（机台实测行为）。

    机台包对照：结算包 -> Upsert 包之间，playCount/currentPlayCount +1、
    lastPlayCredit=1、totalAchievement += 本局 achievement、
    totalMasterAchievement/totalMasterDeluxscore 等同理（level 决定加哪一档）。
    """
    user_data["playCount"] = int(user_data.get("playCount") or 0) + len(details)
    user_data["currentPlayCount"] = int(user_data.get("currentPlayCount") or 0) + len(details)
    user_data["lastPlayCredit"] = 1
    for key, delta in (
        ("totalAchievement", sum(int(d.get("achievement") or 0) for d in details)),
        ("totalDeluxscore", sum(int(d.get("deluxscoreMax") or 0) for d in details)),
    ):
        user_data[key] = int(user_data.get(key) or 0) + delta
    for d in details:
        level = int(d.get("level") or 0)
        if not 0 <= level < len(_LEVEL_STAT_KEYS):
            continue
        ach_key, dx_key = _LEVEL_STAT_KEYS[level]
        user_data[ach_key] = int(user_data.get(ach_key) or 0) + int(d.get("achievement") or 0)
        user_data[dx_key] = int(user_data.get(dx_key) or 0) + int(d.get("deluxscoreMax") or 0)
    return user_data


async def _settle_then_upsert(
    client, h, user_id: int, request_data: dict, playlogs: list,
    *, say=_noop, settle_wait: int = 30,
) -> dict:
    """机台实测写时序：先随 GetUserNewItemListApi 结算本局，30 秒后整包落库。

    成绩/道具都是在这一步被服务器采纳的；跳过结算直接 UpsertUserAllApi
    会返回成功但静默不生效。结算包用「本局之前」的 userData 计数，
    落库前再把本局累加进去（机台在这 20~30 秒里做的正是这件事）。
    """
    from .payload import build_new_item_list_data

    inner = request_data["upsertUserAll"]
    user_data_row = inner["userData"][0]
    settled = await client.call_api(
        h, "GetUserNewItemListApi",
        build_new_item_list_data(user_id, [dict(user_data_row)], playlogs),
        user_id,
    )
    _check_write_response(settled, "GetUserNewItemListApi")
    dropped = len(settled.get("userItemList") or [])
    bump_play_totals(user_data_row, inner.get("userMusicDetailList") or [])
    await say(f"本局已结算（服务器掉落 {dropped} 件），等 {settle_wait} 秒后落库…")
    await asyncio.sleep(settle_wait)
    resp = await client.call_api(h, "UpsertUserAllApi", request_data, user_id)
    _check_write_response(resp, "UpsertUserAllApi")
    return resp


def _charge_list_patcher(charge_id: int, stock: int = 1):
    """往 upsertUserAll.userChargeList 里把 charge_id 的 stock 置位（不存在则追加）。

    发票统一走 UpsertUserAllApi 携带 userChargeList，服务器按此 upsert 票据
    （实测主路径；单独 UpsertUserChargelogApi 经常不入账，已不再主用）。
    validDate = 当天 04:00 + 90 天。
    """
    now = datetime.now(SHANGHAI)
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
                c.update(stock=stock, purchaseDate=purchase, validDate=valid, extNum1=0)
                found = True
        if not found:
            charges.append({
                "chargeId": charge_id, "stock": stock,
                "purchaseDate": purchase, "validDate": valid, "extNum1": 0,
            })

    return merge


# ---------------------------------------------------------------
# 发票
# ---------------------------------------------------------------

async def _ticket_upsert(
    client, h, login: dict, user_id: int, token: str,
    *, charge_id: int, stock: int, sleep_seconds: int, say,
) -> dict:
    """发票通用核心（实机验证路径，票据必须走两步组合）：

    登录后 -> 拉整包快照 -> 模拟游玩等待 ->
    UpsertUserChargelogApi（购买记录，price=chargeId-1；服务器只认这一步创建票据）-> 等 30s ->
    单独 UploadUserPlaylogListApi（本局 playlog）-> 等 30s ->
    UpsertUserAllApi（userChargeList 库存镜像 + 顶层内嵌 playlog）-> 完成。

    实测：跳过 Chargelog 时 UpsertUserAllApi 返回 0 但票据不入账（静默忽略）。
    前提：client 已完成 UserLoginApi（JSESSIONID 由 call_api 自动收集），
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

    info = await _query_snapshot(
        client, user_id, token, say=say, sleep_seconds=sleep_seconds
    )

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
        login_id, login_date, session_music, _snapshot_general(info), user_id=user_id,
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
    from .payload import build_user_data
    from .sdgb import MaimaiClient

    if not 1 <= charge_id <= 5:
        raise RuntimeError("Ticket ID 需在 1~5 之间（可用 2/3/4/5 倍，6 已废除）。")

    stock = 1  # 发票固定 1 张
    login_ts = None  # 登录成功后赋值；finally 里据此决定是否需要登出

    say = _make_sayer(progress)
    client = MaimaiClient()

    # 1) 新二维码换新 token（每次操作必须新换，不跨操作复用）
    user_id, token = _exchange(qr)
    _cache_token(qr, user_id, token)

    try:
        async with httpx.AsyncClient(verify=True) as h:
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

            # 3) GetUserPreviewApi（isLogin 小黑屋探测）-> 4) UserLoginApi
            login = await _preview_and_login(client, h, user_id, token)
            login_ts = login["loginDateTime"]

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
        await _logout_quietly(client, user_id, login_ts, say)


# ---------------------------------------------------------------
# 道具 / 收藏品
# ---------------------------------------------------------------

async def give_items_with_qr(
    qr: str,
    items,
    *,
    sleep_seconds: int = 60,
    merge_existing: bool = False,
    verify: bool = False,
    music_db=None,
    progress: Progress = None,
) -> str:
    """给账号写入道具 / 收藏品 / 歌曲解锁（结算 + 整包快照路径）。

    items 见 normalize_items：dict、`(itemKind, itemId)` 或它们的列表。

    - 与传分同一条时序：本局先随 GetUserNewItemListApi 结算，30 秒后整包落库；
      本局伪造成账号自己已有的一条 B50 记录，因此不会顺手改成绩。
    - merge_existing=True 时先用 GetUserItemApi 读回现有道具并与 items 合并
      （更贴近「完整快照」，但要多拉若干页）；读回的既有行按 "0" 标志镜像回去。
    - verify=True 时写后回查确认。
    - 这是真实写操作：只对你有权限的账号使用。
    """
    from .payload import UserAll_payload, merge_user_items
    from .sdgb import MaimaiClient
    from .settings import musicData as DEFAULT_MUSIC_DATA

    rows = normalize_items(items)
    if not rows:
        raise RuntimeError("没有要写入的道具（items 为空）。")
    new_keys = {(r["itemKind"], r["itemId"]) for r in rows}

    login_ts = None
    say = _make_sayer(progress)
    client = MaimaiClient()
    if music_db is None:
        music_db = load_music_db()

    user_id, token = _exchange(qr)
    _cache_token(qr, user_id, token)

    try:
        async with httpx.AsyncClient(verify=True) as h:
            login = await _preview_and_login(client, h, user_id, token)
            login_ts = login["loginDateTime"]
            login_id = login["loginResponse"]["loginId"]
            login_date = login["loginResponse"]["lastLoginDate"]

            info = await _query_snapshot(
                client, user_id, token, say=say, sleep_seconds=sleep_seconds
            )

            kinds = sorted({r["itemKind"] for r in rows})
            if merge_existing:
                await say("读回现有道具并合并…")
                existing = await fetch_items(client, h, user_id, token, kinds)
                rows = merge_user_items(existing, rows)
            item_flags = "".join(
                "1" if (r.get("itemKind"), r.get("itemId")) in new_keys else "0" for r in rows
            )

            ud = (info.get("GetUserDataApi") or {}).get("userData") or {}
            player_rating = int(ud.get("playerRating") or 0)
            session_music, playlog = build_session_pair(
                info, music_db,
                login_id=login_id, player_rating=player_rating,
                fallback=DEFAULT_MUSIC_DATA, known=cached_music_index(user_id),
            )

            request_data = UserAll_payload(
                login_id, login_date, session_music, _snapshot_general(info), user_id=user_id,
                login_date_time=login["loginDateTime"],
                user_playlog_list=[playlog],
                user_item_list=rows,
                is_new_item_list=item_flags,
            )

            await say(
                f"结算本局并写入 {len(rows)} 条道具（isNewItemList={item_flags}）…"
            )
            await _settle_then_upsert(client, h, user_id, request_data, [playlog], say=say)

            if not verify:
                return (
                    f"✅ 已写入 {len(rows)} 条道具（itemKind={kinds}，"
                    f"本局伪装 {session_music['musicId']}/{session_music['level']}）"
                )

            await say("回查确认…")
            found = await fetch_items(client, h, user_id, token, kinds)
        have = {(r.get("itemKind"), r.get("itemId")) for r in found}
        missing = [r for r in rows if (r["itemKind"], r["itemId"]) not in have]
        if missing:
            preview = [(r["itemKind"], r["itemId"]) for r in missing[:5]]
            return f"⚠️ 写入已提交，但回查缺失 {len(missing)} 条：{preview}"
        return f"✅ 已写入并回查确认 {len(rows)} 条道具（itemKind={kinds}）"
    finally:
        await _logout_quietly(client, user_id, login_ts, say)


# ---------------------------------------------------------------
# 传分（写成绩：userMusicDetailList + playlog）
# ---------------------------------------------------------------

def _resolve_deluxscore(spec: dict, music_db) -> int:
    """deluxscoreMax：显式指定优先；否则按曲库音符数算 DX 上限（无曲库则 0）。"""
    from .payload import dx_score_max
    from .records import chart_notes

    explicit = spec.get("deluxscoreMax")
    if explicit is not None:
        return int(explicit)
    if not music_db:
        return 0
    notes = chart_notes(music_db, spec["musicId"], spec["level"])
    return dx_score_max(notes) if notes else 0


async def transfer_score_with_qr(
    qr: str,
    scores,
    *,
    sleep_seconds: int = 60,
    verify: bool = False,
    dx_max: bool = False,
    music_db=None,
    progress: Progress = None,
) -> str:
    """传分：把指定谱面的成绩写入账号（userMusicDetailList + playlog 整包快照）。

    流程（照机台实测时序：先结算本局，再整包落库）：
        新码换 token -> isLogin 探测 -> 登录 -> 整包快照 -> 模拟游玩等待
        -> GetUserNewItemListApi（带本局 playlog，成绩在这一步被服务器采纳）-> 30s
        -> UpsertUserAllApi（同一批 playlog + userMusicDetailList + isNewMusicDetailList="1"）
        -> 回查 -> 登出

    scores: "MUSICID:LEVEL:ACHIEVEMENT[:COMBO[:SYNC]]" 或 dict，或它们的列表。
    dx_max=True 时用曲库音符数把 deluxscoreMax 补成该谱面 DX 上限。
    这是真实写操作：只对你有权限的账号使用。
    """
    from .payload import UserAll_payload, build_playlog
    from .records import chart_notes, fetch_user_music, music_index
    from .sdgb import MaimaiClient

    specs = normalize_scores(scores)
    if not specs:
        raise RuntimeError("没有要写入的成绩（scores 为空）。")
    if len(specs) > MAX_TRANSFER_SCORES:
        raise RuntimeError(f"单次最多传 {MAX_TRANSFER_SCORES} 个谱面（本次 {len(specs)} 个）。")

    if music_db is None:
        music_db = load_music_db()

    login_ts = None
    say = _make_sayer(progress)
    client = MaimaiClient()

    user_id, token = _exchange(qr)
    _cache_token(qr, user_id, token)

    try:
        async with httpx.AsyncClient(verify=True) as h:
            login = await _preview_and_login(client, h, user_id, token)
            login_ts = login["loginDateTime"]
            login_id = login["loginResponse"]["loginId"]
            login_date = login["loginResponse"]["lastLoginDate"]

            info = await _query_snapshot(
                client, user_id, token, say=say, sleep_seconds=sleep_seconds
            )

            ud = (info.get("GetUserDataApi") or {}).get("userData") or {}
            player_rating = int(ud.get("playerRating") or 0)

            details: list = []
            playlogs: list = []
            for i, spec in enumerate(specs):
                delux = _resolve_deluxscore(spec, music_db) if dx_max else \
                    int(spec.get("deluxscoreMax") or 0)
                notes = (
                    chart_notes(music_db, spec["musicId"], spec["level"])
                    if music_db else None
                )
                detail = build_music_detail(
                    spec["musicId"], spec["achievement"],
                    level=spec["level"],
                    combo_status=spec["comboStatus"],
                    sync_status=spec["syncStatus"],
                    play_count=int(spec.get("playCount") or 1),
                    deluxscore_max=delux,
                    score_rank=spec.get("scoreRank"),
                )
                details.append(detail)
                playlogs.append(build_playlog(
                    playlog_id=login_id,
                    music_id=detail["musicId"],
                    level=detail["level"],
                    achievement=detail["achievement"],
                    deluxscore=detail["deluxscoreMax"],
                    score_rank=detail["scoreRank"],
                    player_rating=player_rating,
                    notes=notes,
                    comboStatus=detail["comboStatus"],
                    syncStatus=detail["syncStatus"],
                    isAchieveNewRecord=True,
                    isDeluxscoreNewRecord=True,
                    orderId=i,
                    trackNo=i + 1,
                ))

            # 机台结算：本局 playlog 随 GetUserNewItemListApi 上报（实测成绩在这一步入账）
            request_data = UserAll_payload(
                login_id, login_date, details[0], _snapshot_general(info), user_id=user_id,
                login_date_time=login["loginDateTime"],
                user_playlog_list=playlogs,
                user_music_detail_list=details,
                is_new_music_detail_list="1",
            )
            await say(f"结算本局 {len(details)} 条成绩…")
            await _settle_then_upsert(client, h, user_id, request_data, playlogs, say=say)

            if not verify:
                return WriteResult(
                    f"✅ 已写入 {len(details)} 条成绩",
                    status=WRITE_SUBMITTED,
                    written_count=len(details),
                )

            await say("回查确认…")
            found = await fetch_user_music(client, h, user_id, token)
        idx = music_index(found)
        lagging = [
            s for s in specs
            if idx.get((s["musicId"], s["level"]), {}).get("achievement", -1) < s["achievement"]
        ]
        if lagging:
            diff = [
                f"{s['musicId']}/{s['level']} 目标 {s['achievement']}，回查 "
                f"{idx.get((s['musicId'], s['level']), {}).get('achievement', '无记录')}"
                for s in lagging[:5]
            ]
            return WriteResult(
                (
                    f"⚠️ 写入已提交，但回查未达目标成绩（账号共回查 {len(found)} 条谱面）：\n"
                    + "\n".join(diff)
                ),
                status=WRITE_UNCONFIRMED,
                written_count=len(details),
            )
        return WriteResult(
            f"✅ 已写入并回查确认 {len(details)} 条成绩",
            status=WRITE_CONFIRMED,
            written_count=len(details),
        )
    finally:
        await _logout_quietly(client, user_id, login_ts, say)
