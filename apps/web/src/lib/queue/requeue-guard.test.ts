import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { insertTestUsers } from "../testing/users";

process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-guard-"));
process.env.PLAYING_TIMEOUT_SEC = "1500";
process.env.HEAD_CONFIRM_TIMEOUT_SEC = "180";

type EntryRow = {
  status: string;
  sequence_number: number;
  cancelled_at: string | null;
};

async function entryRow(id: string): Promise<EntryRow> {
  const { getDb } = await import("../db");
  return getDb()
    .prepare(`SELECT status, sequence_number, cancelled_at FROM queue_entry WHERE id = ?`)
    .get(id) as EntryRow;
}

test("a timeout requeue cannot resurrect an entry that was just cancelled", async () => {
  const { getDb } = await import("../db");
  const { requeueToEnd, finishOrExpireEntry } = await import("./core");
  const db = getDb();
  const now = new Date().toISOString();

  insertTestUsers(db, [{ id: "u-race", nickname: "RacePlayer", qq: "10011" }], now);
  db.prepare(
    `INSERT INTO queue_entry
      (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
       joined_at, created_at, updated_at)
     VALUES ('e-race', 'queue-a', 'u-race', NULL, 'SOLO', 7, 'WAITING', 1, ?, ?, ?)`,
  ).run(now, now, now);

  // The user cancels first (what the maintenance process can lose a race to).
  assert.equal(
    finishOrExpireEntry("e-race", "CANCELLED", "USER", "u-race", undefined, ["WAITING"]),
    true,
  );

  // The concurrent head-timeout requeue must be dropped, not write WAITING back.
  assert.equal(
    requeueToEnd("queue-a", "e-race", ["WAITING"]),
    false,
    "a cancelled entry must never be requeued",
  );

  const row = await entryRow("e-race");
  assert.equal(row.status, "CANCELLED");
  assert.equal(row.sequence_number, 7, "the cancelled entry keeps its sequence");
  assert.ok(row.cancelled_at, "cancelled_at must not be cleared");
});

test("finish/cancel is a no-op once the entry left the active states", async () => {
  const { getDb } = await import("../db");
  const { finishOrExpireEntry } = await import("./core");
  const db = getDb();
  const now = new Date().toISOString();

  insertTestUsers(db, [{ id: "u-guard", nickname: "GuardPlayer" }], now);
  db.prepare(
    `INSERT INTO queue_entry
      (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
       joined_at, finished_at, created_at, updated_at)
     VALUES ('e-guard', 'queue-a', 'u-guard', NULL, 'SOLO', 8, 'DONE', 1, ?, ?, ?, ?)`,
  ).run(now, now, now, now);

  assert.equal(
    finishOrExpireEntry("e-guard", "CANCELLED", "USER", "u-guard", undefined, ["WAITING"]),
    false,
  );
  assert.equal((await entryRow("e-guard")).status, "DONE");
});
