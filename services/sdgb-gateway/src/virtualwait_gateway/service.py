from __future__ import annotations

from uuid import uuid4
import time

from .contracts import (
    CreateVerificationJobRequest,
    failed_job_response,
    processing_job_response,
    succeeded_job_response,
)
from .provider import VerificationProvider
from .repository import Repository


class VerificationService:
    def __init__(self, repository: Repository, provider: VerificationProvider, job_ttl_sec: int = 120) -> None:
        self.repository = repository
        self.provider = provider
        self.job_ttl_sec = job_ttl_sec

    def create_job(self, request: CreateVerificationJobRequest, now: int | None = None) -> str:
        current = int(time.time()) if now is None else now
        job_id = str(uuid4())
        self.repository.create_job(job_id, current, current + self.job_ttl_sec)
        # The raw QR exists only in this method and is never passed to repository methods.
        result = self.provider.verify(request.qr_code)
        if result.status == "SUCCEEDED" and result.subject and result.profile:
            self.repository.mark_succeeded(
                job_id, succeeded_job_response(result.subject, result.profile), current
            )
        elif result.status == "LOGGING_OUT" and result.subject and result.profile and result.encrypted_logout_context:
            self.repository.mark_logging_out(
                job_id,
                succeeded_job_response(result.subject, result.profile),
                result.encrypted_logout_context,
                current,
            )
        elif result.status == "FAILED":
            self.repository.mark_failed(job_id, result.error_code or "INTERNAL_ERROR", current)
        return job_id

    def recover_pending_logouts(self, now: int | None = None) -> int:
        current = int(time.time()) if now is None else now
        recovered = 0
        for job_id, encrypted_context in self.repository.due_pending_logouts(current):
            try:
                logged_out = self.provider.retry_pending_logout(encrypted_context)
            except Exception:
                # Provider exceptions are treated exactly like a negative logout
                # acknowledgement: retain the encrypted context and retry later.
                self.repository.defer_pending_logout(job_id, "LOGOUT_FAILED", current)
                continue
            if logged_out:
                if self.repository.complete_pending_logout(job_id, current):
                    recovered += 1
            else:
                self.repository.defer_pending_logout(job_id, "LOGOUT_FAILED", current)
        return recovered

    def get_job(self, job_id: str, now: int | None = None) -> dict[str, object] | None:
        current = int(time.time()) if now is None else now
        result = self.repository.get_job(job_id, current)
        if result is None:
            return None
        status = result["status"]
        if status == "FAILED":
            return failed_job_response(str(result["errorCode"]))
        if status in {"PROCESSING", "LOGGING_OUT"}:
            return processing_job_response(str(status))
        return result
