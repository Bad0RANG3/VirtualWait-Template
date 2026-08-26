from __future__ import annotations

import json
import zlib
from typing import Any

import pytest

from virtualwait_gateway.sdgb_full import (
    SdgbFullSettings,
    SdgbFullVerificationService,
    encrypt_context,
    decrypt_context,
)
from virtualwait_gateway.security import identity_subject
from sdgb.encrypt import aes_pkcs7


SETTINGS = SdgbFullSettings(
    aime_url="http://127.0.0.1:9000/wc_aime/api/get_data",
    title_server_url="https://maimai-gm.wahlap.com:42081/Maimai2Servlet",
    aime_salt="aime-salt",
    aes_key="0123456789abcdef",
    aes_iv="fedcba9876543210",
    obfuscate_param="obfuscate",
    keychip_id="KEYCHIP-1",
    client_id="CLIENT-1",
    region_id=1403,
    place_id=1,
    timeout_sec=2.0,
)
SECRET = "test-public-id-secret-012345678901234567"


class FakeUpstream:
    """Fake AiMe + title server that decrypts requests and returns canned JSON."""

    def __init__(self) -> None:
        self.aes = aes_pkcs7(SETTINGS.aes_key, SETTINGS.aes_iv)
        self.calls: list[str] = []
        self.login_return_code: int | None = 1
        self.preview_payload: dict[str, Any] = {
            "userName": "Test Player",
            "playerRating": 12345,
            "trophyId": 8,
            "isLogin": 0,
            "banState": 0,
        }
        self.logout_ok = True
        self.set_cookie = "JSESSIONID=abc123; Path=/"

    # AiMe endpoint
    def http_post_json(
        self,
        url: str,
        payload: dict[str, Any],
        *,
        headers: dict[str, str] | None = None,
        timeout_sec: float = 10.0,
        max_response_bytes: int | None = None,
    ) -> dict[str, Any]:
        self.calls.append("aime:" + url)
        return {"userID": 123, "token": "TOKEN123"}

    # Title server endpoint
    def http_post(
        self,
        url: str,
        body: bytes,
        *,
        headers: dict[str, str] | None = None,
        timeout_sec: float = 10.0,
        max_response_bytes: int | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        data = self._decrypt(body)
        if "delayLog" in data:
            self.calls.append("logout")
            if not self.logout_ok:
                raise TimeoutError("simulated logout failure")
            return 200, {}, self._encrypt({"returnCode": 1})
        if "loginDateTime" in data:
            self.calls.append("login")
            response_headers = {"Set-Cookie": self.set_cookie} if self.set_cookie else {}
            return 200, response_headers, self._encrypt({"returnCode": self.login_return_code})
        self.calls.append("preview")
        return 200, {}, self._encrypt(self.preview_payload)

    def _encrypt(self, data: dict[str, Any]) -> bytes:
        plaintext = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return self.aes.encrypt(zlib.compress(plaintext))

    def _decrypt(self, raw: bytes) -> dict[str, Any]:
        plaintext = zlib.decompress(self.aes.decrypt(raw)).decode("utf-8")
        return json.loads(plaintext)


def make_service(fake: FakeUpstream) -> SdgbFullVerificationService:
    return SdgbFullVerificationService(
        SETTINGS,
        SECRET,
        http_post_json_fn=fake.http_post_json,
        http_post_fn=fake.http_post,
    )


def test_sdgb_full_success_logs_in_and_out() -> None:
    fake = FakeUpstream()
    result = make_service(fake).verify("SGWCMAID00000000000000000000000000000000000000000000000000000000000000")

    assert result.status == "SUCCEEDED"
    assert result.subject == identity_subject(SECRET, "123")
    assert result.profile == {"displayName": "Test Player", "rating": 12345, "title": "#8"}
    assert fake.calls == ["aime:http://127.0.0.1:9000/wc_aime/api/get_data", "preview", "login", "logout"]


def test_sdgb_full_rejects_islogin_blacklisted() -> None:
    fake = FakeUpstream()
    fake.preview_payload = {**fake.preview_payload, "isLogin": 1}
    result = make_service(fake).verify("SGWCMAID00000000000000000000000000000000000000000000000000000000000000")

    assert result.status == "FAILED"
    assert result.error_code == "LOGIN_FAILED"
    assert "login" not in fake.calls


def test_sdgb_full_rejects_hard_ban() -> None:
    fake = FakeUpstream()
    fake.preview_payload = {**fake.preview_payload, "banState": 2}
    result = make_service(fake).verify("SGWCMAID00000000000000000000000000000000000000000000000000000000000000")

    assert result.status == "FAILED"
    assert result.error_code == "ACCOUNT_BANNED"


def test_sdgb_full_login_failure() -> None:
    fake = FakeUpstream()
    fake.login_return_code = 99
    result = make_service(fake).verify("SGWCMAID00000000000000000000000000000000000000000000000000000000000000")

    assert result.status == "FAILED"
    assert result.error_code == "LOGIN_FAILED"


def test_sdgb_full_logout_failure_becomes_logging_out_and_recovers() -> None:
    fake = FakeUpstream()
    fake.logout_ok = False
    service = make_service(fake)
    result = service.verify("SGWCMAID00000000000000000000000000000000000000000000000000000000000000")

    assert result.status == "LOGGING_OUT"
    assert result.subject == identity_subject(SECRET, "123")
    assert result.encrypted_logout_context is not None
    # 数据库中不得出现明文 token / userId
    assert b"TOKEN123" not in result.encrypted_logout_context

    # 第一次重试仍失败 -> False；恢复后可成功
    fake.logout_ok = False
    assert service.retry_pending_logout(result.encrypted_logout_context) is False
    fake.logout_ok = True
    assert service.retry_pending_logout(result.encrypted_logout_context) is True


def test_context_roundtrip_encrypted() -> None:
    ctx = encrypt_context(SECRET, {"userId": "123", "loginTs": 1000, "cookie": None})
    assert decrypt_context(SECRET, ctx) == {"userId": "123", "loginTs": 1000, "cookie": None}
    with pytest.raises(Exception):
        decrypt_context("wrong-secret", ctx)


def test_sdgb_full_rejects_short_qr() -> None:
    fake = FakeUpstream()
    result = make_service(fake).verify("short")
    assert result.status == "FAILED"