# -*- coding: utf-8 -*-
"""B50 成绩图生成模块。

流程:
  1. GetUserRatingApi -> userRating.ratingList(B35, 35条) + newRatingList(B15, 15条)
  2. 每条 {musicId, level(0-4), achievement} -> sheetId = "{曲名}__dxrt__{dx|std}__dxrt__{难度}"
  3. POST 渲染服务（oneshot），返回 JPEG 图片字节

曲名库: 本地缓存 sdgb/music_data_cache.json（缺失时自动下载，gitignore）。
"""
import json
import logging
from pathlib import Path

from .runtime import DATA_DIR

import httpx

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
CACHE_PATH = DATA_DIR / "music_data_cache.json"
MUSIC_DATA_URL = "https://www.diving-fish.com/api/maimaidxprober/music_data"
ONESHOOT_URL = "https://miruku.dxrating.net/functions/render-oneshot/v0?pixelated=1"

# GetUserRatingApi 的 level(0-4) -> 难度名
LEVEL_NAMES = ["basic", "advanced", "expert", "master", "remaster"]


def load_music_db(force_download: bool = False) -> dict:
    """加载曲名库 {musicId(str): {title, type, ...}}，缺失时自动下载。"""
    if not CACHE_PATH.exists() or force_download:
        logger.info("下载曲名库 %s", MUSIC_DATA_URL)
        resp = httpx.get(MUSIC_DATA_URL, timeout=30)
        resp.raise_for_status()
        data = {str(m["id"]): m for m in resp.json()}
        CACHE_PATH.write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )
        return data
    return json.loads(CACHE_PATH.read_text(encoding="utf-8"))


def music_to_sheet_id(music_id: int, level: int, db: dict) -> str | None:
    """musicId + level -> oneshot sheetId（找不到曲名返回 None）。"""
    info = db.get(str(music_id))
    if not info:
        return None
    title = info.get("title")
    if not title:
        return None
    notes_type = (info.get("type") or "").lower()  # "SD"|"DX" -> "std"|"dx"
    if notes_type not in ("std", "dx"):
        notes_type = "dx" if music_id >= 10000 else "std"  # 兜底
    level_name = LEVEL_NAMES[level] if 0 <= level < len(LEVEL_NAMES) else "master"
    return f"{title}__dxrt__{notes_type}__dxrt__{level_name}"


def rating_to_payload(
    user_rating: dict,
    db: dict,
    version: str = "PRiSM PLUS",
    region: str = "cn",
) -> dict:
    """userRating -> oneshot 请求体。

    服务器已排好序：ratingList 取前 35、newRatingList 取前 15。
    找不到曲名的条目跳过（不影响其它）。
    """
    b35 = []
    for m in (user_rating.get("ratingList") or [])[:35]:
        sid = music_to_sheet_id(m["musicId"], m["level"], db)
        if sid:
            b35.append({"sheetId": sid, "achievementRate": m["achievement"] / 10000.0})
    b15 = []
    for m in (user_rating.get("newRatingList") or [])[:15]:
        sid = music_to_sheet_id(m["musicId"], m["level"], db)
        if sid:
            b15.append({"sheetId": sid, "achievementRate": m["achievement"] / 10000.0})
    return {
        "version": version,
        "region": region,
        "calculatedEntries": {"b15": b15, "b35": b35},
    }


async def render_oneshot(payload: dict, timeout: float = 60.0) -> bytes:
    """调 oneshot 渲染服务，返回图片字节。"""
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(ONESHOOT_URL, json=payload)
        resp.raise_for_status()
        return resp.content


async def fetch_b50_payload(client, http, user_id: int, token: str, db: dict) -> dict:
    """登录态拉 GetUserRatingApi -> oneshot payload。

    client: MaimaiClient；http: httpx.AsyncClient（复用连接）。
    """
    from .payload import build_user_data

    resp = await client.call_api(http, "GetUserRatingApi", build_user_data(user_id, token), user_id)
    return rating_to_payload(resp.get("userRating") or {}, db)


async def fetch_b50_payload_public(client, http, user_id: int, db: dict) -> dict:
    """无需 token/登录：直接按 userId 拉 GetUserRatingApi -> oneshot payload。

    实测确认 GetUserRatingApi 只要 userId 就返回完整 B35+B15（2026-08-15）。
    """
    from .payload import build_user_data

    resp = await client.call_api(
        http, "GetUserRatingApi", build_user_data(user_id, ""), user_id
    )
    return rating_to_payload(resp.get("userRating") or {}, db)


def save_png(data: bytes, path: Path | str) -> Path:
    path = Path(path)
    path.write_bytes(data)
    logger.info("B50 图已保存: %s (%d bytes)", path, len(data))
    return path
