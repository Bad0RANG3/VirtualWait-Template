from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from urllib.parse import unquote

from .security import identity_subject


@dataclass(frozen=True)
class ProviderResult:
    status: str
    subject: str | None = None
    profile: dict[str, object] | None = None
    error_code: str | None = None
    encrypted_logout_context: bytes | None = None


class VerificationProvider(Protocol):
    def verify(self, qr_code: str) -> ProviderResult: ...

    def retry_pending_logout(self, encrypted_context: bytes) -> bool: ...


class MockVerificationProvider:
    """Deterministic, offline provider used for contract and service testing only."""

    def __init__(self, public_id_hmac_secret: str) -> None:
        self._public_id_hmac_secret = public_id_hmac_secret

    def verify(self, qr_code: str) -> ProviderResult:
        value = qr_code.strip()
        if value == "mock:processing":
            return ProviderResult(status="PROCESSING")
        if value.startswith("mock:fail:"):
            code = value.removeprefix("mock:fail:").strip()
            return ProviderResult(status="FAILED", error_code=code if code else "LOGIN_FAILED")
        pending_logout = value.startswith("mock:logout-pending/")
        if pending_logout:
            value = "mock:" + value.removeprefix("mock:logout-pending/")
        if not value.startswith("mock:"):
            return ProviderResult(status="FAILED", error_code="QR_EXCHANGE_FAILED")
        parts = value.split(":")
        if len(parts) < 3 or not parts[1]:
            return ProviderResult(status="FAILED", error_code="QR_EXCHANGE_FAILED")
        try:
            display_name = unquote(parts[2]).strip() or "Player"
            title = unquote(parts[4]).strip() if len(parts) > 4 else "VirtualWait Player"
        except Exception:
            return ProviderResult(status="FAILED", error_code="QR_EXCHANGE_FAILED")
        try:
            rating = int(parts[3]) if len(parts) > 3 and parts[3] else 12000
        except ValueError:
            rating = 12000
        profile = {
            "displayName": display_name[:80],
            "rating": min(max(rating, 0), 30000),
            "title": title[:200],
        }
        return ProviderResult(
            status="LOGGING_OUT" if pending_logout else "SUCCEEDED",
            subject=identity_subject(self._public_id_hmac_secret, parts[1]),
            profile=profile,
            # This fixture contains no user identifier or token. A real provider
            # must store only authenticated encryption output here.
            encrypted_logout_context=b"mock-pending-logout-v1" if pending_logout else None,
        )

    def retry_pending_logout(self, encrypted_context: bytes) -> bool:
        return encrypted_context == b"mock-pending-logout-v1"
