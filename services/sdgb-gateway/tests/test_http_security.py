from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
from threading import Thread
import time
from typing import Iterator

import httpx

from virtualwait_gateway.app import create_server
from virtualwait_gateway.config import Settings
from virtualwait_gateway.security import request_signature, sha256_hex


@contextmanager
def gateway(tmp_path: Path) -> Iterator[tuple[str, Settings]]:
    settings = Settings(
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
    server = create_server(settings)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", settings
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def signed_headers(settings: Settings, method: str, path: str, body: bytes, nonce: str) -> dict[str, str]:
    timestamp = str(int(time.time()))
    return {
        "X-VW-Key-Id": settings.key_id,
        "X-VW-Timestamp": timestamp,
        "X-VW-Nonce": nonce,
        "X-VW-Body-SHA256": sha256_hex(body),
        "X-VW-Signature": request_signature(
            settings.shared_secret, method, path, timestamp, nonce, body
        ),
    }


def test_signed_success_is_retrievable_and_persists_no_raw_qr_or_user_id(tmp_path: Path) -> None:
    with gateway(tmp_path) as (base_url, settings), httpx.Client(base_url=base_url) as client:
        body = json.dumps(
            {
                "qrCode": "mock:raw-user-id-987:Player:14500:Title",
                "requestedPublicFields": ["displayName", "rating", "title"],
            },
            separators=(",", ":"),
        ).encode()
        create = client.post(
            "/v1/verification-jobs",
            content=body,
            headers=signed_headers(settings, "POST", "/v1/verification-jobs", body, "nonce-create-0001"),
        )
        assert create.status_code == 202
        job_id = create.json()["jobId"]

        get = client.get(
            f"/v1/verification-jobs/{job_id}",
            headers=signed_headers(
                settings, "GET", f"/v1/verification-jobs/{job_id}", b"", "nonce-get-00000001"
            ),
        )
        assert get.status_code == 200
        payload = get.json()
        assert payload["status"] == "SUCCEEDED"
        assert payload["profile"]["displayName"] == "Player"
        assert "raw-user-id-987" not in json.dumps(payload)

    raw_files = [settings.database_path, settings.database_path.with_name("gateway.db-wal")]
    stored = b"".join(path.read_bytes() for path in raw_files if path.exists())
    assert b"raw-user-id-987" not in stored
    assert b"mock:raw-user-id-987" not in stored


def test_replayed_nonce_is_rejected(tmp_path: Path) -> None:
    with gateway(tmp_path) as (base_url, settings), httpx.Client(base_url=base_url) as client:
        body = b'{"qrCode":"mock:10001:Player","requestedPublicFields":["displayName"]}'
        headers = signed_headers(settings, "POST", "/v1/verification-jobs", body, "nonce-replay-0001")
        assert client.post("/v1/verification-jobs", content=body, headers=headers).status_code == 202
        replay = client.post("/v1/verification-jobs", content=body, headers=headers)
        assert replay.status_code == 409
        assert replay.json() == {"error": {"code": "REPLAY_DETECTED"}}


def test_invalid_body_hash_is_rejected_before_qr_parsing(tmp_path: Path) -> None:
    with gateway(tmp_path) as (base_url, settings), httpx.Client(base_url=base_url) as client:
        body = b'{"qrCode":"mock:10001:Player","requestedPublicFields":["displayName"]}'
        headers = signed_headers(settings, "POST", "/v1/verification-jobs", b"{}", "nonce-invalid-0001")
        response = client.post("/v1/verification-jobs", content=body, headers=headers)
        assert response.status_code == 401
        assert response.json() == {"error": {"code": "INVALID_SIGNATURE"}}


def test_processing_fixture_path_is_stable(tmp_path: Path) -> None:
    with gateway(tmp_path) as (base_url, settings), httpx.Client(base_url=base_url) as client:
        body = b'{"qrCode":"mock:processing","requestedPublicFields":["displayName"]}'
        create = client.post(
            "/v1/verification-jobs",
            content=body,
            headers=signed_headers(settings, "POST", "/v1/verification-jobs", body, "nonce-process-0001"),
        )
        job_id = create.json()["jobId"]
        response = client.get(
            f"/v1/verification-jobs/{job_id}",
            headers=signed_headers(
                settings, "GET", f"/v1/verification-jobs/{job_id}", b"", "nonce-process-get1"
            ),
        )
        assert response.json() == {"status": "PROCESSING"}


def test_healthz_reports_persistent_store_readiness(tmp_path: Path) -> None:
    with gateway(tmp_path) as (base_url, _settings), httpx.Client(base_url=base_url) as client:
        response = client.get("/healthz")
        assert response.status_code == 200
        assert response.json() == {"ok": True}
