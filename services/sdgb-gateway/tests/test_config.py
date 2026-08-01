from __future__ import annotations

from pathlib import Path

import pytest

from virtualwait_gateway.config import ConfigError, Settings


def _prod_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VW_GATEWAY_ENV", "production")
    monkeypatch.setenv("VW_GATEWAY_SHARED_SECRET", "a" * 32)
    monkeypatch.setenv("VW_PUBLIC_ID_HMAC_SECRET", "b" * 32)
    monkeypatch.setenv("VW_GATEWAY_KEY_ID", "my-deployment-web-1")
    # POSIX-style "/var/..." is NOT absolute on Windows, so derive one that
    # Path.is_absolute() accepts on every platform.
    monkeypatch.setenv("VW_GATEWAY_DATABASE_PATH", str(Path.home() / "vw" / "gateway.db"))
    # A valid non-mock provider, so the checks under test are reached instead
    # of short-circuiting on VW_GATEWAY_PROVIDER=mock.
    monkeypatch.setenv("VW_GATEWAY_PROVIDER", "http")
    monkeypatch.setenv("VW_GATEWAY_HTTP_VERIFY_URL", "https://verifier.example.test/verify")
    monkeypatch.setenv("VW_GATEWAY_HTTP_AUTH_VALUE", "Bearer " + "c" * 32)


def test_production_startup_rejects_mock_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    _prod_base(monkeypatch)
    monkeypatch.setenv("VW_GATEWAY_PROVIDER", "mock")
    with pytest.raises(ConfigError, match="mock is not allowed"):
        Settings.from_env()


def test_production_http_provider_requires_url_and_accepts_https(monkeypatch: pytest.MonkeyPatch) -> None:
    _prod_base(monkeypatch)
    monkeypatch.setenv("VW_GATEWAY_PROVIDER", "http")
    monkeypatch.setenv("VW_GATEWAY_HTTP_VERIFY_URL", "https://verifier.example.test/verify")
    monkeypatch.setenv("VW_GATEWAY_HTTP_AUTH_VALUE", "Bearer " + "c" * 32)

    settings = Settings.from_env()

    assert settings.provider == "http"
    assert settings.http_verify_url == "https://verifier.example.test/verify"


def test_production_http_provider_rejects_plain_remote_http(monkeypatch: pytest.MonkeyPatch) -> None:
    _prod_base(monkeypatch)
    monkeypatch.setenv("VW_GATEWAY_PROVIDER", "http")
    monkeypatch.setenv("VW_GATEWAY_HTTP_VERIFY_URL", "http://verifier.example.test/verify")
    monkeypatch.setenv("VW_GATEWAY_HTTP_AUTH_VALUE", "Bearer " + "c" * 32)

    with pytest.raises(ConfigError, match="must use HTTPS"):
        Settings.from_env()


def test_recovery_interval_must_be_positive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VW_GATEWAY_RECOVERY_INTERVAL_SEC", "0")
    with pytest.raises(ConfigError, match="VW_GATEWAY_RECOVERY_INTERVAL_SEC must be positive"):
        Settings.from_env()


def test_production_rejects_template_key_id(monkeypatch: pytest.MonkeyPatch) -> None:
    _prod_base(monkeypatch)
    monkeypatch.setenv("VW_GATEWAY_KEY_ID", "template-web-1")
    with pytest.raises(ConfigError, match="VW_GATEWAY_KEY_ID"):
        Settings.from_env()


def test_production_rejects_relative_database_path(monkeypatch: pytest.MonkeyPatch) -> None:
    _prod_base(monkeypatch)
    monkeypatch.setenv("VW_GATEWAY_DATABASE_PATH", "./data/gateway.db")
    with pytest.raises(ConfigError, match="absolute path"):
        Settings.from_env()


def test_production_rejects_placeholder_secrets(monkeypatch: pytest.MonkeyPatch) -> None:
    _prod_base(monkeypatch)
    monkeypatch.setenv("VW_GATEWAY_SHARED_SECRET", "CHANGE_ME_DEVELOPMENT_GATEWAY_SHARED_SECRET")
    with pytest.raises(ConfigError, match="placeholder"):
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


def test_sdgb_preview_rejects_placeholder_key_material(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("VW_GATEWAY_ENV", "production")
    monkeypatch.setenv("VW_GATEWAY_SHARED_SECRET", "a" * 32)
    monkeypatch.setenv("VW_PUBLIC_ID_HMAC_SECRET", "b" * 32)
    monkeypatch.setenv("VW_GATEWAY_KEY_ID", "my-deployment-web-1")
    monkeypatch.setenv("VW_GATEWAY_DATABASE_PATH", "/var/lib/vw/gateway.db")
    monkeypatch.setenv("VW_GATEWAY_PROVIDER", "sdgb_preview")
    monkeypatch.setenv("VW_SDGB_AIME_URL", "https://aime.example.test/aime")
    monkeypatch.setenv("VW_SDGB_TITLE_SERVER_URL", "https://example.test/Maimai2Servlet")
    monkeypatch.setenv("VW_SDGB_AIME_SALT", "CHANGE_ME_AIME_SALT")
    monkeypatch.setenv("VW_SDGB_AES_KEY", "k" * 16)
    monkeypatch.setenv("VW_SDGB_AES_IV", "i" * 16)
    monkeypatch.setenv("VW_SDGB_OBFUSCATE_PARAM", "o" * 32)
    monkeypatch.setenv("VW_SDGB_KEYCHIP_ID", "A63E-01TEST")
    monkeypatch.setenv("VW_SDGB_CLIENT_ID", "A63E01TEST")
    with pytest.raises(ConfigError, match="placeholder"):
        Settings.from_env()


def test_sdgb_preview_production_requires_strong_key_material(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _prod_base(monkeypatch)
    monkeypatch.setenv("VW_GATEWAY_PROVIDER", "sdgb_preview")
    monkeypatch.setenv("VW_SDGB_AIME_URL", "https://aime.example.test/aime")
    monkeypatch.setenv("VW_SDGB_TITLE_SERVER_URL", "https://example.test/Maimai2Servlet")
    monkeypatch.setenv("VW_SDGB_AIME_SALT", "s" * 32)
    monkeypatch.setenv("VW_SDGB_AES_KEY", "k" * 16)
    monkeypatch.setenv("VW_SDGB_AES_IV", "i" * 16)
    monkeypatch.setenv("VW_SDGB_OBFUSCATE_PARAM", "o" * 32)
    monkeypatch.setenv("VW_SDGB_KEYCHIP_ID", "A63E-01TEST")
    monkeypatch.setenv("VW_SDGB_CLIENT_ID", "A63E01TEST")
    monkeypatch.setenv("VW_SDGB_AES_KEY", "short")
    with pytest.raises(ConfigError, match="too weak"):
        Settings.from_env()
