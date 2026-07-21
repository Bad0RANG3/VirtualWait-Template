from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
from urllib.parse import urlparse


class ConfigError(ValueError):
    """Raised when a gateway configuration is unsafe or incomplete."""


_HEADER_NAME = re.compile(r"^[A-Za-z0-9-]{1,80}$")


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ConfigError(f"{name} must be positive")
    return value


def _positive_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number") from exc
    if value <= 0:
        raise ConfigError(f"{name} must be positive")
    return value


def _secret(name: str, default: str, production: bool) -> str:
    value = os.getenv(name, default)
    if production and (value == default or len(value) < 32):
        raise ConfigError(f"{name} must be a unique value with at least 32 characters")
    return value


def _is_loopback_http(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "::1", "localhost"}


def _safe_provider_url(name: str, value: str, production: bool) -> str:
    parsed = urlparse(value)
    if not parsed.scheme or not parsed.netloc or parsed.username or parsed.password:
        raise ConfigError(f"{name} must be an absolute HTTP(S) URL without credentials")
    if parsed.scheme == "https":
        return value
    if _is_loopback_http(value):
        return value
    if parsed.scheme == "http" and not production:
        return value
    raise ConfigError(f"{name} must use HTTPS unless it is a loopback HTTP URL")


def _optional_header_name(name: str, default: str) -> str:
    value = os.getenv(name, default).strip()
    if not _HEADER_NAME.fullmatch(value):
        raise ConfigError(f"{name} must be a valid HTTP header name")
    if value.lower() in {"host", "content-length"}:
        raise ConfigError(f"{name} cannot override protected HTTP headers")
    return value


@dataclass(frozen=True)
class Settings:
    environment: str
    host: str
    port: int
    database_path: Path
    key_id: str
    shared_secret: str
    public_id_hmac_secret: str
    provider: str
    max_concurrent: int
    rate_limit_per_minute: int
    clock_skew_sec: int
    nonce_ttl_sec: int
    http_verify_url: str | None = None
    http_auth_header: str = "Authorization"
    http_auth_value: str = ""
    http_timeout_sec: float = 10.0
    # SDGB no-login preview provider (AiMe + GetUserPreviewApi).
    sdgb_aime_url: str | None = None
    sdgb_title_server_url: str | None = None
    sdgb_aime_salt: str = ""
    sdgb_aes_key: str = ""
    sdgb_aes_iv: str = ""
    sdgb_obfuscate_param: str = ""
    sdgb_keychip_id: str = ""
    sdgb_client_id: str = ""
    sdgb_timeout_sec: float = 10.0
    # Retry durable LOGGING_OUT jobs while the Gateway process remains alive.
    recovery_interval_sec: int = 5

    @property
    def production(self) -> bool:
        return self.environment == "production"

    @property
    def http_provider_requires_auth(self) -> bool:
        return bool(self.http_verify_url and not _is_loopback_http(self.http_verify_url))

    @classmethod
    def from_env(cls) -> "Settings":
        environment = os.getenv("VW_GATEWAY_ENV", "development")
        if environment not in {"development", "test", "production"}:
            raise ConfigError("VW_GATEWAY_ENV must be development, test, or production")
        production = environment == "production"
        provider = os.getenv("VW_GATEWAY_PROVIDER", "mock")
        if provider not in {"mock", "http", "sdgb_preview"}:
            raise ConfigError("VW_GATEWAY_PROVIDER must be mock, http, or sdgb_preview")
        if production and provider == "mock":
            raise ConfigError("VW_GATEWAY_PROVIDER=mock is not allowed in production")

        http_verify_url = None
        http_auth_header = _optional_header_name("VW_GATEWAY_HTTP_AUTH_HEADER", "Authorization")
        http_auth_value = os.getenv("VW_GATEWAY_HTTP_AUTH_VALUE", "")
        http_timeout_sec = _positive_float("VW_GATEWAY_HTTP_TIMEOUT_SEC", 10.0)
        if provider == "http":
            raw_url = os.getenv("VW_GATEWAY_HTTP_VERIFY_URL", "").strip()
            if not raw_url:
                raise ConfigError("VW_GATEWAY_HTTP_VERIFY_URL is required when VW_GATEWAY_PROVIDER=http")
            http_verify_url = _safe_provider_url("VW_GATEWAY_HTTP_VERIFY_URL", raw_url, production)
            if production and not _is_loopback_http(http_verify_url) and len(http_auth_value) < 32:
                raise ConfigError(
                    "VW_GATEWAY_HTTP_AUTH_VALUE must be set to a unique value with at least 32 characters for non-loopback production providers"
                )

        sdgb_aime_url = None
        sdgb_title_server_url = None
        sdgb_aime_salt = os.getenv("VW_SDGB_AIME_SALT", "")
        sdgb_aes_key = os.getenv("VW_SDGB_AES_KEY", "")
        sdgb_aes_iv = os.getenv("VW_SDGB_AES_IV", "")
        sdgb_obfuscate_param = os.getenv("VW_SDGB_OBFUSCATE_PARAM", "")
        sdgb_keychip_id = os.getenv("VW_SDGB_KEYCHIP_ID", "")
        sdgb_client_id = os.getenv("VW_SDGB_CLIENT_ID", "")
        sdgb_timeout_sec = _positive_float("VW_SDGB_TIMEOUT_SEC", 10.0)
        if provider == "sdgb_preview":
            raw_aime = os.getenv("VW_SDGB_AIME_URL", "").strip()
            raw_title = os.getenv("VW_SDGB_TITLE_SERVER_URL", "").strip()
            if not raw_aime or not raw_title:
                raise ConfigError(
                    "VW_SDGB_AIME_URL and VW_SDGB_TITLE_SERVER_URL are required when VW_GATEWAY_PROVIDER=sdgb_preview"
                )
            sdgb_aime_url = _safe_provider_url("VW_SDGB_AIME_URL", raw_aime, production)
            sdgb_title_server_url = _safe_provider_url(
                "VW_SDGB_TITLE_SERVER_URL", raw_title, production
            )
            required = {
                "VW_SDGB_AIME_SALT": sdgb_aime_salt,
                "VW_SDGB_AES_KEY": sdgb_aes_key,
                "VW_SDGB_AES_IV": sdgb_aes_iv,
                "VW_SDGB_OBFUSCATE_PARAM": sdgb_obfuscate_param,
                "VW_SDGB_KEYCHIP_ID": sdgb_keychip_id,
                "VW_SDGB_CLIENT_ID": sdgb_client_id,
            }
            missing = [name for name, value in required.items() if not value.strip()]
            if missing:
                raise ConfigError(
                    "Missing SDGB preview settings: " + ", ".join(missing)
                )

        return cls(
            environment=environment,
            host=os.getenv("VW_GATEWAY_HOST", "127.0.0.1"),
            port=_positive_int("VW_GATEWAY_PORT", 8787),
            database_path=Path(os.getenv("VW_GATEWAY_DATABASE_PATH", "./data/gateway.db")),
            key_id=os.getenv("VW_GATEWAY_KEY_ID", "template-web-1"),
            shared_secret=_secret(
                "VW_GATEWAY_SHARED_SECRET", "dev-gateway-secret", production
            ),
            public_id_hmac_secret=_secret(
                "VW_PUBLIC_ID_HMAC_SECRET",
                "dev-public-id-secret-change-me",
                production,
            ),
            provider=provider,
            max_concurrent=_positive_int("VW_GATEWAY_MAX_CONCURRENT", 3),
            rate_limit_per_minute=_positive_int("VW_GATEWAY_RATE_LIMIT_PER_MINUTE", 40),
            clock_skew_sec=_positive_int("VW_GATEWAY_CLOCK_SKEW_SEC", 300),
            nonce_ttl_sec=_positive_int("VW_GATEWAY_NONCE_TTL_SEC", 600),
            http_verify_url=http_verify_url,
            http_auth_header=http_auth_header,
            http_auth_value=http_auth_value,
            http_timeout_sec=http_timeout_sec,
            sdgb_aime_url=sdgb_aime_url,
            sdgb_title_server_url=sdgb_title_server_url,
            sdgb_aime_salt=sdgb_aime_salt,
            sdgb_aes_key=sdgb_aes_key,
            sdgb_aes_iv=sdgb_aes_iv,
            sdgb_obfuscate_param=sdgb_obfuscate_param,
            sdgb_keychip_id=sdgb_keychip_id,
            sdgb_client_id=sdgb_client_id,
            sdgb_timeout_sec=sdgb_timeout_sec,
            recovery_interval_sec=_positive_int("VW_GATEWAY_RECOVERY_INTERVAL_SEC", 5),
        )
