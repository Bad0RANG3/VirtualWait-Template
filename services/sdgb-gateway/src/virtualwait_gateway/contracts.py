from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any


class ContractError(ValueError):
    """A client value does not meet the public v1 contract."""


PUBLIC_FIELDS = frozenset({"displayName", "rating", "title"})
ERROR_CODE = re.compile(r"^[A-Z][A-Z0-9_]*$")
SUBJECT = re.compile(r"^[a-f0-9]{64}$")

#: 单次传分作业的谱面上限（与共享包 `sdgb.write_ops.MAX_TRANSFER_SCORES` 一致）。
MAX_SCORE_WRITE_COUNT = 5
#: 成绩条目的形状校验：`MUSICID:LEVEL:ACH[:COMBO[:SYNC]]`，ACH 允许 `101.0000` / `100.5%`。
#: 数值上下界仍由共享包 `parse_score_specs` 在执行时把守。
SCORE_SPEC = re.compile(r"^\d{1,7}:[0-4]:\d{1,7}(?:\.\d{1,4})?%?(?::[0-4](?::[0-5])?)?$")


@dataclass(frozen=True)
class CreateVerificationJobRequest:
    qr_code: str
    requested_public_fields: tuple[str, ...]


@dataclass(frozen=True)
class CreateScoreWriteJobRequest:
    qr_code: str
    scores: tuple[str, ...]
    #: 写入后是否回查确认（共享包把这个参数叫 `verify`）。
    confirm: bool


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


def parse_create_score_job(payload: Any) -> CreateScoreWriteJobRequest:
    """`POST /v1/score-write-jobs` 请求体：``{"qrCode":…,"scores":[…],"confirm":bool}``。

    ``confirm`` 可省略（默认 false）；省略时作业只报告“已提交”，不回查。
    """
    if not isinstance(payload, dict):
        raise ContractError("INVALID_REQUEST")
    keys = set(payload)
    if not {"qrCode", "scores"} <= keys or keys - {"qrCode", "scores", "confirm"}:
        raise ContractError("INVALID_REQUEST")
    qr_code = payload["qrCode"]
    scores = payload["scores"]
    confirm = payload.get("confirm", False)
    if not isinstance(qr_code, str) or not 20 <= len(qr_code) <= 2048:
        raise ContractError("INVALID_REQUEST")
    if (
        not isinstance(scores, list)
        or not 1 <= len(scores) <= MAX_SCORE_WRITE_COUNT
        or any(
            not isinstance(spec, str) or not SCORE_SPEC.fullmatch(spec.strip())
            for spec in scores
        )
    ):
        raise ContractError("INVALID_REQUEST")
    if not isinstance(confirm, bool):
        raise ContractError("INVALID_REQUEST")
    return CreateScoreWriteJobRequest(
        qr_code=qr_code.strip(),
        scores=tuple(spec.strip() for spec in scores),
        confirm=confirm,
    )


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


def score_write_succeeded_response(written_count: int, verified: bool) -> dict[str, Any]:
    """传分作业的成功回执：只公开写入条数与是否回查确认，不含任何身份字段。"""
    if not isinstance(written_count, int) or isinstance(written_count, bool):
        raise ContractError("INTERNAL_ERROR")
    if not 1 <= written_count <= MAX_SCORE_WRITE_COUNT:
        raise ContractError("INTERNAL_ERROR")
    return {
        "status": "SUCCEEDED",
        "writtenCount": written_count,
        "verified": bool(verified),
    }


def error_response(code: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code}}
