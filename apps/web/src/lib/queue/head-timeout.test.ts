import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("head confirm timeout moves group back once then cancels on second miss", async () => {
  process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-head-"));
  process.env.HEAD_CONFIRM_TIMEOUT_SEC = "180";
  process.env.PLAYING_TIMEOUT_SEC = "1500";

  const { getDb } = await import("../db");
  const { processTimeouts, getPublicQueue } = await import("./service");
  const db = getDb();

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const past = new Date(nowMs - 181_000).toISOString();

  for (const [id, nickname] of [
    ["u1", "HeadUser"],
    ["u2", "NextUser"],
  ] as const) {
    db.prepare(
      `INSERT INTO app_user (id, nickname, show_rating_public, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(id, nickname, now, now);
  }

  db.prepare(
    `INSERT INTO queue_entry
      (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
       joined_at, head_eligible_at, head_miss_count, created_at, updated_at)
     VALUES
      ('e1', 'queue-a', 'u1', NULL, 'SOLO', 1, 'WAITING', 1, ?, ?, 0, ?, ?),
      ('e2', 'queue-a', 'u2', NULL, 'SOLO', 2, 'WAITING', 1, ?, NULL, 0, ?, ?)`,
  ).run(now, past, now, now, now, now, now);

  processTimeouts("queue-a");
  const afterFirst = db
    .prepare(
      `SELECT id, sequence_number, head_miss_count, status FROM queue_entry WHERE queue_id = 'queue-a' ORDER BY sequence_number`,
    )
    .all() as Array<{
    id: string;
    sequence_number: number;
    head_miss_count: number;
    status: string;
  }>;
  assert.equal(afterFirst[0]?.id, "e2", "next group should become head");
  assert.equal(afterFirst.find((row) => row.id === "e1")?.head_miss_count, 1);
  assert.equal(afterFirst.find((row) => row.id === "e1")?.status, "WAITING");

  // e1 becomes head again with expired eligibility and miss=1 -> cancel
  db.prepare(
    `UPDATE queue_entry SET sequence_number = -1, head_eligible_at = ?, head_miss_count = 1 WHERE id = 'e1'`,
  ).run(past);
  db.prepare(
    `UPDATE queue_entry SET sequence_number = -2, head_eligible_at = NULL, head_miss_count = 0 WHERE id = 'e2'`,
  ).run();
  db.prepare(
    `UPDATE queue_entry SET sequence_number = 1 WHERE id = 'e1'`,
  ).run();
  db.prepare(
    `UPDATE queue_entry SET sequence_number = 2 WHERE id = 'e2'`,
  ).run();

  processTimeouts("queue-a");
  const e1 = db
    .prepare(`SELECT status FROM queue_entry WHERE id = 'e1'`)
    .get() as { status: string };
  assert.equal(e1.status, "CANCELLED", "second miss should unload the group");

  const snap = getPublicQueue("sample-venue", "machine-a", "u2");
  assert.ok(snap);
  assert.equal(snap!.queue.headConfirmTimeoutSec, 180);
});
