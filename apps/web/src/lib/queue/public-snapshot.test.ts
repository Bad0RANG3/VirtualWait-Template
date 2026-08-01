import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-public-cap-"));

function seedUsers(db: import("../db/sqlite").Db, ids: string[]) {
  const now = new Date().toISOString();
  for (const id of ids) {
    db.prepare(
      `INSERT INTO app_user (id, nickname, show_rating_public, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(id, id, now, now);
  }
}

function seedWaiting(db: import("../db/sqlite").Db, queueId: string, count: number, fromSeq: number) {
  const now = new Date().toISOString();
  const users = Array.from({ length: count }, (_, i) => `u-${fromSeq + i}`);
  seedUsers(db, users);
  const insert = db.prepare(
    `INSERT INTO queue_entry
     (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
      joined_at, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'SOLO', ?, 'WAITING', 1, ?, ?, ?)`,
  );
  for (let i = 0; i < count; i++) {
    const seq = fromSeq + i;
    insert.run(`e-${seq}`, queueId, `u-${seq}`, seq, now, now, now);
  }
}

test("public snapshot caps the waiting list and reports the true total", async () => {
  const { getDb } = await import("../db");
  const { getPublicQueue } = await import("./public");
  const db = getDb();
  const queue = db
    .prepare(`SELECT id, status FROM queue WHERE venue_id = (SELECT id FROM venue WHERE slug = 'sample-venue') AND slug = 'machine-a'`)
    .get() as { id: string; status: string };
  assert.ok(queue, "catalog queue must be seeded");

  const now = new Date().toISOString();
  seedUsers(db, ["u-playing"]);
  db.prepare(
    `INSERT INTO queue_entry
     (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
      joined_at, created_at, updated_at)
     VALUES ('e-playing', ?, 'u-playing', NULL, 'SOLO', 0, 'PLAYING', 1, ?, ?, ?)`,
  ).run(queue.id, now, now, now);
  seedWaiting(db, queue.id, 250, 1);

  const snapshot = getPublicQueue("sample-venue", "machine-a");
  assert.ok(snapshot);
  assert.equal(snapshot.totalWaiting, 250);
  // Every PLAYING row is kept; waiting is truncated to 200 - playing(1).
  assert.equal(snapshot.entries.length, 200);
  assert.equal(snapshot.entries[0].status, "PLAYING");
  const waitingSeqs = snapshot.entries
    .filter((e) => e.status === "WAITING")
    .map((e) => e.sequenceNumber);
  assert.equal(waitingSeqs[0], 1, "earliest waiting entries are kept");
  assert.equal(waitingSeqs.at(-1), 199);
});
