import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Db } from "../db/sqlite";

// node:test runs every test in this file inside one process and the SQLite
// singleton is module-cached, so a single shared temp dir is required.
process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-join-race-"));

function seedUsers(db: Db, ids: string[]) {
  const now = new Date().toISOString();
  for (const id of ids) {
    db.prepare(
      `INSERT INTO app_user (id, nickname, show_rating_public, qq, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?)`,
    ).run(id, id, `q${id}`, now, now);
  }
}

function openAllDay() {
  const { updateVenueMeta } = require("../settings/venue-meta") as typeof import("../settings/venue-meta");
  updateVenueMeta("venue-sample-central", {
    address: "addr",
    regionName: "示例区",
    regionKind: "district",
    machineCount: 2,
    openMinute: 0,
    closeMinute: 24 * 60 - 1,
  });
}

test("one active entry per user is enforced even if the pre-check is raced", async () => {
  const { getDb } = await import("../db");
  const { joinQueue } = await import("./user-actions");
  const db = getDb();
  const now = new Date().toISOString();
  openAllDay();
  seedUsers(db, ["a1"]);

  const first = joinQueue("queue-a", "a1", "SOLO");
  assert.ok(first.entryId);

  // The partial unique index (the final authority under concurrency) rejects
  // a duplicate WAITING row for the same user even when written directly.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO queue_entry
           (id, queue_id, user_id, party_id, play_mode, sequence_number, status,
            version, joined_at, created_at, updated_at)
           VALUES (?, 'queue-a', 'a1', NULL, 'SOLO', 99, 'WAITING', 1, ?, ?, ?)`,
        )
        .run("e-dup", now, now, now),
    /UNIQUE constraint failed/,
  );

  // joinQueue surfaces the friendly error rather than a 500.
  assert.throws(() => joinQueue("queue-a", "a1", "SOLO"), /ALREADY_IN_ANOTHER_QUEUE/);
});

test("duo party seat is claimed atomically under concurrent joins", async () => {
  const { getDb } = await import("../db");
  const { joinQueue } = await import("./user-actions");
  const db = getDb();
  openAllDay();
  seedUsers(db, ["b1", "b2", "b3"]);

  const host = joinQueue("queue-b", "b1", "DUO");
  assert.ok(host.partyId);

  const winner = joinQueue("queue-b", "b2", "DUO", host.partyId);
  assert.ok(winner.entryId);
  // The second guest wins the guarded claim; a third joiner finds the
  // party already claimed (status flipped to PENDING) — no orphan entry.
  assert.throws(() => joinQueue("queue-b", "b3", "DUO", host.partyId), /PARTY_NOT_SEEKING/);

  const members = db
    .prepare(`SELECT COUNT(*) AS c FROM queue_entry WHERE party_id = ?`)
    .get(host.partyId) as { c: number };
  assert.equal(Number(members.c), 2);
  const party = db
    .prepare(`SELECT guest_user_id, status FROM queue_party WHERE id = ?`)
    .get(host.partyId) as { guest_user_id: string | null; status: string };
  assert.equal(party.guest_user_id, "b2");
  assert.equal(party.status, "PENDING");
});
