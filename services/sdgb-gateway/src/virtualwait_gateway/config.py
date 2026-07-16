from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


class ConfigError(ValueError):
    """Raised when a gateway configuration is unsafe or incomplete."""


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


def _secret(name: str, default: str, production: bool) -> str:
    value = os.getenv(name, default)
    if production and (value == default or len(value) < 32):
        raise ConfigError(f"{name} must be a unique value with at least 32 characters")
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
    # Retry durable LOGGING_OUT jobs while the Gateway process remains alive.
    recovery_interval_sec: int = 5

    @property
    def production(self) -> bool:
        return self.environment == "production"

    @classmethod
    def from_env(cls) -> "Settings":
        environment = os.getenv("VW_GATEWAY_ENV", "development")
        if environment not in {"development", "test", "production"}:
            raise ConfigError("VW_GATEWAY_ENV must be development, test, or production")
        production = environment == "production"
        provider = os.getenv("VW_GATEWAY_PROVIDER", "mock")
        # A real provider is deliberately not silently enabled by configuration.
        if provider != "mock":
            raise ConfigError("VW_GATEWAY_PROVIDER=mock is the only implemented provider")
        if production:
            raise ConfigError(
                "production startup is disabled until a reviewed real verification provider is implemented"
            )
        return cls(
            environment=environment,
            host=os.getenv("VW_GATEWAY_HOST", "127.0.0.1"),
            port=_positive_int("VW_GATEWAY_PORT", 8787),
            database_path=Path(os.getenv("VW_GATEWAY_DATABASE_PATH", "./data/gateway.db")),
            key_id=os.getenv("VW_GATEWAY_KEY_ID", "dev-web-1"),
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
            recovery_interval_sec=_positive_int("VW_GATEWAY_RECOVERY_INTERVAL_SEC", 5),
        )
