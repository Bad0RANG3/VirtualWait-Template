from __future__ import annotations

import json
import zlib
from typing import Any

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

from virtualwait_gateway.provider import SdgbPreviewVerificationProvider
from virtualwait_gateway.sdgb_preview import SdgbPreviewSettings
from virtualwait_gateway.security import identity_subject


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

    def fake_http_post_json(
        url: str,
        payload: dict[str, Any],
        *,
        headers: dict[str, str] | None = None,
        timeout_sec: float = 10.0,
        max_response_bytes: int = 64 * 1024,
    ) -> dict[str, Any]:
        calls.append(url)
        return {"userID": 424242, "token": "preview-token"}

    def fake_http_post(
        url: str,
        body: bytes,
        *,
        headers: dict[str, str] | None = None,
        timeout_sec: float = 10.0,
        max_response_bytes: int = 64 * 1024,
    ) -> tuple[int, bytes]:
        calls.append(url)
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
        return (200, encrypted)

    monkeypatch.setattr("virtualwait_gateway.sdgb_preview.http_post_json", fake_http_post_json)
    monkeypatch.setattr("virtualwait_gateway.sdgb_preview.http_post", fake_http_post)
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

    def fake_http_post_json(*args: object, **kwargs: object) -> dict[str, Any]:
        return {"errorID": 1, "key": "x", "timestamp": "0", "userID": -1, "token": ""}

    monkeypatch.setattr("virtualwait_gateway.sdgb_preview.http_post_json", fake_http_post_json)
    provider = SdgbPreviewVerificationProvider(settings, "public-secret")
    result = provider.verify("SGWCMAID" + ("B" * 56))
    assert result.status == "FAILED"
    assert result.error_code == "QR_EXPIRED"
