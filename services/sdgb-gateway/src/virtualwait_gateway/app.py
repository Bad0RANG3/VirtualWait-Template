from __future__ import annotations

from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
from threading import BoundedSemaphore, Event, Thread
import time
from typing import Any, Type
from urllib.parse import urlsplit

from .config import Settings
from .contracts import ContractError, create_job_response, error_response, parse_create_job
from .provider import (
    HttpVerificationProvider,
    MockVerificationProvider,
    SdgbPreviewVerificationProvider,
    VerificationProvider,
)
from .sdgb_preview import SdgbPreviewSettings
from .repository import Repository
from .security import AuthenticationError, verify_signed_request
from .service import VerificationService


MAX_BODY_BYTES = 4 * 1024
JOB_PATH = re.compile(r"^/v1/verification-jobs/([^/]+)$")


def create_provider(settings: Settings) -> VerificationProvider:
    if settings.provider == "mock":
        return MockVerificationProvider(settings.public_id_hmac_secret)
    if settings.provider == "http" and settings.http_verify_url:
        return HttpVerificationProvider(
            settings.http_verify_url,
            settings.public_id_hmac_secret,
            settings.http_auth_header,
            settings.http_auth_value,
            settings.http_timeout_sec,
        )
    if (
        settings.provider == "sdgb_preview"
        and settings.sdgb_aime_url
        and settings.sdgb_title_server_url
    ):
        return SdgbPreviewVerificationProvider(
            SdgbPreviewSettings(
                aime_url=settings.sdgb_aime_url,
                title_server_url=settings.sdgb_title_server_url,
                aime_salt=settings.sdgb_aime_salt,
                aes_key=settings.sdgb_aes_key,
                aes_iv=settings.sdgb_aes_iv,
                obfuscate_param=settings.sdgb_obfuscate_param,
                keychip_id=settings.sdgb_keychip_id,
                client_id=settings.sdgb_client_id,
                timeout_sec=settings.sdgb_timeout_sec,
            ),
            settings.public_id_hmac_secret,
        )
    raise ValueError("Unsupported Gateway provider configuration")


class GatewayApplication:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.repository = Repository(settings.database_path)
        self.service = VerificationService(self.repository, create_provider(settings))
        # Recovery runs before accepting new jobs. Provider implementations must
        # keep any recoverable state encrypted and never persist raw QR values.
        self.service.recover_pending_logouts()
        self.verification_slots = BoundedSemaphore(settings.max_concurrent)

    def authorize(self, handler: BaseHTTPRequestHandler, body: bytes) -> bool:
        verify_signed_request(
            self.settings,
            self.repository,
            handler.command,
            handler.path,
            dict(handler.headers.items()),
            body,
        )
        return self.repository.consume_rate_limit(
            f"key:{self.settings.key_id}",
            self.settings.rate_limit_per_minute,
            60,
            int(time.time()),
        )


def create_handler(application: GatewayApplication) -> Type[BaseHTTPRequestHandler]:
    class GatewayHandler(BaseHTTPRequestHandler):
        server_version = "VirtualWaitGateway/0.1"

        def log_message(self, format: str, *args: Any) -> None:
            # Never let the standard handler log request paths or bodies. Production
            # observability must use a separately reviewed redacted logger.
            return

        def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(raw)

        def _error(self, status: HTTPStatus, code: str) -> None:
            self._send_json(status, error_response(code))

        def _read_body(self) -> bytes | None:
            raw_length = self.headers.get("Content-Length")
            if raw_length is None:
                self._error(HTTPStatus.LENGTH_REQUIRED, "INVALID_REQUEST")
                return None
            try:
                length = int(raw_length)
            except ValueError:
                self._error(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST")
                return None
            if length < 1 or length > MAX_BODY_BYTES:
                self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "INVALID_REQUEST")
                return None
            return self.rfile.read(length)

        def _authorize(self, body: bytes) -> bool:
            try:
                if not application.authorize(self, body):
                    self._error(HTTPStatus.TOO_MANY_REQUESTS, "RATE_LIMITED")
                    return False
            except AuthenticationError as exc:
                status = (
                    HTTPStatus.CONFLICT
                    if exc.code == "REPLAY_DETECTED"
                    else HTTPStatus.UNAUTHORIZED
                )
                self._error(status, exc.code)
                return False
            return True

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/healthz":
                if application.repository.healthcheck():
                    self._send_json(HTTPStatus.OK, {"ok": True})
                else:
                    self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False})
                return
            match = JOB_PATH.fullmatch(urlsplit(self.path).path)
            if not match:
                self._error(HTTPStatus.NOT_FOUND, "INVALID_REQUEST")
                return
            if not self._authorize(b""):
                return
            result = application.service.get_job(match.group(1))
            if result is None:
                self._error(HTTPStatus.NOT_FOUND, "JOB_EXPIRED")
                return
            self._send_json(HTTPStatus.OK, result)

        def do_POST(self) -> None:  # noqa: N802
            if urlsplit(self.path).path != "/v1/verification-jobs":
                self._error(HTTPStatus.NOT_FOUND, "INVALID_REQUEST")
                return
            body = self._read_body()
            if body is None or not self._authorize(body):
                return
            if not application.verification_slots.acquire(blocking=False):
                self._error(HTTPStatus.TOO_MANY_REQUESTS, "RATE_LIMITED")
                return
            try:
                try:
                    payload = json.loads(body.decode("utf-8"))
                    request = parse_create_job(payload)
                except (UnicodeDecodeError, json.JSONDecodeError, ContractError):
                    self._error(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST")
                    return
                job_id = application.service.create_job(request)
                self._send_json(HTTPStatus.ACCEPTED, create_job_response(job_id))
            finally:
                application.verification_slots.release()

        def do_PUT(self) -> None:  # noqa: N802
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "INVALID_REQUEST")

        def do_DELETE(self) -> None:  # noqa: N802
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "INVALID_REQUEST")

    return GatewayHandler


def create_server(settings: Settings) -> ThreadingHTTPServer:
    application = GatewayApplication(settings)
    server = ThreadingHTTPServer((settings.host, settings.port), create_handler(application))
    # Keep the application accessible to the process-level recovery worker.
    # Request handlers still close over this exact instance.
    server.virtualwait_application = application  # type: ignore[attr-defined]
    return server


def run_pending_logout_recovery(
    service: VerificationService, interval_sec: int, stop_event: Event
) -> None:
    """Advance durable logout retries even when no Web request arrives.

    Startup recovery handles process restarts. This loop handles a transient
    upstream logout failure that becomes retryable later in the same process.
    It deliberately produces no request or provider data in logs.
    """
    while not stop_event.is_set():
        service.recover_pending_logouts()
        stop_event.wait(interval_sec)


def main() -> None:
    settings = Settings.from_env()
    server = create_server(settings)
    application = server.virtualwait_application  # type: ignore[attr-defined]
    stop_recovery = Event()
    recovery = Thread(
        target=run_pending_logout_recovery,
        args=(application.service, settings.recovery_interval_sec, stop_recovery),
        name="virtualwait-pending-logout-recovery",
        daemon=True,
    )
    recovery.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_recovery.set()
        recovery.join(timeout=settings.recovery_interval_sec + 1)
        server.server_close()


if __name__ == "__main__":
    main()
