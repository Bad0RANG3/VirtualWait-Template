import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("finish play requeues to the tail (user solo, admin duo) instead of unloading", async () => {
  process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-finish-"));
  process.env.HEAD_CONFIRM_TIMEOUT_SEC = "180";
  process.env.PLAYING_TIMEOUT_SEC = "1500";

  const { getDb } = await import("../db");
  const { finishPlay, cancelEntry, adminEntryAction } = await import("./service");
  const db = getDb();

  const now = new Date().toISOString();
  for (const [id, nickname, qq] of [
    ["u1", "PlayerOne", "111111"],
    ["u2", "PlayerTwo", "222222"],
    ["u3", "PlayerThree", "333333"],
    ["u4", "PlayerFour", "444444"],
    ["u5", "PlayerFive", "555555"],
  ] as const) {
    db.prepare(
      `INSERT INTO app_user (id, nickname, show_rating_public, qq, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?)`,
    ).run(id, nickname, qq, now, now);
  }

  // ---- Scenario 1: user solo finish --------------------------------------
  // e1 is PLAYING, e2 is WAITING behind it; queue-a already used seq 1..2.
  db.prepare(
    `INSERT INTO queue_entry
      (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
       joined_at, playing_at, created_at, updated_at)
     VALUES
      ('e1', 'queue-a', 'u1', NULL, 'SOLO', 1, 'PLAYING', 1, ?, ?, ?, ?),
      ('e2', 'queue-a', 'u2', NULL, 'SOLO', 2, 'WAITING', 1, ?, NULL, ?, ?)`,
  ).run(now, now, now, now, now, now, now);
  db.prepare(`UPDATE queue SET next_sequence = 3 WHERE id = 'queue-a'`).run();

  finishPlay("e1", "u1");

  const rows = db
    .prepare(
      `SELECT id, status, sequence_number, playing_at, finished_at
       FROM queue_entry WHERE queue_id = 'queue-a' ORDER BY sequence_number`,
    )
    .all() as Array<{
    id: string;
    status: string;
    sequence_number: number;
    playing_at: string | null;
    finished_at: string | null;
  }>;

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.id, "e2", "waiting player stays at head");
  assert.equal(rows[1]?.id, "e1", "finished player requeues to the tail");
  assert.equal(rows[1]?.status, "WAITING");
  assert.ok(rows[1]!.sequence_number > rows[0]!.sequence_number);
  assert.equal(rows[1]?.playing_at, null);
  assert.equal(rows[1]?.finished_at, null);

  // The finished player can still leave by cancelling while waiting.
  cancelEntry("e1", "u1");
  const cancelled = db
    .prepare(`SELECT status FROM queue_entry WHERE id = 'e1'`)
    .get() as { status: string };
  assert.equal(cancelled.status, "CANCELLED");

  // ---- Scenario 2: admin finish on a duo ---------------------------------
  // p1 (u3 host + u4 guest) is PLAYING, e5 (u5) WAITING; seq 4..6 used.
  db.prepare(
    `INSERT INTO queue_party
      (id, queue_id, play_mode, status, host_user_id, guest_user_id, host_confirmed, guest_confirmed, created_at, updated_at)
     VALUES ('p1', 'queue-b', 'DUO', 'CONFIRMED', 'u3', 'u4', 1, 1, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO queue_entry
      (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
       joined_at, playing_at, created_at, updated_at)
     VALUES
      ('e3', 'queue-b', 'u3', 'p1', 'DUO', 4, 'PLAYING', 1, ?, ?, ?, ?),
      ('e4', 'queue-b', 'u4', 'p1', 'DUO', 5, 'PLAYING', 1, ?, ?, ?, ?),
      ('e5', 'queue-b', 'u5', NULL, 'SOLO', 6, 'WAITING', 1, ?, NULL, ?, ?)`,
  ).run(now, now, now, now, now, now, now, now, now, now, now);
  db.prepare(`UPDATE queue SET next_sequence = 7 WHERE id = 'queue-b'`).run();

  adminEntryAction("e3", 1, "FINISH", "admin-1");

  const rows2 = db
    .prepare(
      `SELECT id, status, sequence_number FROM queue_entry WHERE queue_id = 'queue-b' ORDER BY sequence_number`,
    )
    .all() as Array<{ id: string; status: string; sequence_number: number }>;

  assert.equal(rows2[0]?.id, "e5", "waiting player becomes head");
  const duo = rows2.filter((r) => r.id === "e3" || r.id === "e4");
  assert.equal(duo.length, 2, "both duo members requeue to the tail");
  assert.ok(duo.every((r) => r.status === "WAITING"));
  assert.ok(duo.every((r) => r.sequence_number > rows2[0]!.sequence_number));
});