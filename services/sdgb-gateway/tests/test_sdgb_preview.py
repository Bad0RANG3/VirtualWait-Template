from __future__ import annotations

import json
import zlib
from typing import Any

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

from virtualwait_gateway.provider import SdgbPreviewVerificationProvider
from virtualwait_gateway.sdgb_preview import SdgbPreviewSettings
from virtualwait_gateway.security import identity_subject


class FakeHeaders(dict[str, str]):
    def get(self, key: str, default: Any = None) -> Any:  # noqa: ANN401
        return super().get(key, default)


class FakeResponse:
    status = 200

    def __init__(self, body: bytes) -> None:
        self.body = body
        self.headers = FakeHeaders({"Content-Length": str(len(body))})

    def read(self, size: int = -1) -> bytes:
        if size == -1:
            return self.body
        return self.body[:size]

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None


def _encrypt(key: str, iv: str, payload: dict[str, object]) -> bytes:
    plain = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    cipher = AES.new(key.encode("utf-8"), AES.MODE_CBC, iv.encode("utf-8"))
    return cipher.encrypt(pad(zlib.compress(plain), AES.block_size))


def test_sdgb_preview_provider_no_login_flow(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    calls: list[str] = []
    settings = SdgbPreviewSettings(
        aime_url="http://127.0.0.1:9/aime",
        title_server_url="https://example.test/Maimai2Servlet",
        aime_salt="salt",
        aes_key="0123456789abcdef",
        aes_iv="fedcba9876543210",
        obfuscate_param="param",
        keychip_id="A63E-01TEST",
        client_id="A63E01TEST",
        timeout_sec=2.0,
    )

    def fake_urlopen(request, timeout: float):  # type: ignore[no-untyped-def]
        calls.append(request.full_url)
        if "aime" in request.full_url:
            body = json.dumps({"userID": 424242, "token": "preview-token"}).encode("utf-8")
            return FakeResponse(body)
        encrypted = _encrypt(
            settings.aes_key,
            settings.aes_iv,
            {
                "userId": 424242,
                "userName": "预览玩家",
                "playerRating": 15000,
                "trophyId": 7,
                "banState": 0,
            },
        )
        return FakeResponse(encrypted)

    monkeypatch.setattr("virtualwait_gateway.sdgb_preview.urlopen", fake_urlopen)
    provider = SdgbPreviewVerificationProvider(settings, "public-secret")
    result = provider.verify("SGWCMAID" + ("A" * 56))

    assert result.status == "SUCCEEDED"
    assert result.subject == identity_subject("public-secret", "424242")
    assert result.profile == {"displayName": "预览玩家", "rating": 15000, "title": "#7"}
    assert len(calls) == 2
    assert "UserLoginApi" not in "".join(calls)


def test_sdgb_preview_expired_qr(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    settings = SdgbPreviewSettings(
        aime_url="http://127.0.0.1:9/aime",
        title_server_url="https://example.test/Maimai2Servlet",
        aime_salt="salt",
        aes_key="0123456789abcdef",
        aes_iv="fedcba9876543210",
        obfuscate_param="param",
        keychip_id="A63E-01TEST",
        client_id="A63E01TEST",
        timeout_sec=2.0,
    )

    def fake_urlopen(request, timeout: float):  # type: ignore[no-untyped-def]
        body = json.dumps(
            {"errorID": 1, "key": "x", "timestamp": "0", "userID": -1, "token": ""}
        ).encode("utf-8")
        return FakeResponse(body)

    monkeypatch.setattr("virtualwait_gateway.sdgb_preview.urlopen", fake_urlopen)
    provider = SdgbPreviewVerificationProvider(settings, "public-secret")
    result = provider.verify("SGWCMAID" + ("B" * 56))
    assert result.status == "FAILED"
    assert result.error_code == "QR_EXPIRED"
