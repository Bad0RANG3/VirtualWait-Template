from __future__ import annotations

import json
from typing import Any

from virtualwait_gateway.provider import HttpVerificationProvider
from virtualwait_gateway.security import identity_subject


class FakeHeaders(dict[str, str]):
    def get(self, key: str, default: Any = None) -> Any:  # noqa: ANN401
        return super().get(key, default)


class FakeResponse:
    status = 200

    def __init__(self, payload: dict[str, object]) -> None:
        self.body = json.dumps(payload).encode("utf-8")
        self.headers = FakeHeaders({"Content-Length": str(len(self.body))})

    def read(self, size: int = -1) -> bytes:
        if size == -1:
            return self.body
        return self.body[:size]

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None


def test_http_provider_posts_qr_and_hashes_identity(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout: float):  # type: ignore[no-untyped-def]
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["body"] = request.data
        captured["auth"] = request.headers.get("Authorization")
        return FakeResponse(
            {
                "status": "SUCCEEDED",
                "identityId": "private-upstream-user-id",
                "profile": {"displayName": "  Test Player  ", "rating": "12345", "title": "覇者"},
            }
        )

    monkeypatch.setattr("virtualwait_gateway.provider.urlopen", fake_urlopen)
    provider = HttpVerificationProvider(
        "https://verifier.example.test/verify",
        "public-secret",
        auth_value="Bearer test-token",
        timeout_sec=3.5,
    )

    result = provider.verify("real-qr-content")

    assert captured["url"] == "https://verifier.example.test/verify"
    assert captured["timeout"] == 3.5
    assert captured["auth"] == "Bearer test-token"
    assert json.loads(captured["body"]) == {"qrCode": "real-qr-content"}
    assert result.status == "SUCCEEDED"
    assert result.subject == identity_subject("public-secret", "private-upstream-user-id")
    assert result.profile == {"displayName": "Test Player", "rating": 12345, "title": "覇者"}


def test_http_provider_accepts_prehashed_identity_subject(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    subject = "a" * 64

    def fake_urlopen(request, timeout: float):  # type: ignore[no-untyped-def]
        return FakeResponse({"identitySubject": subject, "displayName": "Player"})

    monkeypatch.setattr("virtualwait_gateway.provider.urlopen", fake_urlopen)
    provider = HttpVerificationProvider("https://verifier.example.test/verify", "public-secret")

    result = provider.verify("real-qr-content")

    assert result.status == "SUCCEEDED"
    assert result.subject == subject
    assert result.profile == {"displayName": "Player"}


def test_http_provider_fails_closed_on_incomplete_profile(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    def fake_urlopen(request, timeout: float):  # type: ignore[no-untyped-def]
        return FakeResponse({"identityId": "user-without-name"})

    monkeypatch.setattr("virtualwait_gateway.provider.urlopen", fake_urlopen)
    provider = HttpVerificationProvider("https://verifier.example.test/verify", "public-secret")

    result = provider.verify("real-qr-content")

    assert result.status == "FAILED"
    assert result.error_code == "PROFILE_INCOMPLETE"
