from __future__ import annotations

import hashlib
import hmac
import re
import time
from typing import Mapping

from .config import Settings


class AuthenticationError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


NONCE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


def sha256_hex(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def canonical_request(method: str, path_and_query: str, timestamp: str, nonce: str, body: bytes) -> bytes:
    return "\n".join(
        [method.upper(), path_and_query, timestamp, nonce, sha256_hex(body)]
    ).encode("utf-8")


def request_signature(secret: str, method: str, path_and_query: str, timestamp: str, nonce: str, body: bytes) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        canonical_request(method, path_and_query, timestamp, nonce, body),
        hashlib.sha256,
    ).hexdigest()


def identity_subject(secret: str, user_id: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        f"sdgb-user:{user_id}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def verify_signed_request(
    settings: Settings,
    repository: object,
    method: str,
    path_and_query: str,
    headers: Mapping[str, str],
    body: bytes,
    now: int | None = None,
) -> None:
    normalized = {key.lower(): value for key, value in headers.items()}
    key_id = normalized.get("x-vw-key-id", "")
    timestamp = normalized.get("x-vw-timestamp", "")
    nonce = normalized.get("x-vw-nonce", "")
    body_hash = normalized.get("x-vw-body-sha256", "")
    signature = normalized.get("x-vw-signature", "")
    if key_id != settings.key_id or not NONCE.fullmatch(nonce):
        raise AuthenticationError("INVALID_SIGNATURE")
    try:
        sent_at = int(timestamp)
    except ValueError as exc:
        raise AuthenticationError("INVALID_SIGNATURE") from exc
    current = int(time.time()) if now is None else now
    if abs(current - sent_at) > settings.clock_skew_sec:
        raise AuthenticationError("INVALID_SIGNATURE")
    if not hmac.compare_digest(body_hash, sha256_hex(body)):
        raise AuthenticationError("INVALID_SIGNATURE")
    expected = request_signature(settings.shared_secret, method, path_and_query, timestamp, nonce, body)
    if not hmac.compare_digest(signature, expected):
        raise AuthenticationError("INVALID_SIGNATURE")
    # The repository stores only a hash of the nonce and atomically rejects reuse.
    if not repository.claim_nonce(nonce, current + settings.nonce_ttl_sec, current):
        raise AuthenticationError("REPLAY_DETECTED")
