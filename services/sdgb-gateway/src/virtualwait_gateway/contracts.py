from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any


class ContractError(ValueError):
    """A client value does not meet the public v1 contract."""


PUBLIC_FIELDS = frozenset({"displayName", "rating", "title"})
ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]*$")
SUBJECT = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class CreateVerificationJobRequest:
    qr_code: str
    requested_public_fields: tuple[str, ...]


def parse_create_job(payload: Any) -> CreateVerificationJobRequest:
    if not isinstance(payload, dict) or set(payload) != {"qrCode", "requestedPublicFields"}:
        raise ContractError("INVALID_REQUEST")
    qr_code = payload["qrCode"]
    fields = payload["requestedPublicFields"]
    if not isinstance(qr_code, str) or not 4 <= len(qr_code) <= 2048:
        raise ContractError("INVALID_REQUEST")
    if (
        not isinstance(fields, list)
        or not 1 <= len(fields) <= 3
        or len(set(fields)) != len(fields)
        or any(field not in PUBLIC_FIELDS for field in fields)
    ):
        raise ContractError("INVALID_REQUEST")
    return CreateVerificationJobRequest(qr_code=qr_code, requested_public_fields=tuple(fields))


def create_job_response(job_id: str) -> dict[str, str]:
    if not isinstance(job_id, str) or not 1 <= len(job_id) <= 128:
        raise ContractError("INTERNAL_ERROR")
    return {"jobId": job_id}


def failed_job_response(code: str) -> dict[str, str]:
    if not ERROR_CODE.fullmatch(code) or len(code) > 64:
        raise ContractError("INTERNAL_ERROR")
    return {"status": "FAILED", "errorCode": code}


def processing_job_response(status: str = "PROCESSING") -> dict[str, str]:
    if status not in {"PROCESSING", "LOGGING_OUT"}:
        raise ContractError("INTERNAL_ERROR")
    return {"status": status}


def succeeded_job_response(subject: str, profile: dict[str, Any]) -> dict[str, Any]:
    if not SUBJECT.fullmatch(subject):
        raise ContractError("INTERNAL_ERROR")
    display_name = profile.get("displayName")
    rating = profile.get("rating")
    title = profile.get("title")
    if not isinstance(display_name, str) or not 1 <= len(display_name) <= 80:
        raise ContractError("INTERNAL_ERROR")
    if rating is not None and (not isinstance(rating, int) or not 0 <= rating <= 30000):
        raise ContractError("INTERNAL_ERROR")
    if title is not None and (not isinstance(title, str) or len(title) > 200):
        raise ContractError("INTERNAL_ERROR")
    public_profile: dict[str, Any] = {
        "displayName": display_name,
        "rating": rating,
        "title": title,
        "iconUrl": None,
    }
    return {
        "status": "SUCCEEDED",
        "identityProof": {"subject": subject},
        "profile": public_profile,
    }


def error_response(code: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code}}
