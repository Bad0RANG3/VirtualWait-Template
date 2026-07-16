from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3
import time
from typing import Any


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS verification_job (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'LOGGING_OUT', 'SUCCEEDED', 'FAILED')),
  public_result TEXT,
  error_code TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS used_nonce (
  nonce_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_bucket (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Reserved for a future real provider. It must contain encrypted recovery
-- material only, never a raw token or an unencrypted user ID.
CREATE TABLE IF NOT EXISTS pending_logout (
  job_id TEXT PRIMARY KEY REFERENCES verification_job(id),
  encrypted_context BLOB NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
"""


class Repository:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def claim_nonce(self, nonce: str, expires_at: int, now: int) -> bool:
        nonce_hash = hashlib.sha256(nonce.encode("utf-8")).hexdigest()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute("DELETE FROM used_nonce WHERE expires_at < ?", (now,))
                connection.execute(
                    "INSERT INTO used_nonce (nonce_hash, expires_at, created_at) VALUES (?, ?, ?)",
                    (nonce_hash, expires_at, now),
                )
            except sqlite3.IntegrityError:
                connection.execute("ROLLBACK")
                return False
            connection.execute("COMMIT")
        return True

    def consume_rate_limit(self, key: str, limit: int, window_seconds: int, now: int) -> bool:
        window_start = now - (now % window_seconds)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT window_start, count FROM rate_limit_bucket WHERE key = ?", (key,)
            ).fetchone()
            if row is None or row["window_start"] != window_start:
                connection.execute(
                    "INSERT INTO rate_limit_bucket (key, window_start, count, updated_at) VALUES (?, ?, 1, ?) "
                    "ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1, updated_at = excluded.updated_at",
                    (key, window_start, now),
                )
                connection.execute("COMMIT")
                return True
            if row["count"] >= limit:
                connection.execute("COMMIT")
                return False
            connection.execute(
                "UPDATE rate_limit_bucket SET count = count + 1, updated_at = ? WHERE key = ?",
                (now, key),
            )
            connection.execute("COMMIT")
        return True

    def create_job(self, job_id: str, now: int, expires_at: int) -> None:
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO verification_job (id, status, public_result, error_code, expires_at, created_at, updated_at) "
                "VALUES (?, 'PROCESSING', NULL, NULL, ?, ?, ?)",
                (job_id, expires_at, now, now),
            )

    def mark_succeeded(self, job_id: str, result: dict[str, Any], now: int) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE verification_job SET status = 'SUCCEEDED', public_result = ?, error_code = NULL, updated_at = ? "
                "WHERE id = ? AND status = 'PROCESSING'",
                (json.dumps(result, separators=(",", ":"), ensure_ascii=False), now, job_id),
            )

    def mark_logging_out(
        self, job_id: str, result: dict[str, Any], encrypted_context: bytes, now: int
    ) -> None:
        """Persist only safe public output plus an opaque provider recovery context."""
        encoded_result = json.dumps(result, separators=(",", ":"), ensure_ascii=False)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "UPDATE verification_job SET status = 'LOGGING_OUT', public_result = ?, error_code = NULL, updated_at = ? "
                "WHERE id = ? AND status = 'PROCESSING'",
                (encoded_result, now, job_id),
            )
            connection.execute(
                "INSERT INTO pending_logout (job_id, encrypted_context, attempt_count, next_retry_at, last_error_code, created_at, updated_at) "
                "VALUES (?, ?, 0, ?, NULL, ?, ?) "
                "ON CONFLICT(job_id) DO UPDATE SET encrypted_context = excluded.encrypted_context, next_retry_at = excluded.next_retry_at, updated_at = excluded.updated_at",
                (job_id, encrypted_context, now, now, now),
            )
            connection.execute("COMMIT")

    def mark_failed(self, job_id: str, error_code: str, now: int) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM pending_logout WHERE job_id = ?", (job_id,))
            connection.execute(
                "UPDATE verification_job SET status = 'FAILED', public_result = NULL, error_code = ?, updated_at = ? "
                "WHERE id = ? AND status IN ('PROCESSING', 'LOGGING_OUT')",
                (error_code, now, job_id),
            )

    def get_job(self, job_id: str, now: int) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT status, public_result, error_code, expires_at FROM verification_job WHERE id = ?", (job_id,)
            ).fetchone()
            if row is None:
                return None
            if row["expires_at"] < now and row["status"] in {"PROCESSING", "LOGGING_OUT"}:
                connection.execute(
                    "UPDATE verification_job SET status = 'FAILED', error_code = 'JOB_EXPIRED', updated_at = ? WHERE id = ?",
                    (now, job_id),
                )
                connection.execute("DELETE FROM pending_logout WHERE job_id = ?", (job_id,))
                return {"status": "FAILED", "errorCode": "JOB_EXPIRED"}
            if row["status"] == "SUCCEEDED" and row["public_result"]:
                return json.loads(row["public_result"])
            if row["status"] == "FAILED":
                return {"status": "FAILED", "errorCode": row["error_code"] or "INTERNAL_ERROR"}
            return {"status": row["status"]}

    def due_pending_logouts(self, now: int) -> list[tuple[str, bytes]]:
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT p.job_id, p.encrypted_context
                 FROM pending_logout p
                 JOIN verification_job j ON j.id = p.job_id
                 WHERE p.next_retry_at <= ? AND j.status = 'LOGGING_OUT'""",
                (now,),
            ).fetchall()
        return [(str(row["job_id"]), bytes(row["encrypted_context"])) for row in rows]

    def complete_pending_logout(self, job_id: str, now: int) -> bool:
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT public_result FROM verification_job WHERE id = ? AND status = 'LOGGING_OUT'",
                (job_id,),
            ).fetchone()
            if row is None or not row["public_result"]:
                connection.execute("ROLLBACK")
                return False
            connection.execute(
                "UPDATE verification_job SET status = 'SUCCEEDED', updated_at = ? WHERE id = ?",
                (now, job_id),
            )
            connection.execute("DELETE FROM pending_logout WHERE job_id = ?", (job_id,))
            connection.execute("COMMIT")
        return True

    def defer_pending_logout(self, job_id: str, error_code: str, now: int) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE pending_logout SET attempt_count = attempt_count + 1, next_retry_at = ?, last_error_code = ?, updated_at = ? WHERE job_id = ?",
                (now + 30, error_code, now, job_id),
            )

    def raw_database_bytes_for_test(self) -> bytes:
        """Test-only helper; application paths never need to inspect raw database data."""
        return self.database_path.read_bytes() if self.database_path.exists() else b""

    def healthcheck(self) -> bool:
        """Verify the persistent store is available without returning any data."""
        try:
            with self._connect() as connection:
                connection.execute("SELECT 1").fetchone()
        except sqlite3.Error:
            return False
        return True
