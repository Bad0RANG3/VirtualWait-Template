"""SDGB full provider: 真实登录校验身份（登录 -> 取公开资料 -> 立即登出）。

与 `sdgb_preview`（无登录）的区别：本 provider 调用 `UserLoginApi` / `UserLogoutApi`，
因此是真正意义上的“验证该二维码能登录机台”。

凭证纪律（沿用 MaidXTool，避免小黑屋 isLogin=1）：
- 每次新二维码换新 token，不跨操作复用；
- 登录前用 `GetUserPreviewApi` 探测 isLogin（小黑屋）直接拒绝；
- 取完公开资料立即 `UserLogoutApi` 登出（回传登录时刻）；
- 登出失败时只持久化**加密**的恢复上下文，由 Gateway 的 `LOGGING_OUT`
  作业状态与恢复线程后台重试，保证“必登出”。

本模块只返回允许公开的最小资料；原始二维码、token 与完整上游响应
不会离开本模块，也不会写入数据库或日志。
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from Crypto.Cipher import AES
from Crypto.Random import get_random_bytes

# ---------------------------------------------------------------------------
# 共享 SDGB 客户端（packages/sdgb-client）。仓库内运行时直接注入 PYTHONPATH，
# 便于 monorepo 本地开发与测试；也可通过 `pip install -e packages/sdgb-client`。
# ---------------------------------------------------------------------------
_CLIENT_ROOT = Path(__file__).resolve().parents[4] / "packages" / "sdgb-client"
if str(_CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_CLIENT_ROOT))

from sdgb.chime import ChimeError, exchange_qr_via  # noqa: E402
from sdgb.encrypt import MAI_ENCODING, aes_pkcs7, get_hash_api  # noqa: E402
from sdgb.payload import (  # noqa: E402
    build_login_data,
    build_logout_data,
    build_preview_data,
)

from .transport import TransportError, http_post_full  # noqa: E402


class SdgbFullError(RuntimeError):
    """SDGB full 流程错误（code 使用 Gateway 契约错误码风格）。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class SdgbFullSettings:
    aime_url: str
    title_server_url: str
    aime_salt: str
    aes_key: str
    aes_iv: str
    obfuscate_param: str
    keychip_id: str
    client_id: str
    region_id: int = 1403
    place_id: int = 1
    timeout_sec: float = 10.0


@dataclass(frozen=True)
class SdgbFullResult:
    status: str  # SUCCEEDED | FAILED | LOGGING_OUT
    subject: str | None = None
    profile: dict[str, object] | None = None
    error_code: str | None = None
    encrypted_logout_context: bytes | None = None


# ---------------------------------------------------------------------------
# 加密恢复上下文（AES-GCM，密钥派生自 public id HMAC secret）
# ---------------------------------------------------------------------------


def _derive_key(secret: str) -> bytes:
    return hashlib.sha256(secret.encode("utf-8")).digest()


def encrypt_context(secret: str, data: dict[str, object]) -> bytes:
    cipher = AES.new(_derive_key(secret), AES.MODE_GCM, nonce=get_random_bytes(12))
    ciphertext, tag = cipher.encrypt_and_digest(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    return cipher.nonce + tag + ciphertext


def decrypt_context(secret: str, blob: bytes) -> dict[str, object]:
    if len(blob) < 12 + 16:
        raise SdgbFullError("UPSTREAM_PROTOCOL_ERROR")
    nonce, tag, ciphertext = blob[:12], blob[12:28], blob[28:]
    try:
        plain = AES.new(_derive_key(secret), AES.MODE_GCM, nonce=nonce).decrypt_and_verify(
            ciphertext, tag
        )
    except Exception as exc:
        raise SdgbFullError("UPSTREAM_PROTOCOL_ERROR") from exc
    try:
        parsed = json.loads(plain.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise SdgbFullError("UPSTREAM_PROTOCOL_ERROR") from exc
    if not isinstance(parsed, dict):
        raise SdgbFullError("UPSTREAM_PROTOCOL_ERROR")
    return parsed


# ---------------------------------------------------------------------------
# 同步标题服务器客户端（受限 transport，无重定向、有界读取）
# ---------------------------------------------------------------------------


def _parse_set_cookie(headers: dict[str, str]) -> str | None:
    """从响应头提取会话 cookie（JSESSIONID=xxx；多个逗号分隔时取全部）。"""
    raw = headers.get("Set-Cookie") or headers.get("set-cookie")
    if not raw:
        return None
    parts = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        semi = chunk.find(";")
        nv = chunk[:semi] if semi > 0 else chunk
        if "=" in nv:
            parts.append(nv.strip())
    return "; ".join(parts) if parts else None


class SdgbSyncClient:
    """同步 SDGB 客户端：AES-CBC + zlib 加密管道，与 MaidXTool MaimaiClient 等价。

    HTTP 层使用 Gateway 受限 transport（不跟随重定向、响应有界），
    因此可安全用于真实 provider。
    """

    def __init__(
        self,
        settings: SdgbFullSettings,
        http_post_fn: Callable[..., tuple[int, dict[str, str], bytes]] = http_post_full,
    ) -> None:
        self.settings = settings
        self._http_post = http_post_fn
        self.aes = aes_pkcs7(settings.aes_key, settings.aes_iv)
        self.cookies: str | None = None

    def call_api(
        self,
        api_type: str,
        data: dict[str, Any],
        user_id: str,
        cookie: str | None = None,
        capture_cookie: bool = False,
    ) -> dict[str, Any]:
        api_hash = get_hash_api(api_type, obfuscate=self.settings.obfuscate_param)
        url = f"{self.settings.title_server_url.rstrip('/')}/{api_hash}"
        headers = {
            "User-Agent": f"{api_hash}#{user_id}",
            "Content-Type": "application/json",
            "Mai-Encoding": MAI_ENCODING,
            "Accept-Encoding": "",
            "Charset": "UTF-8",
            "Content-Encoding": "deflate",
            "number": "0",
            "Host": "maimai-gm.wahlap.com:42081",
        }
        cookie = cookie or self.cookies
        if cookie:
            headers["Cookie"] = cookie

        plaintext = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        encrypted = self.aes.encrypt(zlib.compress(plaintext))
        try:
            status, response_headers, raw = self._http_post(
                url,
                encrypted,
                headers=headers,
                timeout_sec=self.settings.timeout_sec,
            )
        except TransportError as exc:
            code = "UPSTREAM_TIMEOUT" if exc.code == "UPSTREAM_TIMEOUT" else "UPSTREAM_PROTOCOL_ERROR"
            raise SdgbFullError(code) from exc

        if capture_cookie:
            captured = _parse_set_cookie(response_headers)
            if captured:
                self.cookies = captured

        if status != 200:
            raise SdgbFullError("UPSTREAM_PROTOCOL_ERROR")
        try:
            uncompressed = zlib.decompress(self.aes.decrypt(raw)).decode("utf-8")
        except Exception as exc:
            raise SdgbFullError("UPSTREAM_PROTOCOL_ERROR") from exc
        if not uncompressed.strip():
            # 写接口（Upsert* / Upload*）成功后返回空响应体；登录/预览接口不应为空。
            return {"_emptyResponse": True}
        try:
            parsed = json.loads(uncompressed)
        except json.JSONDecodeError as exc:
            raise SdgbFullError("UPSTREAM_PROTOCOL_ERROR") from exc
        if not isinstance(parsed, dict):
            raise SdgbFullError("UPSTREAM_PROTOCOL_ERROR")
        return parsed


# ---------------------------------------------------------------------------
# 资料提取（与 sdgb_preview 相同的最小公开字段）
# ---------------------------------------------------------------------------


def _profile_from_preview(preview: dict[str, Any]) -> dict[str, object]:
    display_name = preview.get("userName") or preview.get("userNameStr")
    if not isinstance(display_name, str) or not display_name.strip():
        raise SdgbFullError("PROFILE_INCOMPLETE")
    display_name = display_name.strip()[:80]

    rating_raw = preview.get("playerRating")
    rating: int | None = None
    if rating_raw is not None and rating_raw != "":
        try:
            rating = min(max(int(rating_raw), 0), 30000)
        except (TypeError, ValueError):
            rating = None

    title: str | None = None
    trophy_id = preview.get("trophyId")
    if trophy_id is not None and trophy_id != "":
        title = f"#{trophy_id}"[:200]

    return {"displayName": display_name, "rating": rating, "title": title}


# ---------------------------------------------------------------------------
# Provider 服务（不含 Gateway 契约依赖，便于独立测试）
# ---------------------------------------------------------------------------


class SdgbFullVerificationService:
    def __init__(
        self,
        settings: SdgbFullSettings,
        public_id_hmac_secret: str,
        http_post_json_fn: Callable[..., dict[str, Any]] | None = None,
        http_post_fn: Callable[..., tuple[int, dict[str, str], bytes]] | None = None,
    ) -> None:
        self.settings = settings
        self.public_id_hmac_secret = public_id_hmac_secret
        self._http_post_json_fn = http_post_json_fn
        self._http_post_fn = http_post_fn

    # -- QR 交换 -----------------------------------------------------------
    def _exchange_qr(self, qr_code: str) -> tuple[str, str]:
        from .transport import http_post_json as _default_http_post_json

        if len((qr_code or "").strip()) < 20:
            raise SdgbFullError("QR_EXCHANGE_FAILED")
        fn = self._http_post_json_fn or _default_http_post_json
        try:
            return exchange_qr_via(
                qr_code,
                fn,
                keychip_id=self.settings.keychip_id,
                url=self.settings.aime_url,
                salt=self.settings.aime_salt,
                game_id="MAID",
                timeout_sec=self.settings.timeout_sec,
            )
        except ChimeError as exc:
            raise SdgbFullError(exc.code) from exc

    # -- 主流程 -------------------------------------------------------------
    def verify(self, qr_code: str) -> SdgbFullResult:
        try:
            user_id, token = self._exchange_qr(qr_code)
        except SdgbFullError as exc:
            return SdgbFullResult(status="FAILED", error_code=exc.code)

        client = SdgbSyncClient(self.settings, http_post_fn=self._http_post_fn or http_post_full)
        try:
            preview = client.call_api(
                "GetUserPreviewApi",
                build_preview_data(int(user_id), token, client_id=self.settings.client_id),
                user_id,
            )
        except SdgbFullError as exc:
            return SdgbFullResult(status="FAILED", error_code=exc.code)

        # 小黑屋 / 封禁探测（不硬闯）
        ban_state = preview.get("banState")
        if ban_state not in (None, 0, "0"):
            try:
                if int(ban_state) >= 2:
                    return SdgbFullResult(status="FAILED", error_code="ACCOUNT_BANNED")
            except (TypeError, ValueError):
                pass
        if preview.get("isLogin"):
            return SdgbFullResult(status="FAILED", error_code="LOGIN_FAILED")

        try:
            profile = _profile_from_preview(preview)
        except SdgbFullError as exc:
            return SdgbFullResult(status="FAILED", error_code=exc.code)

        # 登录（捕获会话 cookie；回传登录时刻用于登出校验）
        login_ts = int(time.time())
        try:
            login_resp = client.call_api(
                "UserLoginApi",
                build_login_data(
                    int(user_id),
                    token,
                    timestamp=login_ts,
                    region_id=self.settings.region_id,
                    place_id=self.settings.place_id,
                    client_id=self.settings.client_id,
                ),
                user_id,
                capture_cookie=True,
            )
        except SdgbFullError as exc:
            return SdgbFullResult(status="FAILED", error_code=exc.code)
        if login_resp.get("returnCode") not in (1, 102):
            return SdgbFullResult(status="FAILED", error_code="LOGIN_FAILED")

        subject = self._subject(user_id)

        # 取完资料立即登出；失败则保留加密恢复上下文（LOGGING_OUT 作业状态）
        try:
            client.call_api(
                "UserLogoutApi",
                build_logout_data(
                    int(user_id),
                    timestamp=login_ts,
                    region_id=self.settings.region_id,
                    place_id=self.settings.place_id,
                    client_id=self.settings.client_id,
                ),
                user_id,
            )
        except Exception:
            context = encrypt_context(
                self.public_id_hmac_secret,
                {"userId": user_id, "loginTs": login_ts, "cookie": client.cookies},
            )
            return SdgbFullResult(
                status="LOGGING_OUT",
                subject=subject,
                profile=profile,
                encrypted_logout_context=context,
            )

        return SdgbFullResult(status="SUCCEEDED", subject=subject, profile=profile)

    def retry_pending_logout(self, encrypted_context: bytes) -> bool:
        try:
            data = decrypt_context(self.public_id_hmac_secret, encrypted_context)
        except SdgbFullError:
            return True  # 无法解密的上下文视为已处理，避免死循环
        user_id = str(data.get("userId") or "")
        login_ts = data.get("loginTs")
        cookie = data.get("cookie")
        if not user_id or login_ts is None:
            return True
        try:
            client = SdgbSyncClient(self.settings, http_post_fn=self._http_post_fn or http_post_full)
            client.call_api(
                "UserLogoutApi",
                build_logout_data(
                    int(user_id),
                    timestamp=int(login_ts),
                    region_id=self.settings.region_id,
                    place_id=self.settings.place_id,
                    client_id=self.settings.client_id,
                ),
                user_id,
                cookie=str(cookie) if cookie else None,
            )
            return True
        except Exception:
            return False

    def _subject(self, user_id: str) -> str:
        from .security import identity_subject

        return identity_subject(self.public_id_hmac_secret, user_id)