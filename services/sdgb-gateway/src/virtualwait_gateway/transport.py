"""Safe HTTP transport without redirects, bounded reads, and typed errors.

Replaces scattered ``urllib.request.urlopen`` calls across the Gateway so every
upstream request is subject to the same safeguards:

* Never follows 3xx redirects (avoids SSRF / credential forwarding risk).
* Enforces a configurable response-size cap and rejects oversized replies.
* Normalises URLError / HTTPError / TimeoutError into typed exceptions.
* Always uses Python's default TLS certificate verification.

All HTTP-fetching code outside this module must go through :func:`http_post` or
:func:`http_post_json` — no direct ``urlopen`` calls.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import (
    HTTPSHandler,
    HTTPRedirectHandler,
    Request,
    build_opener,
)

__all__ = [
    "TransportError",
    "http_post",
    "http_post_json",
    "DEFAULT_MAX_RESPONSE_BYTES",
]

DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024
DEFAULT_TIMEOUT_SEC = 10.0


class TransportError(OSError):
    """Raised for every upstream transport failure."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


# ---------------------------------------------------------------------------
# Redirect handler that **never** follows a redirect.  A 3xx response is
# treated as a success (the calling code can inspect the status), but the
# transport will not issue a follow-up request to the ``Location`` header.
# ---------------------------------------------------------------------------


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(  # type: ignore[override]
        self,
        req: Request,
        fp: object,
        code: int,
        msg: str,
        hdrs: object,
        newurl: str,
    ) -> None:
        return None


# Singleton opener: HTTPS only, no redirects.
_NO_REDIRECT_OPENER = build_opener(_NoRedirectHandler(), HTTPSHandler())


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def http_post(
    url: str,
    body: bytes,
    *,
    headers: dict[str, str] | None = None,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
) -> tuple[int, bytes]:
    """POST *body* to *url* and return ``(status_code, response_bytes)``.

    Redirects are **never** followed.  The response body is read in a bounded
    fashion — if it exceeds *max_response_bytes* the call raises
    :exc:`TransportError("UPSTREAM_PROTOCOL_ERROR")`.
    """
    req_headers: dict[str, str] = {
        "Accept": "application/json",
        "User-Agent": "VirtualWaitGateway/0.1",
    }
    if headers:
        req_headers.update(headers)
    request = Request(url, data=body, headers=req_headers, method="POST")

    try:
        with _NO_REDIRECT_OPENER.open(request, timeout=timeout_sec) as response:
            status = getattr(response, "status", 200)
            raw = _read_bounded(response, max_response_bytes)
            return int(status), raw
    except HTTPError as exc:
        # Drain the error body (bounded) so the connection can be reused.
        try:
            _read_bounded(exc, max_response_bytes)
        except TransportError:
            pass
        raise TransportError("QR_EXCHANGE_FAILED") from exc
    except (TimeoutError, URLError) as exc:
        raise TransportError("UPSTREAM_TIMEOUT") from exc
    except TransportError:
        raise
    except Exception as exc:
        raise TransportError("UPSTREAM_PROTOCOL_ERROR") from exc


def http_post_json(
    url: str,
    payload: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
    timeout_sec: float = DEFAULT_TIMEOUT_SEC,
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
) -> dict[str, Any]:
    """Convenience wrapper that serialises *payload* to JSON and parses the response.

    Redirects are never followed.
    Raises :exc:`TransportError` on transport / parse / size failures.
    """
    body = (
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        .encode("utf-8")
    )
    json_headers: dict[str, str] = {
        "Content-Type": "application/json; charset=utf-8",
    }
    if headers:
        json_headers.update(headers)
    status, raw = http_post(
        url,
        body,
        headers=json_headers,
        timeout_sec=timeout_sec,
        max_response_bytes=max_response_bytes,
    )
    if status >= 400:
        raise TransportError("QR_EXCHANGE_FAILED")
    return _parse_json(raw)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _read_bounded(response: object, max_bytes: int) -> bytes:
    """Read at most *max_bytes* + 1 from *response*; raise if exceeded."""
    content_length = _header_int(response, "Content-Length")
    if content_length is not None and content_length > max_bytes:
        raise TransportError("UPSTREAM_PROTOCOL_ERROR")
    raw = _call_read(response, max_bytes + 1)
    if len(raw) > max_bytes:
        raise TransportError("UPSTREAM_PROTOCOL_ERROR")
    return raw


def _call_read(response: object, size: int) -> bytes:
    return response.read(size)  # type: ignore[no-any-return]


def _header_int(response: object, name: str) -> int | None:
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    get = getattr(headers, "get", None)
    if get is None:
        return None
    raw = get(name)
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _parse_json(raw: bytes) -> dict[str, Any]:
    try:
        decoded = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise TransportError("UPSTREAM_PROTOCOL_ERROR") from exc
    try:
        parsed = json.loads(decoded)
    except json.JSONDecodeError as exc:
        raise TransportError("UPSTREAM_PROTOCOL_ERROR") from exc
    if not isinstance(parsed, dict):
        raise TransportError("UPSTREAM_PROTOCOL_ERROR")
    return parsed
