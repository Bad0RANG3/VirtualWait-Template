from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource


ROOT = Path(__file__).resolve().parents[3]
SCHEMAS = ROOT / "packages" / "contracts" / "schemas"
FIXTURES = ROOT / "packages" / "contracts" / "fixtures"


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def validator(schema_file: str) -> Draft202012Validator:
    schema = load_json(SCHEMAS / schema_file)
    public_profile = load_json(SCHEMAS / "public-profile.schema.json")
    registry = Registry().with_resources(
        [
            (schema["$id"], Resource.from_contents(schema)),
            (public_profile["$id"], Resource.from_contents(public_profile)),
        ]
    )
    return Draft202012Validator(schema, registry=registry)


def test_v1_fixtures_validate_against_versioned_schemas() -> None:
    pairs = {
        "verification-job-create-request.v1.schema.json": "verification-job-create-request.v1.json",
        "verification-job-create-response.v1.schema.json": "verification-job-create-response.v1.json",
        "verification-job-response.v1.schema.json": "verification-job-succeeded.v1.json",
        "verification-job-response.v1.schema.json": "verification-job-processing.v1.json",
        "verification-job-response.v1.schema.json": "verification-job-failed.v1.json",
        "gateway-error.v1.schema.json": "gateway-error-replay.v1.json",
    }
    for schema_file, fixture_file in pairs.items():
        errors = list(validator(schema_file).iter_errors(load_json(FIXTURES / fixture_file)))
        assert not errors, f"{fixture_file}: {errors}"


def test_succeeded_job_requires_identity_and_profile() -> None:
    errors = list(validator("verification-job-response.v1.schema.json").iter_errors({"status": "SUCCEEDED"}))
    assert errors
