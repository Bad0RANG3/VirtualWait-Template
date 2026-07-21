"""SDGB no-login QR preview client.

Flow:
1. Exchange the one-time QR with AiMe (`get_data`) for a temporary user id + token.
2. Call title-server `GetUserPreviewApi` with that token.
3. Never call `UserLoginApi` / `UserLogoutApi`.

This module only keeps values in memory for the duration of one verification call.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
import hashlib
import json
import zlib
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad


# Asia/Tokyo without requiring pytz.
_TOKYO = timezone(timedelta(hours=9))
_MAX_RESPONSE_BYTES = 64 * 1024


class SdgbPreviewError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SdgbPreviewProfile:
    user_id: str
    display_name: str
    rating: int | None
    title: str | None


@dataclass(frozen=True)
class SdgbPreviewSettings:
    aime_url: str
    title_server_url: str
    aime_salt: str
    aes_key: str
    aes_iv: str
    obfuscate_param: str
    keychip_id: str
    client_id: str
    timeout_sec: float = 10.0


def _md5_api(api_name: str, obfuscate_param: str) -> str:
    return hashlib.md5(f"{api_name}MaimaiChn{obfuscate_param}".encode("utf-8")).hexdigest()


def _aes_encrypt(key: str, iv: str, data: bytes) -> bytes:
    cipher = AES.new(key.encode("utf-8"), AES.MODE_CBC, iv.encode("utf-8"))
    return cipher.encrypt(pad(data, AES.block_size))


def _aes_decrypt(key: str, iv: str, data: bytes) -> bytes:
    cipher = AES.new(key.encode("utf-8"), AES.MODE_CBC, iv.encode("utf-8"))
    return unpad(cipher.decrypt(data), AES.block_size)


def _normalize_qr(qr_code: str) -> str:
    value = qr_code.strip()
    if not value:
        raise SdgbPreviewError("QR_EXCHANGE_FAILED")
    # AiMe QR payloads may be wrapped; keep the trailing token segment.
    if len(value) > 64:
        value = value[-64:]
    return value


def _post_json(url: str, payload: dict[str, Any], headers: dict[str, str], timeout_sec: float) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = Request(url, data=body, headers=headers, method="POST")
    try:
        with urlopen(request, timeout=timeout_sec) as response:  # noqa: S310 - operator-configured endpoint
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        try:
            exc.read(_MAX_RESPONSE_BYTES)
        except Exception:
            pass
        raise SdgbPreviewError("QR_EXCHANGE_FAILED") from exc
    except (TimeoutError, URLError) as exc:
        raise SdgbPreviewError("UPSTREAM_TIMEOUT") from exc
    except Exception as exc:  # noqa: BLE001
        raise SdgbPreviewError("UPSTREAM_PROTOCOL_ERROR") from exc
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise SdgbPreviewError("UPSTREAM_PROTOCOL_ERROR")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise SdgbPreviewError("UPSTREAM_PROTOCOL_ERROR") from exc
    if not isinstance(parsed, dict):
        raise SdgbPreviewError("UPSTREAM_PROTOCOL_ERROR")
    return parsed


def exchange_qr(settings: SdgbPreviewSettings, qr_code: str) -> tuple[str, str]:
    """Return (user_id, token) from AiMe without logging into a cabinet."""
    qr = _normalize_qr(qr_code)
    timestamp = datetime.now(_TOKYO).strftime("%y%m%d%H%M%S")
    auth_key = (
        hashlib.sha256(f"{settings.keychip_id}{timestamp}{settings.aime_salt}".encode("utf-8"))
        .hexdigest()
        .upper()
    )
    payload = {
        "chipID": settings.keychip_id,
        "openGameID": "MAID",
        "key": auth_key,
        "qrCode": qr,
        "timestamp": timestamp,
    }
    headers = {
        "Content-Type": "application/json",
        "Host": "ai.sys-all.cn",
        "User-Agent": "WC_AIME_LIB",
    }
    result = _post_json(settings.aime_url, payload, headers, settings.timeout_sec)
    user_id = result.get("userID")
    token = result.get("token")
    # AiMe returns HTTP 200 with errorID for one-time QR failures.
    # errorID=1 + empty token is the common expired/already-used case.
    error_id = result.get("errorID", result.get("errorId"))
    try:
        error_num = int(error_id) if error_id is not None and error_id != "" else 0
    except (TypeError, ValueError):
        error_num = -1
    if error_num != 0 or token is None or token == "":
        if error_num in (0, 1) or token is None or token == "":
            raise SdgbPreviewError("QR_EXPIRED")
        raise SdgbPreviewError("QR_EXCHANGE_FAILED")
    if user_id is None:
        raise SdgbPreviewError("QR_EXCHANGE_FAILED")
    return str(user_id), str(token)


def _call_title_api(
    settings: SdgbPreviewSettings,
    api_name: str,
    data: dict[str, Any],
    user_id: str,
) -> dict[str, Any]:
    api_hash = _md5_api(api_name, settings.obfuscate_param)
    base = settings.title_server_url.rstrip("/") + "/"
    url = f"{base}{api_hash}"
    headers = {
        "User-Agent": f"{api_hash}#{user_id}",
        "Content-Type": "application/json",
        "Mai-Encoding": "1.55",
        "Accept-Encoding": "",
        "Charset": "UTF-8",
        "Content-Encoding": "deflate",
        "Host": "maimai-gm.wahlap.com:42081",
    }
    plaintext = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    body = _aes_encrypt(settings.aes_key, settings.aes_iv, zlib.compress(plaintext))
    request = Request(url, data=body, headers=headers, method="POST")
    try:
        with urlopen(request, timeout=settings.timeout_sec) as response:  # noqa: S310
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        try:
            exc.read(_MAX_RESPONSE_BYTES)
        except Exception:
            pass
        raise SdgbPreviewError("QR_EXCHANGE_FAILED") from exc
    except (TimeoutError, URLError) as exc:
        raise SdgbPreviewError("UPSTREAM_TIMEOUT") from exc
    except Exception as exc:  # noqa: BLE001
        raise SdgbPreviewError("UPSTREAM_PROTOCOL_ERROR") from exc
    if len(raw) > _MAX_RESPONSE_BYTES:
        raise SdgbPreviewError("UPSTREAM_PROTOCOL_ERROR")
    try:
        decoded = zlib.decompress(_aes_decrypt(settings.aes_key, settings.aes_iv, raw)).decode("utf-8")
        parsed = json.loads(decoded)
    except Exception as exc:  # noqa: BLE001
        raise SdgbPreviewError("UPSTREAM_PROTOCOL_ERROR") from exc
    if not isinstance(parsed, dict):
        raise SdgbPreviewError("UPSTREAM_PROTOCOL_ERROR")
    return parsed


def get_user_preview(settings: SdgbPreviewSettings, user_id: str, token: str) -> dict[str, Any]:
    payload = {
        "userId": int(user_id) if str(user_id).isdigit() else user_id,
        "segaIdAuthKey": "",
        "token": token,
        "clientId": settings.client_id,
    }
    return _call_title_api(settings, "GetUserPreviewApi", payload, str(user_id))


def preview_from_qr(settings: SdgbPreviewSettings, qr_code: str) -> SdgbPreviewProfile:
    """No-login profile fetch used by VirtualWait identity verification."""
    user_id, token = exchange_qr(settings, qr_code)
    preview = get_user_preview(settings, user_id, token)

    ban_state = preview.get("banState")
    if ban_state not in (None, 0, "0"):
        # Soft-ban (1) is still a usable identity for queue display; hard ban (2+) fails.
        try:
            if int(ban_state) >= 2:
                raise SdgbPreviewError("ACCOUNT_BANNED")
        except (TypeError, ValueError):
            pass

    display_name = preview.get("userName") or preview.get("userNameStr")
    if not isinstance(display_name, str) or not display_name.strip():
        raise SdgbPreviewError("PROFILE_INCOMPLETE")
    display_name = display_name.strip()[:80]

    rating_raw = preview.get("playerRating")
    rating: int | None
    try:
        rating = int(rating_raw) if rating_raw is not None and rating_raw != "" else None
        if rating is not None:
            rating = min(max(rating, 0), 30000)
    except (TypeError, ValueError):
        rating = None

    title = None
    trophy_id = preview.get("trophyId")
    if trophy_id is not None and trophy_id != "":
        title = f"#{trophy_id}"[:200]

    preview_user_id = preview.get("userId")
    if preview_user_id is not None and str(preview_user_id).strip():
        user_id = str(preview_user_id).strip()

    return SdgbPreviewProfile(
        user_id=str(user_id),
        display_name=display_name,
        rating=rating,
        title=title,
    )
