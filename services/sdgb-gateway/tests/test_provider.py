from __future__ import annotations

from typing import Any

from virtualwait_gateway.provider import HttpVerificationProvider
from virtualwait_gateway.security import identity_subject


def test_http_provider_posts_qr_and_hashes_identity(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    captured: dict[str, object] = {}

    def fake_http_post_json(
        url: str,
        payload: dict[str, Any],
        *,
        headers: dict[str, str] | None = None,
        timeout_sec: float = 10.0,
        max_response_bytes: int = 32 * 1024,
    ) -> dict[str, Any]:
        captured["url"] = url
        captured["timeout"] = timeout_sec
        captured["payload"] = payload
        captured["headers"] = headers or {}
        return {
            "status": "SUCCEEDED",
            "identityId": "private-upstream-user-id",
            "profile": {"displayName": "  Test Player  ", "rating": "12345", "title": "覇者"},
        }

    monkeypatch.setattr(
        "virtualwait_gateway.provider.http_post_json", fake_http_post_json
    )
    provider = HttpVerificationProvider(
        "https://verifier.example.test/verify",
        "public-secret",
        auth_value="Bearer test-token",
        timeout_sec=3.5,
    )

    result = provider.verify("real-qr-content")

    assert captured["url"] == "https://verifier.example.test/verify"
    assert captured["timeout"] == 3.5
    assert captured["headers"].get("Authorization") == "Bearer test-token"
    assert captured["payload"] == {"qrCode": "real-qr-content"}
    assert result.status == "SUCCEEDED"
    assert result.subject == identity_subject("public-secret", "private-upstream-user-id")
    assert result.profile == {"displayName": "Test Player", "rating": 12345, "title": "覇者"}


def test_http_provider_accepts_prehashed_identity_subject(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    subject = "a" * 64

    def fake_http_post_json(*args: object, **kwargs: object) -> dict[str, Any]:
        return {"identitySubject": subject, "displayName": "Player"}

    monkeypatch.setattr(
        "virtualwait_gateway.provider.http_post_json", fake_http_post_json
    )
    provider = HttpVerificationProvider("https://verifier.example.test/verify", "public-secret")

    result = provider.verify("real-qr-content")

    assert result.status == "SUCCEEDED"
    assert result.subject == subject
    assert result.profile == {"displayName": "Player"}


def test_http_provider_fails_closed_on_incomplete_profile(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    def fake_http_post_json(*args: object, **kwargs: object) -> dict[str, Any]:
        return {"identityId": "user-without-name"}

    monkeypatch.setattr(
        "virtualwait_gateway.provider.http_post_json", fake_http_post_json
    )
    provider = HttpVerificationProvider("https://verifier.example.test/verify", "public-secret")

    result = provider.verify("real-qr-content")

    assert result.status == "FAILED"
    assert result.error_code == "PROFILE_INCOMPLETE"
