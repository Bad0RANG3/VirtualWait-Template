from __future__ import annotations

import pytest

from virtualwait_gateway.config import ConfigError, Settings


def test_production_startup_rejects_mock_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VW_GATEWAY_ENV", "production")
    monkeypatch.setenv("VW_GATEWAY_SHARED_SECRET", "a" * 32)
    monkeypatch.setenv("VW_PUBLIC_ID_HMAC_SECRET", "b" * 32)
    monkeypatch.setenv("VW_GATEWAY_PROVIDER", "mock")
    with pytest.raises(ConfigError, match="mock is not allowed"):
        Settings.from_env()


def test_production_http_provider_requires_url_and_accepts_https(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VW_GATEWAY_ENV", "production")
    monkeypatch.setenv("VW_GATEWAY_SHARED_SECRET", "a" * 32)
    monkeypatch.setenv("VW_PUBLIC_ID_HMAC_SECRET", "b" * 32)
    monkeypatch.setenv("VW_GATEWAY_PROVIDER", "http")
    monkeypatch.setenv("VW_GATEWAY_HTTP_VERIFY_URL", "https://verifier.example.test/verify")
    monkeypatch.setenv("VW_GATEWAY_HTTP_AUTH_VALUE", "Bearer " + "c" * 32)

    settings = Settings.from_env()

    assert settings.provider == "http"
    assert settings.http_verify_url == "https://verifier.example.test/verify"


def test_production_http_provider_rejects_plain_remote_http(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VW_GATEWAY_ENV", "production")
    monkeypatch.setenv("VW_GATEWAY_SHARED_SECRET", "a" * 32)
    monkeypatch.setenv("VW_PUBLIC_ID_HMAC_SECRET", "b" * 32)
    monkeypatch.setenv("VW_GATEWAY_PROVIDER", "http")
    monkeypatch.setenv("VW_GATEWAY_HTTP_VERIFY_URL", "http://verifier.example.test/verify")
    monkeypatch.setenv("VW_GATEWAY_HTTP_AUTH_VALUE", "Bearer " + "c" * 32)

    with pytest.raises(ConfigError, match="must use HTTPS"):
        Settings.from_env()


def test_recovery_interval_must_be_positive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VW_GATEWAY_RECOVERY_INTERVAL_SEC", "0")
    with pytest.raises(ConfigError, match="VW_GATEWAY_RECOVERY_INTERVAL_SEC must be positive"):
        Settings.from_env()



def test_sdgb_preview_provider_requires_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VW_GATEWAY_ENV", "development")
    monkeypatch.setenv("VW_GATEWAY_PROVIDER", "sdgb_preview")
    monkeypatch.delenv("VW_SDGB_AIME_URL", raising=False)
    with pytest.raises(ConfigError, match="VW_SDGB_AIME_URL"):
        Settings.from_env()


def test_sdgb_preview_provider_accepts_complete_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VW_GATEWAY_ENV", "development")
    monkeypatch.setenv("VW_GATEWAY_PROVIDER", "sdgb_preview")
    monkeypatch.setenv("VW_SDGB_AIME_URL", "http://127.0.0.1:9/aime")
    monkeypatch.setenv("VW_SDGB_TITLE_SERVER_URL", "https://example.test/Maimai2Servlet")
    monkeypatch.setenv("VW_SDGB_AIME_SALT", "salt")
    monkeypatch.setenv("VW_SDGB_AES_KEY", "0123456789abcdef")
    monkeypatch.setenv("VW_SDGB_AES_IV", "fedcba9876543210")
    monkeypatch.setenv("VW_SDGB_OBFUSCATE_PARAM", "param")
    monkeypatch.setenv("VW_SDGB_KEYCHIP_ID", "A63E-01TEST")
    monkeypatch.setenv("VW_SDGB_CLIENT_ID", "A63E01TEST")
    settings = Settings.from_env()
    assert settings.provider == "sdgb_preview"
    assert settings.sdgb_keychip_id == "A63E-01TEST"
