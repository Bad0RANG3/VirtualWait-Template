from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import unquote
from urllib.request import Request, urlopen

from .security import identity_subject
from .sdgb_preview import SdgbPreviewError, SdgbPreviewSettings, preview_from_qr


_SUBJECT = re.compile(r"^[a-f0-9]{64}$")
_ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024


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


def _safe_error_code(value: object, default: str = "QR_EXCHANGE_FAILED") -> str:
    if isinstance(value, str):
        normalized = value.strip().upper()
        if _ERROR_CODE.fullmatch(normalized):
            return normalized
    return default


def _read_json_response(response: Any) -> Any:
    content_length = response.headers.get("Content-Length")
    if content_length and int(content_length) > _MAX_PROVIDER_RESPONSE_BYTES:
        raise ValueError("provider response too large")
    body = response.read(_MAX_PROVIDER_RESPONSE_BYTES + 1)
    if len(body) > _MAX_PROVIDER_RESPONSE_BYTES:
        raise ValueError("provider response too large")
    return json.loads(body.decode("utf-8"))


def _coerce_rating(value: object) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    try:
        rating = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return min(max(rating, 0), 30000)


def _coerce_text(value: object, max_len: int) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    return text[:max_len]


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


class HttpVerificationProvider:
    """Adapter for an operator-owned real QR verification HTTP service.

    The upstream endpoint receives ``{"qrCode": "..."}`` and must return JSON.
    Supported success response shapes:

    - ``{"status":"SUCCEEDED","identityId":"stable-private-id","profile":{"displayName":"...","rating":12345,"title":"..."}}``
    - ``{"status":"SUCCEEDED","identitySubject":"<64 hex>","profile":{...}}``
    - ``{"identityId":"stable-private-id","displayName":"...","rating":12345,"title":"..."}``

    Raw upstream identifiers are converted to VirtualWait subjects with HMAC
    before they leave the gateway. The raw QR code and full upstream response are
    never persisted by this adapter.
    """

    def __init__(
        self,
        verify_url: str,
        public_id_hmac_secret: str,
        auth_header: str = "Authorization",
        auth_value: str = "",
        timeout_sec: float = 10.0,
    ) -> None:
        self._verify_url = verify_url
        self._public_id_hmac_secret = public_id_hmac_secret
        self._auth_header = auth_header
        self._auth_value = auth_value
        self._timeout_sec = timeout_sec

    def verify(self, qr_code: str) -> ProviderResult:
        request_body = json.dumps({"qrCode": qr_code}, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "VirtualWaitGateway/0.1",
        }
        if self._auth_value:
            headers[self._auth_header] = self._auth_value
        request = Request(self._verify_url, data=request_body, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=self._timeout_sec) as response:  # noqa: S310 - URL is operator-configured and validated.
                if getattr(response, "status", 200) >= 400:
                    return ProviderResult(status="FAILED", error_code="QR_EXCHANGE_FAILED")
                payload = _read_json_response(response)
        except HTTPError as exc:
            error_code = "QR_EXCHANGE_FAILED"
            try:
                payload = _read_json_response(exc)
                if isinstance(payload, dict):
                    error_code = _safe_error_code(payload.get("errorCode") or payload.get("code"))
            except Exception:
                pass
            return ProviderResult(status="FAILED", error_code=error_code)
        except (TimeoutError, URLError):
            return ProviderResult(status="FAILED", error_code="UPSTREAM_TIMEOUT")
        except Exception:
            return ProviderResult(status="FAILED", error_code="UPSTREAM_PROTOCOL_ERROR")
        return self._parse_payload(payload)

    def _parse_payload(self, payload: Any) -> ProviderResult:
        if not isinstance(payload, dict):
            return ProviderResult(status="FAILED", error_code="UPSTREAM_PROTOCOL_ERROR")
        status = str(payload.get("status", "SUCCEEDED")).strip().upper()
        if status == "FAILED":
            return ProviderResult(status="FAILED", error_code=_safe_error_code(payload.get("errorCode") or payload.get("code")))
        if status in {"PROCESSING", "LOGGING_OUT"}:
            return ProviderResult(status=status)
        if status not in {"SUCCEEDED", "OK"}:
            return ProviderResult(status="FAILED", error_code="UPSTREAM_PROTOCOL_ERROR")

        profile_source = payload.get("profile") if isinstance(payload.get("profile"), dict) else payload
        assert isinstance(profile_source, dict)
        display_name = (
            _coerce_text(profile_source.get("displayName"), 80)
            or _coerce_text(profile_source.get("playerName"), 80)
            or _coerce_text(profile_source.get("name"), 80)
        )
        if not display_name:
            return ProviderResult(status="FAILED", error_code="PROFILE_INCOMPLETE")
        profile: dict[str, object] = {"displayName": display_name}
        rating = _coerce_rating(profile_source.get("rating"))
        if rating is not None:
            profile["rating"] = rating
        title = _coerce_text(profile_source.get("title"), 200)
        if title is not None:
            profile["title"] = title

        raw_subject = payload.get("identitySubject") or payload.get("subject")
        if isinstance(raw_subject, str) and _SUBJECT.fullmatch(raw_subject):
            subject = raw_subject
        else:
            identity_id = (
                payload.get("identityId")
                or payload.get("userId")
                or payload.get("aimeId")
                or payload.get("id")
            )
            if identity_id is None:
                return ProviderResult(status="FAILED", error_code="IDENTITY_INCOMPLETE")
            subject = identity_subject(self._public_id_hmac_secret, str(identity_id))
        return ProviderResult(status="SUCCEEDED", subject=subject, profile=profile)

    def retry_pending_logout(self, encrypted_context: bytes) -> bool:
        # The generic HTTP adapter is synchronous and does not create durable
        # LOGGING_OUT records. Provider-specific logout recovery should be added
        # only when the upstream contract is known.
        return False


class SdgbPreviewVerificationProvider:
    """No-login SDGB QR provider: AiMe QR exchange + GetUserPreviewApi.

    This intentionally avoids UserLoginApi / UserLogoutApi so queue login does
    not occupy a cabinet session. Only public display fields leave the gateway.
    """

    def __init__(self, settings: SdgbPreviewSettings, public_id_hmac_secret: str) -> None:
        self._settings = settings
        self._public_id_hmac_secret = public_id_hmac_secret

    def verify(self, qr_code: str) -> ProviderResult:
        try:
            profile = preview_from_qr(self._settings, qr_code)
        except SdgbPreviewError as exc:
            return ProviderResult(status="FAILED", error_code=exc.code)
        except Exception:
            return ProviderResult(status="FAILED", error_code="UPSTREAM_PROTOCOL_ERROR")

        public_profile: dict[str, object] = {"displayName": profile.display_name}
        if profile.rating is not None:
            public_profile["rating"] = profile.rating
        if profile.title is not None:
            public_profile["title"] = profile.title
        return ProviderResult(
            status="SUCCEEDED",
            subject=identity_subject(self._public_id_hmac_secret, profile.user_id),
            profile=public_profile,
        )

    def retry_pending_logout(self, encrypted_context: bytes) -> bool:
        # Preview path never creates a cabinet login session.
        return True

