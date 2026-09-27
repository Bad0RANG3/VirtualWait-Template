# -*- coding: utf-8 -*-
"""SDGB 标题服务器客户端。

提供:
- MaimaiClient: 与标题服务器通信（AES-CBC + zlib 加密管道）
- login(qr_code): 二维码字符串 -> userID/token -> UserLoginApi 完整登录
"""
import json
import logging
import zlib

import httpx

from .encrypt import (
    AesKey,
    AesIV,
    MAI_ENCODING,
    aes_pkcs7,
    get_hash_api,
)
from .settings import titleServerUrl

logger = logging.getLogger(__name__)

# 只读查询接口名单（绝不包含 UserLoginApi / UserLogoutApi / Upsert* / Upload*）
READONLY_API_TYPES = [
    "GetUserDataApi",
    "GetUserExtendApi",
    "GetUserOptionApi",
    "GetUserRatingApi",
    "GetUserChargeApi",
    "GetUserActivityApi",
    "GetUserMissionDataApi",
    "GetUserMusicApi",
    "GetUserItemApi",
    "GetUserCharacterApi",
    "GetUserCardApi",
    "GetUserCourseApi",
    "GetUserMapApi",
    "GetUserLoginBonusApi",
    "GetUserPortraitApi",
    "GetUserGhostApi",
    "GetUserFavoriteApi",
    "GetUserFavoriteItemApi",
    "GetUserRegionApi",
    "GetUserScoreRankingApi",
    "GetUserRecommendRateMusicApi",
    "GetUserRecommendSelectMusicApi",
    "GetUserFriendSeasonRankingApi",
    "GetTransferFriendApi",
    "GetGameSettingApi",
    "GetGameEventApi",
    "GetGameChargeApi",
    "GetGameRankingApi",
    "GetGameNgMusicIdApi",
    "GetGameNgWordListApi",
    "GetGameTournamentInfoApi",
]



class MaimaiClient:
    def __init__(self, base_url: str = None):
        self.base_url = base_url or titleServerUrl
        self.aes = aes_pkcs7(AesKey, AesIV)
        self.mai_encoding = MAI_ENCODING
        # 登录时从 Set-Cookie 捕获的会话 cookie（JSESSIONID=xxx），
        # 写操作必须携带（登录会话校验用）
        self.cookies: str | None = None

    # ---------------------------------------------------------
    # 底层通信
    # ---------------------------------------------------------
    async def call_api(
        self,
        client: httpx.AsyncClient,
        ApiType: str,
        data: dict,
        userId: int,
        cookie: str = None,
        capture_cookie: bool = False,
    ) -> dict:
        """压缩 -> 加密 -> POST，然后解密 -> 解压 -> 解析 JSON 返回。

        cookie: 显式传会话 cookie（登录时捕获的 "JSESSIONID=xxx"）；
                不传则用 self.cookies。写操作（Upsert* / Upload*）必须携带，
                否则服务器按无会话处理，写操作会被静默忽略（返回成功但未入账）。
        capture_cookie: True 时把响应 Set-Cookie 头解析进 self.cookies（登录用）。
        """
        ApiTypeHash = get_hash_api(ApiType)
        url = f"{self.base_url}/{ApiTypeHash}"

        headers = {
            "User-Agent": f"{ApiTypeHash}#{userId}",
            "Content-Type": "application/json",
            "Mai-Encoding": self.mai_encoding,
            "Accept-Encoding": "",
            "Charset": "UTF-8",
            "Content-Encoding": "deflate",
            "number": "0",
            "Host": "maimai-gm.wahlap.com:42081",
        }
        cookie = cookie or self.cookies
        if cookie:
            headers["Cookie"] = cookie

        body = bytes(json.dumps(data), encoding="utf-8")
        compressed = zlib.compress(body)
        encrypted = self.aes.encrypt(compressed)

        resp = await client.post(url, headers=headers, data=encrypted, timeout=15.0)
        if capture_cookie:
            set_cookie = resp.headers.get("set-cookie")
            if set_cookie:
                # 截取 "JSESSIONID=xxx" 形式的 cookie 串
                parts = []
                for chunk in set_cookie.split(","):
                    chunk = chunk.strip()
                    semi = chunk.find(";")
                    nv = chunk[:semi] if semi > 0 else chunk
                    if "=" in nv:
                        parts.append(nv.strip())
                if parts:
                    self.cookies = "; ".join(parts)
                    logger.info("[COOKIE] 已捕获会话 cookie（长度=%d，值不记录）", len(self.cookies))
            else:
                logger.info("[COOKIE] %s 未返回 Set-Cookie", ApiType)
        if resp.status_code != 200:
            # 记录服务器返回体（500 等错误的具体原因常在里面）
            logger.error(
                "[HTTP %s] %s（响应体不记录）",
                resp.status_code, ApiType,
            )
        resp.raise_for_status()

        decrypted = self.aes.decrypt(resp.content)
        uncompressed = zlib.decompress(decrypted).decode("utf-8")
        logger.info("[SUCCESS] %s（长度=%d，内容不记录）", ApiType, len(uncompressed))
        if not uncompressed.strip():
            # 写接口（Upsert* / Upload*）成功后返回空响应体，按成功处理
            logger.info("[EMPTY-RESPONSE] %s -> treated as success", ApiType)
            return {"returnCode": 0, "_emptyResponse": True}
        return json.loads(uncompressed)

    # ---------------------------------------------------------
    # 高层流程
    # ---------------------------------------------------------
    async def login(
        self,
        qr_code: str,
        keychip_id: str = None,
        aime_url: str = None,
        aime_salt: str = None,
        open_game_id: str = None,
    ) -> dict:
        """二维码字符串 -> userID/token -> UserLoginApi。

        返回 {userId, token, qrResponse, loginResponse, previewResponse, loginDateTime}
        loginDateTime = 本次登录时刻（秒），登出时应原样回传（UserLogoutApi 校验）。
        """
        import time as _time

        from .chime import qr_api
        from .payload import build_login_data, build_preview_data

        qr_resp = qr_api(
            qr_code,
            keychip_id=keychip_id,
            url=aime_url,
            salt=aime_salt,
            game_id=open_game_id,
        )
        user_id = qr_resp["userID"]
        token = qr_resp["token"]

        async with httpx.AsyncClient(verify=False) as client:
            # 1) Preview 探测是否已在他处登录
            preview = None
            try:
                preview = await self.call_api(
                    client, "GetUserPreviewApi",
                    build_preview_data(user_id, token), user_id,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("GetUserPreviewApi 失败(可忽略): %s", type(e).__name__)

            # 2) UserLogin（capture_cookie: 捕获 JSESSIONID 供写操作使用）
            login_ts = int(_time.time())
            login_data = build_login_data(user_id, token, timestamp=login_ts)
            login_resp = await self.call_api(
                client, "UserLoginApi", login_data, user_id,
                capture_cookie=True,
            )

        return {
            "userId": user_id,
            "token": token,
            "qrResponse": qr_resp,
            "previewResponse": preview,
            "loginResponse": login_resp,
            "loginDateTime": login_ts,
            "cookies": self.cookies,
        }

    async def query_user_items(
        self,
        client: httpx.AsyncClient,
        user_id: int,
        token: str,
        cookie: str = None,
    ) -> dict:
        """GetUserItemApi 按 itemKind 分区拉取并合并。

        服务器要求 nextIndex = itemKind * 10^10（nextIndex=0 会 500），
        每个 kind 内再跟随响应的 nextIndex 翻页直到 0。
        返回 {"apiName", "userItemList", "byItemKind", "counts", "errors", "total"}。
        """
        from .payload import (
            USER_ITEM_KIND_NAMES,
            USER_ITEM_KINDS,
            build_user_item_data,
        )

        merged: list = []
        by_kind: dict = {}
        errors: dict = {}
        for kind in USER_ITEM_KINDS:
            items: list = []
            next_index = kind * 10000000000
            try:
                while True:
                    data = build_user_item_data(
                        user_id, token, item_kind=kind, next_index=next_index
                    )
                    resp = await self.call_api(
                        client, "GetUserItemApi", data, user_id, cookie=cookie
                    )
                    items.extend(resp.get("userItemList") or [])
                    next_index = resp.get("nextIndex") or 0
                    if next_index == 0:
                        break
            except Exception as e:  # noqa: BLE001
                logger.error("[ERROR] GetUserItemApi kind=%s: %s", kind, e)
                errors[USER_ITEM_KIND_NAMES.get(kind, str(kind))] = str(e)
            by_kind[USER_ITEM_KIND_NAMES.get(kind, str(kind))] = items
            merged.extend(items)
        return {
            "apiName": "GetUserItemApi",
            "userItemList": merged,
            "byItemKind": by_kind,
            "counts": {k: len(v) for k, v in by_kind.items()},
            "errors": errors,
            "total": len(merged),
        }

    async def query(
        self,
        user_id: int,
        token: str,
        api_types=None,
        payload_extra: dict = None,
        cookie: str = None,
    ) -> dict:
        """只读查询各 Get*Api（请求体统一带 userId + token）。

        - api_types: 缺省取 READONLY_API_TYPES（全部只读接口）
        - payload_extra: {apiType: {额外字段}}，用于 GetGameRankingApi 等
          需要额外参数（如 rankingId）的接口；会合并进基础请求体。
        - 分页类接口（见 PAGED_API_TYPES）自动附加 nextIndex/maxCount。
        - 空体类接口（见 EMPTY_BODY_API_TYPES）请求体固定为 {}：带 userId/token
          时服务器不返回该接口的完整数据（实测 GetGameKaleidxScopeApi 读不到 charaSlot）。
        - cookie: 登录态查询携带会话 cookie（登录后拉数据建议传入）。
        """
        from .payload import (
            EMPTY_BODY_API_TYPES,
            PAGED_API_TYPES,
            build_paged_user_data,
            build_user_data,
        )

        if api_types is None:
            api_types = list(READONLY_API_TYPES)

        results = {}
        async with httpx.AsyncClient(verify=False) as client:
            for api_type in api_types:
                try:
                    if api_type == "GetUserItemApi":
                        # 特殊分页：按 itemKind 分区（nextIndex=0 会 500）
                        resp = await self.query_user_items(
                            client, user_id, token, cookie=cookie
                        )
                    else:
                        if api_type in EMPTY_BODY_API_TYPES:
                            data = {}
                        elif api_type in PAGED_API_TYPES:
                            data = build_paged_user_data(user_id, token)
                        else:
                            data = build_user_data(user_id, token)
                        extra = (payload_extra or {}).get(api_type)
                        if extra:
                            data = {**data, **extra}
                        resp = await self.call_api(
                            client, api_type, data, user_id, cookie=cookie
                        )
                    results[api_type] = resp
                except Exception as e:  # noqa: BLE001
                    logger.error("[ERROR] %s: %s", api_type, e)
                    results[api_type] = {"error": str(e)}
        return results


    async def logout(
        self,
        user_id: int,
        region_id: int = None,
        place_id: int = None,
        client_id: str = None,
        timestamp: int = None,
    ) -> dict:
        """UserLogoutApi。

        timestamp = 该会话的登录时刻（client.login 返回的 loginDateTime），
        服务器按此校验会话；缺省回退到当前时刻（可能导致登出被拒）。
        """
        from .payload import build_logout_data

        data = build_logout_data(
            user_id,
            timestamp=timestamp,
            region_id=region_id,
            place_id=place_id,
            client_id=client_id,
        )
        async with httpx.AsyncClient(verify=False) as client:
            return await self.call_api(client, "UserLogoutApi", data, user_id)
