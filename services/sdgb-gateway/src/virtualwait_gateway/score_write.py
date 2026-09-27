"""传分（score write）作业：签名接口 -> 内存串行队列 -> 共享 SDGB 写流程。

为什么必须串行 + 限速：
- 机台二维码一次一码，队列里排第二次的码在第一次登录前不能提前换 token；
- 同一账号两次 `UserLoginApi` 之间要留出间隔，否则落进 15 分钟「小黑屋」
  （`isLogin=1`），默认 `VW_SDGB_WRITE_MIN_INTERVAL_SEC=900`。

凭证纪律：原始二维码只存在于本模块的内存队列里，绝不入库、绝不入日志；
数据库只保存作业状态行与公开回执。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import logging
import pathlib
import queue
import sys
import threading
import time
from typing import Protocol
from uuid import uuid4

from .contracts import (
    CreateScoreWriteJobRequest,
    failed_job_response,
    processing_job_response,
    score_write_succeeded_response,
)
from .repository import JOB_KIND_SCORE_WRITE, Repository

logger = logging.getLogger(__name__)

# 共享 SDGB 客户端（packages/sdgb-client）。与 sdgb_full 一致：仓库内运行时直接
# 注入 PYTHONPATH，也可 `pip install -e packages/sdgb-client`。
_CLIENT_ROOT = pathlib.Path(__file__).resolve().parents[4] / "packages" / "sdgb-client"
if str(_CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_CLIENT_ROOT))


@dataclass(frozen=True)
class ScoreWriteOutcome:
    """provider 回执。status 只取 SUCCEEDED / FAILED（FAILED 必须带 error_code）。"""

    status: str
    written_count: int = 0
    verified: bool = False
    error_code: str | None = None


class ScoreWriteHandler(Protocol):
    def __call__(
        self, qr_code: str, scores: tuple[str, ...], *, confirm: bool
    ) -> ScoreWriteOutcome: ...


class QueueFullError(RuntimeError):
    """No in-flight slot is free; the caller must retry later."""


# ---------------------------------------------------------------------------
# 默认 handler：直接复用共享包已实机落地的传分流程（单一实现）
# ---------------------------------------------------------------------------

# 共享包用中文 RuntimeError 文本报告失败原因，这里把它收敛成契约错误码。
_ERROR_MARKERS = (
    (("isLogin", "小黑屋"), "LOGIN_COOLDOWN"),
    (("二维码",), "QR_EXCHANGE_FAILED"),
    (("returnCode", "空响应"), "UPSTREAM_REJECTED"),
    (("前置查询失败",), "SNAPSHOT_INCOMPLETE"),
)


def classify_write_error(exc: BaseException) -> str:
    text = str(exc)
    for markers, code in _ERROR_MARKERS:
        if any(marker in text for marker in markers):
            return code
    return "WRITE_FAILED"


def transfer_scores(
    qr_code: str, scores: tuple[str, ...], *, confirm: bool
) -> ScoreWriteOutcome:
    """Run the shared 传分 flow in a private event loop (this call is a worker thread).

    ``confirm`` 对应共享包的 ``verify=``：写入后回查账号谱面，确认达标才算成功。
    """
    from sdgb.write_ops import WRITE_CONFIRMED, WRITE_UNCONFIRMED, transfer_score_with_qr

    try:
        # progress=None：写流程的进度文案是给群聊看的，这里只取最终回执。
        result = asyncio.run(
            transfer_score_with_qr(qr_code, list(scores), verify=confirm, progress=None)
        )
    except Exception as exc:  # noqa: BLE001
        # 只记错误码：异常文本可能带 userID 或上游响应片段。
        code = classify_write_error(exc)
        logger.warning("score write job failed: %s", code)
        return ScoreWriteOutcome(status="FAILED", error_code=code)
    if result.status == WRITE_UNCONFIRMED:
        return ScoreWriteOutcome(status="FAILED", error_code="WRITE_NOT_CONFIRMED")
    return ScoreWriteOutcome(
        status="SUCCEEDED",
        written_count=result.written_count,
        verified=result.status == WRITE_CONFIRMED,
    )


# ---------------------------------------------------------------------------
# 串行队列
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _PendingWrite:
    job_id: str
    qr_code: str
    scores: tuple[str, ...]
    confirm: bool


class ScoreWriteService:
    def __init__(
        self,
        repository: Repository,
        handler: ScoreWriteHandler,
        *,
        job_ttl_sec: int = 1800,
        min_interval_sec: int = 900,
        queue_capacity: int = 2,
    ) -> None:
        self.repository = repository
        self._handler = handler
        self._job_ttl_sec = job_ttl_sec
        self._min_interval_sec = min_interval_sec
        self._slots = threading.BoundedSemaphore(queue_capacity)
        self._queue: queue.Queue[_PendingWrite] = queue.Queue()
        self._next_start_at = 0.0

    def start(self) -> None:
        """Fail writes interrupted by a previous process before accepting new jobs."""
        recovered = self.repository.fail_interrupted_writes(int(time.time()))
        if recovered:
            logger.info("failed %d interrupted score-write jobs", recovered)

    def submit(self, request: CreateScoreWriteJobRequest, now: int | None = None) -> str:
        """Register a job and enqueue its QR. The QR never reaches the repository."""
        if not self._slots.acquire(blocking=False):
            raise QueueFullError("score write queue is full")
        current = int(time.time()) if now is None else now
        job_id = str(uuid4())
        try:
            self.repository.create_job(
                job_id, current, current + self._job_ttl_sec, kind=JOB_KIND_SCORE_WRITE
            )
            self._queue.put(
                _PendingWrite(
                    job_id=job_id,
                    qr_code=request.qr_code,
                    scores=request.scores,
                    confirm=request.confirm,
                )
            )
        except BaseException:
            self._slots.release()
            raise
        return job_id

    def get_job(self, job_id: str, now: int | None = None) -> dict[str, object] | None:
        current = int(time.time()) if now is None else now
        result = self.repository.get_job(job_id, current, kind=JOB_KIND_SCORE_WRITE)
        if result is None:
            return None
        status = result["status"]
        if status == "FAILED":
            return failed_job_response(str(result["errorCode"]))
        if status == "PROCESSING":
            return processing_job_response("PROCESSING")
        return result

    def run_worker(self, stop_event: threading.Event) -> None:
        """Serial worker: one write at a time, at least ``min_interval_sec`` apart."""
        while not stop_event.is_set():
            try:
                item = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self._wait_until_due(stop_event)
                if stop_event.is_set():
                    self.repository.mark_failed(
                        item.job_id, "JOB_INTERRUPTED", int(time.time())
                    )
                    return
                self._run(item)
            finally:
                self._slots.release()

    def _wait_until_due(self, stop_event: threading.Event) -> None:
        while not stop_event.is_set():
            remaining = self._next_start_at - time.time()
            if remaining <= 0:
                return
            stop_event.wait(min(remaining, 1.0))

    def _run(self, item: _PendingWrite) -> None:
        self._next_start_at = time.time() + self._min_interval_sec
        outcome = self._handler(item.qr_code, item.scores, confirm=item.confirm)
        now = int(time.time())
        if outcome.status == "SUCCEEDED":
            self.repository.mark_succeeded(
                item.job_id,
                score_write_succeeded_response(outcome.written_count, outcome.verified),
                now,
            )
        else:
            self.repository.mark_failed(
                item.job_id, outcome.error_code or "WRITE_FAILED", now
            )
