from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
import json
from pathlib import Path
import threading
import time
from typing import Iterator

import httpx
import pytest

from virtualwait_gateway.app import create_server
from virtualwait_gateway.config import Settings
from virtualwait_gateway.contracts import ContractError, parse_create_score_job
from virtualwait_gateway.repository import Repository
from virtualwait_gateway.score_write import (
    QueueFullError,
    ScoreWriteOutcome,
    ScoreWriteService,
    classify_write_error,
    transfer_scores,
)
from virtualwait_gateway.security import request_signature, sha256_hex


# 明显虚构的二维码：测试只用它做形状与不外泄断言，绝不发往上游。
FAKE_QR = "SGWCMAID0000000000000000FAKEFAKEFAKE000000000000000000000000"


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


def request_for(
    scores: tuple[str, ...] = ("1234:4:1005000:4:5",),
    qr_code: str = FAKE_QR,
    confirm: bool = False,
):
    return parse_create_score_job(
        {"qrCode": qr_code, "scores": list(scores), "confirm": confirm}
    )


class RecordingHandler:
    """记录每次调用的二维码与时机，并保证同一时刻只有一个写入在跑。"""

    def __init__(self, outcome: ScoreWriteOutcome | None = None) -> None:
        self.calls: list[tuple[str, tuple[str, ...], bool]] = []
        self.starts: list[float] = []
        self.overlap = 0
        self._lock = threading.Lock()
        self._outcome = outcome

    def __call__(self, qr_code: str, scores: tuple[str, ...], *, confirm: bool) -> ScoreWriteOutcome:
        with self._lock:
            self.overlap += 1
            assert self.overlap == 1, "传分作业必须串行执行"
        self.calls.append((qr_code, scores, confirm))
        self.starts.append(time.time())
        time.sleep(0.05)
        with self._lock:
            self.overlap -= 1
        return self._outcome or ScoreWriteOutcome(
            status="SUCCEEDED", written_count=len(scores), verified=confirm
        )


class BlockingHandler:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def __call__(self, qr_code: str, scores: tuple[str, ...], *, confirm: bool) -> ScoreWriteOutcome:
        self.started.set()
        assert self.release.wait(timeout=10)
        return ScoreWriteOutcome(status="SUCCEEDED", written_count=1, verified=False)


def wait_for_settled(service: ScoreWriteService, job_id: str, timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = service.get_job(job_id)
        assert result is not None
        if result["status"] != "PROCESSING":
            return result
        time.sleep(0.02)
    raise AssertionError("score write job never settled")


def service_for(
    tmp_path: Path, handler, **overrides
) -> tuple[ScoreWriteService, threading.Event, threading.Thread]:
    service = ScoreWriteService(
        Repository(tmp_path / "gateway.db"),
        handler,
        job_ttl_sec=overrides.pop("job_ttl_sec", 600),
        min_interval_sec=overrides.pop("min_interval_sec", 0),
        queue_capacity=overrides.pop("queue_capacity", 3),
    )
    assert not overrides
    stop = threading.Event()
    worker = threading.Thread(target=service.run_worker, args=(stop,), daemon=True)
    worker.start()
    return service, stop, worker


# ---------------------------------------------------------------------------
# 契约校验
# ---------------------------------------------------------------------------


def test_request_accepts_optional_confirm_and_strips_spec_whitespace() -> None:
    request = parse_create_score_job(
        {"qrCode": FAKE_QR, "scores": [" 1234:4:1005000 "], "confirm": True}
    )
    assert request.scores == ("1234:4:1005000",)
    assert request.confirm is True
    assert parse_create_score_job({"qrCode": FAKE_QR, "scores": ["1234:4:100.5%"]}).confirm is False


@pytest.mark.parametrize(
    "payload",
    [
        {"qrCode": FAKE_QR},
        {"qrCode": FAKE_QR, "scores": []},
        {"qrCode": FAKE_QR, "scores": ["1234:4:1005000"] * 6},
        {"qrCode": FAKE_QR, "scores": ["1234:9:1005000"]},
        {"qrCode": FAKE_QR, "scores": ["1234:4:1005000:9"]},
        {"qrCode": FAKE_QR, "scores": ["music:level:ach"]},
        {"qrCode": FAKE_QR, "scores": "1234:4:1005000"},
        {"qrCode": FAKE_QR, "scores": ["1234:4:1005000"], "sleepSeconds": 1},
        {"qrCode": "short-qr", "scores": ["1234:4:1005000"]},
        {"qrCode": FAKE_QR, "scores": ["1234:4:1005000"], "confirm": "yes"},
    ],
)
def test_request_rejects_malformed_payloads(payload: dict) -> None:
    with pytest.raises(ContractError):
        parse_create_score_job(payload)


# ---------------------------------------------------------------------------
# 队列语义
# ---------------------------------------------------------------------------


def test_jobs_run_serially_and_honour_the_min_interval(tmp_path: Path) -> None:
    handler = RecordingHandler()
    service, stop, worker = service_for(tmp_path, handler, min_interval_sec=1)
    try:
        first = service.submit(request_for(qr_code=FAKE_QR + "-A"))
        second = service.submit(
            request_for(("4321:3:101.0000",), qr_code=FAKE_QR + "-B", confirm=True)
        )
        assert wait_for_settled(service, first) == {
            "status": "SUCCEEDED",
            "writtenCount": 1,
            "verified": False,
        }
        assert wait_for_settled(service, second) == {
            "status": "SUCCEEDED",
            "writtenCount": 1,
            "verified": True,
        }
    finally:
        stop.set()
        worker.join(timeout=3)
    assert [call[0] for call in handler.calls] == [FAKE_QR + "-A", FAKE_QR + "-B"]
    assert handler.starts[1] - handler.starts[0] >= 0.9


def test_full_queue_rejects_extra_jobs(tmp_path: Path) -> None:
    handler = BlockingHandler()
    service, stop, worker = service_for(tmp_path, handler, queue_capacity=1)
    accepted = service.submit(request_for())
    assert handler.started.wait(timeout=5)
    with pytest.raises(QueueFullError):
        service.submit(request_for(qr_code=FAKE_QR + "-2"))
    # 被拒绝的请求不落库，也不会在别处留下二维码。
    assert service.get_job("no-such-job") is None
    assert FAKE_QR.encode() + b"-2" not in (tmp_path / "gateway.db").read_bytes()
    handler.release.set()
    try:
        assert wait_for_settled(service, accepted)["status"] == "SUCCEEDED"
    finally:
        stop.set()
        worker.join(timeout=3)


def test_failed_outcome_is_reported_as_an_error_code(tmp_path: Path) -> None:
    handler = RecordingHandler(
        ScoreWriteOutcome(status="FAILED", error_code="LOGIN_COOLDOWN")
    )
    service, stop, worker = service_for(tmp_path, handler)
    try:
        job_id = service.submit(request_for())
        assert wait_for_settled(service, job_id) == {
            "status": "FAILED",
            "errorCode": "LOGIN_COOLDOWN",
        }
    finally:
        stop.set()
        worker.join(timeout=3)


def test_raw_qr_and_scores_never_reach_the_database(tmp_path: Path) -> None:
    handler = RecordingHandler()
    service, stop, worker = service_for(tmp_path, handler)
    try:
        job_id = service.submit(request_for(("9999:4:1010000:4:5",)))
        wait_for_settled(service, job_id)
    finally:
        stop.set()
        worker.join(timeout=3)
    database = tmp_path / "gateway.db"
    stored = b"".join(
        path.read_bytes() for path in (database, database.with_name("gateway.db-wal"))
        if path.exists()
    )
    assert FAKE_QR.encode() not in stored
    assert b"9999:4:1010000" not in stored
    assert job_id.encode() in stored


def test_write_jobs_are_not_readable_through_the_verification_kind(tmp_path: Path) -> None:
    repository = Repository(tmp_path / "gateway.db")
    service = ScoreWriteService(repository, RecordingHandler(), job_ttl_sec=600)
    now = int(time.time())
    job_id = service.submit(request_for(), now=now)
    assert repository.get_job(job_id, now, kind="verification") is None
    assert service.get_job(job_id, now)["status"] == "PROCESSING"


def test_write_job_beyond_its_ttl_reports_expired(tmp_path: Path) -> None:
    repository = Repository(tmp_path / "gateway.db")
    service = ScoreWriteService(repository, RecordingHandler(), job_ttl_sec=60)
    now = int(time.time())
    job_id = service.submit(request_for(), now=now)
    assert service.get_job(job_id, now + 61) == {"status": "FAILED", "errorCode": "JOB_EXPIRED"}


def test_interrupted_write_job_fails_on_restart_without_retry(tmp_path: Path) -> None:
    database = tmp_path / "gateway.db"
    repository = Repository(database)
    orphaned = ScoreWriteService(repository, RecordingHandler(), job_ttl_sec=600)
    now = int(time.time())
    job_id = orphaned.submit(request_for(), now=now)

    restarted = ScoreWriteService(Repository(database), RecordingHandler(), job_ttl_sec=600)
    restarted.start()
    assert restarted.get_job(job_id, now + 1) == {
        "status": "FAILED",
        "errorCode": "JOB_INTERRUPTED",
    }


def test_kind_column_is_added_to_a_pre_write_database(tmp_path: Path) -> None:
    """老库（无 kind 列）必须能原地升级，且历史行仍算验身作业。"""
    import sqlite3

    database = tmp_path / "legacy.db"
    with sqlite3.connect(database) as connection:
        connection.execute(
            "CREATE TABLE verification_job (id TEXT PRIMARY KEY, status TEXT NOT NULL,"
            " public_result TEXT, error_code TEXT, expires_at INTEGER NOT NULL,"
            " created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
        )
        connection.execute(
            "INSERT INTO verification_job VALUES ('old-1','SUCCEEDED','{}',NULL,9999999999,1,1)"
        )

    repository = Repository(database)
    assert repository.get_job("old-1", 10, kind="verification") is not None
    assert repository.get_job("old-1", 10, kind="score_write") is None


# ---------------------------------------------------------------------------
# 共享写流程的映射
# ---------------------------------------------------------------------------


def test_error_classification_is_stable() -> None:
    assert classify_write_error(RuntimeError("isLogin=1（小黑屋）：15 分钟后再试")) == "LOGIN_COOLDOWN"
    assert classify_write_error(RuntimeError("二维码换 token 失败")) == "QR_EXCHANGE_FAILED"
    assert classify_write_error(RuntimeError("UpsertUserAllApi returnCode=500")) == "UPSTREAM_REJECTED"
    assert classify_write_error(RuntimeError("GetUserDataApi 返回空响应")) == "UPSTREAM_REJECTED"
    assert classify_write_error(RuntimeError("UpsertUserAllApi 前置查询失败")) == "SNAPSHOT_INCOMPLETE"
    assert classify_write_error(RuntimeError("boom")) == "WRITE_FAILED"


def test_transfer_scores_maps_the_shared_package_result(monkeypatch: pytest.MonkeyPatch) -> None:
    import sdgb.write_ops as write_ops

    seen: dict = {}

    async def fake(qr, scores, *, verify, progress):
        seen.update(qr=qr, scores=scores, verify=verify, progress=progress)
        return write_ops.WriteResult(
            "✅ 已写入 2 条成绩", status=write_ops.WRITE_SUBMITTED, written_count=2
        )

    monkeypatch.setattr(write_ops, "transfer_score_with_qr", fake)
    outcome = transfer_scores(FAKE_QR, ("1234:4:1005000", "4321:3:1010000"), confirm=False)
    assert outcome == ScoreWriteOutcome(status="SUCCEEDED", written_count=2, verified=False)
    assert seen == {"qr": FAKE_QR, "scores": ["1234:4:1005000", "4321:3:1010000"], "verify": False, "progress": None}


def test_transfer_scores_reports_unconfirmed_writeback_as_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sdgb.write_ops as write_ops

    async def fake(qr, scores, *, verify, progress):
        return write_ops.WriteResult(
            "⚠️ 写入已提交，但回查未达目标成绩",
            status=write_ops.WRITE_UNCONFIRMED,
            written_count=1,
        )

    monkeypatch.setattr(write_ops, "transfer_score_with_qr", fake)
    assert transfer_scores(FAKE_QR, ("1234:4:1005000",), confirm=True) == ScoreWriteOutcome(
        status="FAILED", error_code="WRITE_NOT_CONFIRMED"
    )


def test_transfer_scores_confirms_verified_writeback(monkeypatch: pytest.MonkeyPatch) -> None:
    import sdgb.write_ops as write_ops

    async def fake(qr, scores, *, verify, progress):
        return write_ops.WriteResult(
            "✅ 已写入并回查确认 1 条成绩",
            status=write_ops.WRITE_CONFIRMED,
            written_count=1,
        )

    monkeypatch.setattr(write_ops, "transfer_score_with_qr", fake)
    assert transfer_scores(FAKE_QR, ("1234:4:1005000",), confirm=True) == ScoreWriteOutcome(
        status="SUCCEEDED", written_count=1, verified=True
    )


def test_transfer_scores_never_leaks_the_exception_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sdgb.write_ops as write_ops

    async def fake(qr, scores, *, verify, progress):
        raise RuntimeError("登录失败 returnCode=500（loginId=1234567890）")

    monkeypatch.setattr(write_ops, "transfer_score_with_qr", fake)
    assert transfer_scores(FAKE_QR, ("1234:4:1005000",), confirm=False) == ScoreWriteOutcome(
        status="FAILED", error_code="UPSTREAM_REJECTED"
    )


# ---------------------------------------------------------------------------
# 签名 HTTP 端到端
# ---------------------------------------------------------------------------


def signed_headers(
    settings: Settings, method: str, path: str, body: bytes, nonce: str
) -> dict[str, str]:
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


@contextmanager
def write_gateway(tmp_path: Path, handler, **setting_overrides) -> Iterator[tuple[str, Settings]]:
    overrides: dict = {"score_write_enabled": True}
    overrides.update(setting_overrides)
    settings = replace(settings_for(tmp_path), **overrides)
    server = create_server(settings, handler)
    application = server.virtualwait_application
    stop_worker = threading.Event()
    worker: threading.Thread | None = None
    if application.score_write is not None:
        worker = threading.Thread(
            target=application.score_write.run_worker, args=(stop_worker,), daemon=True
        )
        worker.start()
    serve = threading.Thread(target=server.serve_forever, daemon=True)
    serve.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", settings
    finally:
        server.shutdown()
        serve.join(timeout=2)
        stop_worker.set()
        if worker is not None:
            worker.join(timeout=3)
        server.server_close()


def _post_score_write(client, settings, path: str, body: bytes, nonce: str) -> httpx.Response:
    return client.post(
        path, content=body, headers=signed_headers(settings, "POST", path, body, nonce)
    )


def _get_job(client, settings, target: str, nonce: str) -> httpx.Response:
    return client.get(
        target, headers=signed_headers(settings, "GET", target, b"", nonce)
    )


def test_signed_score_write_round_trip(tmp_path: Path) -> None:
    handler = RecordingHandler()
    path = "/v1/score-write-jobs"
    with write_gateway(tmp_path, handler, score_write_min_interval_sec=0) as (base_url, settings):
        body = json.dumps(
            {"qrCode": FAKE_QR, "scores": ["1234:4:1005000:4:5"], "confirm": True},
            separators=(",", ":"),
        ).encode()
        with httpx.Client(base_url=base_url) as client:
            create = _post_score_write(client, settings, path, body, "nonce-score-write-create")
            assert create.status_code == 202
            job_id = create.json()["jobId"]

            deadline = time.time() + 5
            payload: dict = {}
            while time.time() < deadline:
                get = _get_job(client, settings, f"{path}/{job_id}", f"nonce-sw-get-{time.time_ns()}")
                assert get.status_code == 200
                payload = get.json()
                if payload["status"] != "PROCESSING":
                    break
                time.sleep(0.05)
            assert payload == {"status": "SUCCEEDED", "writtenCount": 1, "verified": True}
            assert handler.calls == [(FAKE_QR, ("1234:4:1005000:4:5",), True)]

            # 传分作业不能通过验身接口读到（两者回执形状不同）。
            cross = _get_job(
                client, settings, f"/v1/verification-jobs/{job_id}", "nonce-sw-cross-get"
            )
            assert cross.status_code == 404

            invalid = json.dumps(
                {"qrCode": FAKE_QR, "scores": ["1234:9:100"]}, separators=(",", ":")
            ).encode()
            bad = _post_score_write(client, settings, path, invalid, "nonce-sw-bad-post")
            assert bad.status_code == 400
            assert bad.json() == {"error": {"code": "INVALID_REQUEST"}}


def test_score_write_endpoints_are_disabled_by_default(tmp_path: Path) -> None:
    with write_gateway(tmp_path, RecordingHandler(), score_write_enabled=False) as (
        base_url,
        settings,
    ):
        path = "/v1/score-write-jobs"
        body = json.dumps({"qrCode": FAKE_QR, "scores": ["1234:4:1005000"]}).encode()
        with httpx.Client(base_url=base_url) as client:
            for method, target in (
                ("POST", path),
                ("GET", f"{path}/unknown-job"),
            ):
                payload = body if method == "POST" else b""
                response = client.request(
                    method,
                    target,
                    content=payload,
                    headers=signed_headers(settings, method, target, payload, f"nonce-score-write-{method}-01"),
                )
                assert response.status_code == 403
                assert response.json() == {"error": {"code": "SCORE_WRITE_DISABLED"}}
