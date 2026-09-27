# -*- coding: utf-8 -*-
"""成绩记录查询（GetUserMusicApi）：FC / AP / 同步游玩 状态 + 增强版 B50 渲染数据。

- GetUserMusicApi 必须登录后才返回数据（与 GetUserRatingApi 不同）。
- 每次查询扫码换新凭证（token）；登录态查询结束必登出。
- comboStatus: 0=无 1=FC 2=FC+ 3=AP 4=AP+
- syncStatus: 0=无 1=FS 2=FS+ 3=FS DX 4=FS DX+ 5=同步游玩(Sync)
- DX 分数上限 = TAP×500 + HOLD×1000 + SLIDE×1500 + BREAK×2500
  （音符数来自本地曲库 charts[].notes）
"""
import json
import logging
import time
from datetime import datetime
from pathlib import Path

from .runtime import DATA_DIR

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
TOKEN_CACHE = DATA_DIR / "token_cache.json"
RECORDS_CACHE = DATA_DIR / "records_cache.json"
RECORDS_CACHE_TTL_MIN = 10  # 缓存有效时长：避免反复登录触发小黑屋

# comboStatus/syncStatus -> oneshot 徽标 token
ACCURACY_TOKENS = {1: "fc", 2: "fcp", 3: "ap", 4: "app"}
SYNC_TOKENS = {1: "fs", 2: "fsp", 3: "fsd", 4: "fsdp", 5: "sp"}


def compute_dx_total(notes: list) -> int:
    """按音符数计算 DX 分数上限。notes = [tap, hold, slide, break]"""
    tap, hold, slide, brk = (list(notes) + [0, 0, 0, 0])[:4]
    return tap * 500 + hold * 1000 + slide * 1500 + brk * 2500


def chart_notes(db: dict, music_id: int, level: int) -> list | None:
    """取某曲某难度的音符数（曲库 charts[].notes）。找不到返回 None。"""
    try:
        charts = db.get(str(music_id), {}).get("charts") or []
        if 0 <= level < len(charts):
            return charts[level].get("notes")
    except Exception:  # noqa: BLE001
        pass
    return None


async def exchange_qr(client, http, qr: str) -> tuple[int, str, dict]:
    """机台二维码 -> (user_id, token, preview)。

    preview = GetUserPreviewApi 返回（含 userName / playerRating / isLogin）。
    isLogin=1（小黑屋）时直接拒绝，不硬闯。
    """
    from .chime import qr_api
    from .payload import build_preview_data

    qr = (qr or "").strip()
    if len(qr) < 20:
        raise RuntimeError("二维码字符串太短或为空（需要机台登录二维码解析出的字符串）。")
    qr_resp = qr_api(qr)
    user_id, token = qr_resp.get("userID"), qr_resp.get("token")
    if not token or user_id == -1:
        raise RuntimeError(f"二维码换 token 失败：{qr_resp}")
    preview = await client.call_api(
        http, "GetUserPreviewApi", build_preview_data(user_id, token), user_id
    )
    if preview.get("isLogin"):
        raise RuntimeError("isLogin=1（小黑屋）：15 分钟后再试，不要反复登录。")
    # 仅记录最近一次换码的 userID 与时间（排障用）；绝不落盘原始二维码或 token。
    try:
        TOKEN_CACHE.write_text(
            json.dumps({"userID": user_id,
                        "time": datetime.now().isoformat()},
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:  # noqa: BLE001
        pass
    return user_id, token, preview


async def login_with_token(client, http, user_id: int, token: str) -> int:
    """用绑定凭证登录：isLogin 探测 -> UserLoginApi（捕获会话 cookie）。

    返回 login_ts（本次登录时刻）；登出（logout_session）必须原样回传。
    失败抛 RuntimeError（带友好中文提示）。
    """
    from .payload import build_login_data, build_preview_data

    preview = await client.call_api(
        http, "GetUserPreviewApi", build_preview_data(user_id, token), user_id
    )
    if preview.get("isLogin"):
        raise RuntimeError("isLogin=1（小黑屋）：15 分钟后再试，不要反复登录。")
    login_ts = int(time.time())
    login = await client.call_api(
        http, "UserLoginApi",
        build_login_data(user_id, token, timestamp=login_ts), user_id,
    )
    if login.get("returnCode") not in (1, 102):
        raise RuntimeError(
            f"登录失败 returnCode={login.get('returnCode')}。"
            "凭证可能已过期，请换新二维码重试。"
        )
    logger.info("登录成功 loginId=***（值不记录）")
    return login_ts


async def logout_session(client, http, user_id: int, timestamp: int = None) -> dict:
    """UserLogoutApi 登出（登录态查询结束后必须调用，否则易触发小黑屋）。

    timestamp = 该会话登录时刻（login_with_token 返回值），服务器按此校验会话。
    失败抛异常，由调用方决定是否影响主流程。
    """
    from .payload import build_logout_data

    resp = await client.call_api(
        http, "UserLogoutApi",
        build_logout_data(user_id, timestamp=timestamp), user_id,
    )
    logger.info(
        "已登出 userID=%s（loginDateTime=%s）resp=%s",
        user_id, timestamp, json.dumps(resp, ensure_ascii=False)[:200],
    )
    return resp


async def fetch_user_music(client, http, user_id: int, token: str) -> list[dict]:
    """GetUserMusicApi 全量成绩（自动翻页）。

    返回 [{musicId, level, playCount, achievement, comboStatus, syncStatus,
           deluxscoreMax, scoreRank, extNum1, extNum2}, ...]
    """
    from .payload import build_paged_user_data

    records: list[dict] = []
    next_index = 0
    for _ in range(50):  # 防死循环
        resp = await client.call_api(
            http, "GetUserMusicApi", build_paged_user_data(user_id, token, next_index),
            user_id,
        )
        lst = resp.get("userMusicList") or []
        for song in lst:
            records.extend(song.get("userMusicDetailList") or [])
        nxt = resp.get("nextIndex") or 0
        if nxt == 0 or not lst:
            break
        next_index = nxt
    logger.info("GetUserMusicApi: %d 条谱面记录", len(records))
    return records


def music_index(records: list[dict]) -> dict:
    """{(musicId, level): detail}"""
    return {(r["musicId"], r["level"]): r for r in records}


def load_records_cache(user_id: int, allow_stale: bool = False) -> dict | None:
    """读本地成绩缓存。返回 {rating, records} 或 None。

    allow_stale=True 时忽略 TTL（小黑屋/登录失败时兜底，数据可能较旧）。
    """
    if not RECORDS_CACHE.exists():
        return None
    try:
        data = json.loads(RECORDS_CACHE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if data.get("userId") != user_id:
        return None
    if not allow_stale:
        try:
            age = (datetime.now() - datetime.fromisoformat(data["time"])).total_seconds()
        except Exception:  # noqa: BLE001
            return None
        if age > RECORDS_CACHE_TTL_MIN * 60:
            return None
    return data


def save_records_cache(user_id: int, rating: dict, records: list) -> None:
    """写成绩缓存（rating=GetUserRatingApi 原始返回，records=GetUserMusicApi 明细）。"""
    try:
        RECORDS_CACHE.write_text(
            json.dumps({"time": datetime.now().isoformat(), "userId": user_id,
                        "rating": rating, "records": records},
                       ensure_ascii=False),
            encoding="utf-8",
        )
        logger.info("成绩缓存已写入 %s（%d 条记录）", RECORDS_CACHE, len(records))
    except Exception:  # noqa: BLE001
        logger.warning("写成绩缓存失败(可忽略)", exc_info=True)


def enrich_entry(entry: dict, detail: dict | None, db: dict) -> dict:
    """给 oneshot 条目补上 FC/AP/同步/DX 分数/游玩次数（详情缺失时保持原样）。"""
    if not detail:
        return entry
    acc = ACCURACY_TOKENS.get(detail.get("comboStatus"))
    if acc:
        entry["achievementAccuracy"] = acc
    sync = SYNC_TOKENS.get(detail.get("syncStatus"))
    if sync:
        entry["achievementSync"] = sync
    if detail.get("playCount"):
        entry["playCount"] = detail["playCount"]
    notes = chart_notes(db, detail["musicId"], detail["level"])
    if notes and detail.get("deluxscoreMax"):
        entry["achievementDXScore"] = {
            "achieved": detail["deluxscoreMax"],
            "total": compute_dx_total(notes),
        }
    return entry


def rating_to_payload_full(
    user_rating: dict,
    db: dict,
    idx: dict,
    version: str = "PRiSM PLUS",
    region: str = "cn",
) -> dict:
    """userRating + 成绩记录 -> 增强版 oneshot payload（B35/B15 顺序仍用服务器排序）。"""
    from .b50 import music_to_sheet_id

    def build(bucket_key: str, limit: int) -> list:
        out = []
        for m in (user_rating.get(bucket_key) or [])[:limit]:
            sid = music_to_sheet_id(m["musicId"], m["level"], db)
            if not sid:
                continue
            entry = {"sheetId": sid, "achievementRate": m["achievement"] / 10000.0}
            enrich_entry(entry, idx.get((m["musicId"], m["level"])), db)
            out.append(entry)
        return out

    return {
        "version": version,
        "region": region,
        "calculatedEntries": {
            "b15": build("newRatingList", 15),
            "b35": build("ratingList", 35),
        },
    }


async def fetch_b50_payload_full(
    client, http, user_id: int, token: str, db: dict,
    version: str = "PRiSM PLUS", region: str = "cn", use_cache: bool = True,
) -> dict:
    """登录态：GetUserRatingApi（B50 排序）+ GetUserMusicApi（徽标）-> 增强 payload。

    use_cache=True 时优先用本地缓存（10 分钟内），避免重复登录触发小黑屋。
    """
    from .payload import build_user_data

    cached = load_records_cache(user_id) if use_cache else None
    if cached and cached.get("rating") and cached.get("records"):
        logger.info("/b50 命中缓存（%s）", RECORDS_CACHE.name)
        return rating_to_payload_full(
            cached["rating"], db, music_index(cached["records"]),
            version=version, region=region,
        )

    rating_resp = await client.call_api(
        http, "GetUserRatingApi", build_user_data(user_id, token), user_id
    )
    records = await fetch_user_music(client, http, user_id, token)
    if use_cache:
        save_records_cache(user_id, rating_resp.get("userRating") or {}, records)
    return rating_to_payload_full(
        rating_resp.get("userRating") or {}, db, music_index(records),
        version=version, region=region,
    )
