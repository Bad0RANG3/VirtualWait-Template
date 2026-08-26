# -*- coding: utf-8 -*-
"""AIME 二维码字符串 -> userID / token。

通过 ai.sys-allnet.cn 的 wc_aime 接口，用机台二维码字符串换取登录凭证。
所有配置（KeychipID、aimeUrl、aimeSalt、openGameID）均来自 settings.py，
支持运行时注入（Gateway 使用受限 transport，机器人使用 httpx）。
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any, Callable
from urllib.parse import urlparse

import httpx
import pytz

from .settings import KeychipID, aimeUrl, aimeSalt, openGameID

# 可注入的 HTTP JSON POST 函数签名（与 virtualwait_gateway.transport.http_post_json 兼容）
HttpPostJson = Callable[..., dict[str, Any]]


class ChimeError(RuntimeError):
    """二维码换 token 失败（code: QR_EXPIRED / QR_EXCHANGE_FAILED）。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _default_http_post_json(
    url: str,
    payload: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
    timeout_sec: float = 10.0,
    max_response_bytes: int | None = None,
) -> dict[str, Any]:
    """默认 httpx 实现（供 QQ 机器人等允许 httpx 的环境使用）。"""
    res = httpx.post(
        url,
        data=json.dumps(payload, separators=(",", ":")),
        headers=headers,
        timeout=timeout_sec,
    )
    if res.status_code != 200:
        raise ChimeError("QR_EXCHANGE_FAILED")
    try:
        parsed = res.json()
    except (json.JSONDecodeError, ValueError):
        raise ChimeError("QR_EXCHANGE_FAILED") from None
    if not isinstance(parsed, dict):
        raise ChimeError("QR_EXCHANGE_FAILED")
    return parsed


def build_qr_payload(
    qr_code: str,
    keychip_id: str,
    salt: str,
    game_id: str,
    timestamp: str | None = None,
) -> dict[str, str]:
    """构造 AiMe get_data 请求体（纯函数）。"""
    if len(qr_code) > 64:
        qr_code = qr_code[-64:]
    time_stamp = timestamp or datetime.now(pytz.timezone("Asia/Tokyo")).strftime("%y%m%d%H%M%S")
    auth_key = hashlib.sha256(
        (keychip_id + time_stamp + salt).encode("UTF-8")
    ).hexdigest().upper()
    return {
        "chipID": keychip_id,
        "openGameID": game_id,
        "key": auth_key,
        "qrCode": qr_code,
        "timestamp": time_stamp,
    }


def exchange_qr_via(
    qr_code: str,
    http_post_json_fn: HttpPostJson,
    *,
    keychip_id: str | None = None,
    url: str | None = None,
    salt: str | None = None,
    game_id: str | None = None,
    timeout_sec: float = 10.0,
) -> tuple[str, str]:
    """用二维码换取 (userID, token)。

    与 :func:`qr_api` 等价，但 HTTP 层由调用方注入：
    - 机器人/CLI：注入默认 httpx 实现；
    - Gateway：注入受限 transport（无重定向、有界读取）。
    """
    keychip_id = keychip_id or KeychipID
    url = url or aimeUrl
    salt = salt or aimeSalt
    game_id = game_id or openGameID
    if not keychip_id or not url or not salt:
        raise RuntimeError(
            "SDGB AIME 配置缺失：请设置 VW_SDGB_KEYCHIP_ID / VW_SDGB_AIME_URL / "
            "VW_SDGB_AIME_SALT（或填写 sdgb/settings_local.py），禁止使用空默认值。"
        )

    payload = build_qr_payload(qr_code, keychip_id, salt, game_id)
    host = urlparse(url).netloc
    headers = {
        "Contention": "Keep-Alive",
        "Host": host,
        "User-Agent": "WC_AIME_LIB",
    }
    result = http_post_json_fn(url, payload, headers=headers, timeout_sec=timeout_sec)

    user_id = result.get("userID")
    token = result.get("token")
    error_id = result.get("errorID", result.get("errorId"))
    try:
        error_num = int(error_id) if error_id is not None and error_id != "" else 0
    except (TypeError, ValueError):
        error_num = -1
    if error_num != 0 or token is None or token == "":
        if error_num in (0, 1) or token is None or token == "":
            raise ChimeError("QR_EXPIRED")
        raise ChimeError("QR_EXCHANGE_FAILED")
    if user_id is None:
        raise ChimeError("QR_EXCHANGE_FAILED")
    return str(user_id), str(token)


def qr_api(qr_code: str, keychip_id: str = None, url: str = None,
           salt: str = None, game_id: str = None) -> dict:
    """兼容旧接口：用二维码字符串换取 {userID, token}（httpx 实现）。"""
    user_id, token = exchange_qr_via(
        qr_code,
        _default_http_post_json,
        keychip_id=keychip_id,
        url=url,
        salt=salt,
        game_id=game_id,
    )
    return {"userID": int(user_id) if str(user_id).isdigit() else user_id, "token": token}