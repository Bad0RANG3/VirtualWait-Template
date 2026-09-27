# -*- coding: utf-8 -*-
"""SDGB 标题服务器客户端。

提供:
- MaimaiClient: 与标题服务器通信（AES-CBC + zlib 加密管道）
- login(qr_code): 二维码字符串 -> userID/token -> UserLoginApi 完整登录
"""
import json
import logging
import re
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
    ) -> dict:
        """压缩 -> 加密 -> POST，然后解密 -> 解压 -> 解析 JSON 返回。

        cookie: 显式传会话 cookie（登录时捕获的 "JSESSIONID=xxx"）；
                不传则用 self.cookies。写操作（Upsert* / Upload*）必须携带，
                否则服务器按无会话处理，写操作会被静默忽略（返回成功但未入账）。
        机台的 HTTP 客户端是自动收发 cookie 的，所以这里也在每个响应上收集。
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
        self._capture_cookie(resp, ApiType)
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

    def _capture_cookie(self, resp, ApiType: str) -> None:
        """把响应的 Set-Cookie 并进 self.cookies（按名字覆盖），值不写日志。

        服务器通常在**第一个**请求上就发下 JSESSIONID，登录那次未必再发一次；只在
        UserLoginApi 捕获会让整个会话都不带 cookie，服务器就无法把请求归到已登录用户
        （实测：GetGameKaleidxScopeApi 因此只回全区列表，读不到 charaSlot）。
        """
        raw = resp.headers.get("set-cookie")
        if not raw:
            return
        merged = {}
        for nv in (self.cookies or "").split(";"):
            nv = nv.strip()
            if "=" in nv:
                k, v = nv.split("=", 1)
                merged[k.strip()] = v.strip()
        names = []
        # 多个 Set-Cookie 会被连成一个头，日期里也有逗号，所以按「名=值」形状切分。
        for chunk in re.split(r",\s*(?=[A-Za-z_][A-Za-z0-9_\-]*=)", raw):
            nv = chunk.split(";", 1)[0].strip()
            if "=" in nv:
                k, v = nv.split("=", 1)
                merged[k.strip()] = v.strip()
                names.append(k.strip())
        if names:
            self.cookies = "; ".join(f"{k}={v}" for k, v in merged.items())
            logger.info("[COOKIE] %s 下发 %s（长度=%d，值不记录）",
                        ApiType, names, len(self.cookies))

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

        async with httpx.AsyncClient(verify=True) as client:
            # 1) Preview 探测是否已在他处登录
            preview = None
            try:
                preview = await self.call_api(
                    client, "GetUserPreviewApi",
                    build_preview_data(user_id, token), user_id,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("GetUserPreviewApi 失败(可忽略): %s", type(e).__name__)

            # 2) UserLogin（响应里的 JSESSIONID 由 call_api 自动收集）
            login_ts = int(_time.time())
            login_data = build_login_data(user_id, token, timestamp=login_ts)
            login_resp = await self.call_api(
                client, "UserLoginApi", login_data, user_id,
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
        async with httpx.AsyncClient(verify=True) as client:
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
        async with httpx.AsyncClient(verify=True) as client:
            return await self.call_api(client, "UserLogoutApi", data, user_id)
