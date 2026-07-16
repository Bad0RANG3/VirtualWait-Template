from __future__ import annotations

from pathlib import Path
from threading import Event, Thread
import time

from virtualwait_gateway.app import GatewayApplication, run_pending_logout_recovery
from virtualwait_gateway.config import Settings
from virtualwait_gateway.contracts import parse_create_job
from virtualwait_gateway.provider import ProviderResult
from virtualwait_gateway.repository import Repository
from virtualwait_gateway.service import VerificationService


def settings_for(tmp_path: Path) -> Settings:
    return Settings(
        environment="test",
        host="127.0.0.1",
        port=0,
        database_path=tmp_path / "gateway.db",
        key_id="test-web-1",
        shared_secret="test-shared-secret-012345678901234567890",
        public_id_hmac_secret="test-public-id-secret-012345678901234567",
        provider="mock",
        max_concurrent=2,
        rate_limit_per_minute=100,
        clock_skew_sec=300,
        nonce_ttl_sec=600,
    )


def test_mock_pending_logout_recovers_after_gateway_restart_without_raw_identity(tmp_path: Path) -> None:
    settings = settings_for(tmp_path)
    initial = GatewayApplication(settings)
    job_id = initial.service.create_job(
        parse_create_job(
            {
                "qrCode": "mock:logout-pending/pending-user-987:Player",
                "requestedPublicFields": ["displayName"],
            }
        )
    )
    assert initial.service.get_job(job_id) == {"status": "LOGGING_OUT"}

    raw_before_restart = settings.database_path.read_bytes()
    assert b"pending-user-987" not in raw_before_restart

    restarted = GatewayApplication(settings)
    recovered = restarted.service.get_job(job_id)
    assert recovered is not None
    assert recovered["status"] == "SUCCEEDED"
    assert recovered["profile"]["displayName"] == "Player"
    assert b"pending-user-987" not in settings.database_path.read_bytes()


class RetryableLogoutProvider:
    """A provider whose first retry fails transiently, then succeeds."""

    def __init__(self) -> None:
        self.retry_count = 0

    def verify(self, qr_code: str) -> ProviderResult:
        assert qr_code == "test-qr"
        return ProviderResult(
            status="LOGGING_OUT",
            subject="a" * 64,
            profile={"displayName": "Player", "rating": None, "title": None},
            encrypted_logout_context=b"authenticated-encrypted-context",
        )

    def retry_pending_logout(self, encrypted_context: bytes) -> bool:
        assert encrypted_context == b"authenticated-encrypted-context"
        self.retry_count += 1
        if self.retry_count == 1:
            raise TimeoutError("simulated upstream timeout")
        return True


def test_pending_logout_retries_after_transient_provider_failure_without_restart(tmp_path: Path) -> None:
    provider = RetryableLogoutProvider()
    service = VerificationService(Repository(tmp_path / "gateway.db"), provider)
    job_id = service.create_job(
        parse_create_job(
            {"qrCode": "test-qr", "requestedPublicFields": ["displayName"]}
        ),
        now=1_000,
    )
    assert service.get_job(job_id, now=1_000) == {"status": "LOGGING_OUT"}

    # A transport exception must keep the encrypted recovery context and defer
    # the retry, rather than failing the verification job or requiring restart.
    assert service.recover_pending_logouts(now=1_000) == 0
    assert provider.retry_count == 1
    assert service.recover_pending_logouts(now=1_029) == 0
    assert provider.retry_count == 1

    assert service.recover_pending_logouts(now=1_030) == 1
    assert provider.retry_count == 2
    assert service.get_job(job_id, now=1_030)["status"] == "SUCCEEDED"


def test_recovery_worker_advances_pending_logout_without_an_http_request(tmp_path: Path) -> None:
    application = GatewayApplication(settings_for(tmp_path))
    job_id = application.service.create_job(
        parse_create_job(
            {
                "qrCode": "mock:logout-pending/worker-user:Player",
                "requestedPublicFields": ["displayName"],
            }
        )
    )
    stop_event = Event()
    worker = Thread(
        target=run_pending_logout_recovery,
        args=(application.service, 1, stop_event),
        daemon=True,
    )
    worker.start()
    try:
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            if application.service.get_job(job_id)["status"] == "SUCCEEDED":
                break
            time.sleep(0.01)
        assert application.service.get_job(job_id)["status"] == "SUCCEEDED"
    finally:
        stop_event.set()
        worker.join(timeout=2)
    assert not worker.is_alive()
