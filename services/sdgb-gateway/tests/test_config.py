from __future__ import annotations

import pytest

from virtualwait_gateway.config import ConfigError, Settings


def test_production_startup_is_disabled_without_a_reviewed_real_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VW_GATEWAY_ENV", "production")
    monkeypatch.setenv("VW_GATEWAY_SHARED_SECRET", "a" * 32)
    monkeypatch.setenv("VW_PUBLIC_ID_HMAC_SECRET", "b" * 32)
    with pytest.raises(ConfigError, match="production startup is disabled"):
        Settings.from_env()


def test_recovery_interval_must_be_positive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VW_GATEWAY_RECOVERY_INTERVAL_SEC", "0")
    with pytest.raises(ConfigError, match="VW_GATEWAY_RECOVERY_INTERVAL_SEC must be positive"):
        Settings.from_env()
