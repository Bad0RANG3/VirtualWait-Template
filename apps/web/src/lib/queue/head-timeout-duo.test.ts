import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// node:test runs every test in this file inside one process and the SQLite
// singleton is module-cached, so a single shared temp dir is required.
process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-head-duo-"));
process.env.HEAD_CONFIRM_TIMEOUT_SEC = "180";
process.env.PLAYING_TIMEOUT_SEC = "1500";

function insertUser(db: import("../db/sqlite").Db, id: string, nickname: string, now: string) {
  db.prepare(
    `INSERT INTO app_user (id, nickname, show_rating_public, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`,
  ).run(id, nickname, now, now);
}

function insertDuoParty(
  db: import("../db/sqlite").Db,
  partyId: string,
  hostUserId: string,
  guestUserId: string,
  queueId: string,
  now: string,
) {
  db.prepare(
    `INSERT INTO queue_party
     (id, queue_id, play_mode, status, host_user_id, guest_user_id,
      host_confirmed, guest_confirmed, created_at, updated_at)
     VALUES (?, ?, 'DUO', 'PENDING', ?, ?, 1, 0, ?, ?)`,
  ).run(partyId, queueId, hostUserId, guestUserId, now, now);
}

test("duo head group stamps the late guest and keeps the earliest deadline baseline", async () => {
  const { getDb } = await import("../db");
  const { processTimeouts } = await import("./timeouts");
  const db = getDb();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const hostStamp = new Date(nowMs - 60_000).toISOString();

  insertUser(db, "u1", "Host", now);
  insertUser(db, "u2", "Guest", now);
  insertDuoParty(db, "party-duo", "u1", "u2", "queue-a", now);
  db.prepare(
    `INSERT INTO queue_entry
     (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
      joined_at, head_eligible_at, head_miss_count, created_at, updated_at)
     VALUES
      ('e-host', 'queue-a', 'u1', 'party-duo', 'DUO', 1, 'WAITING', 1, ?, ?, 0, ?, ?),
      ('e-guest', 'queue-a', 'u2', 'party-duo', 'DUO', 2, 'WAITING', 1, ?, NULL, 0, ?, ?)`,
  ).run(now, hostStamp, now, now, now, now, now);
  db.prepare(`UPDATE queue SET next_sequence = 3 WHERE id = 'queue-a'`).run();

  processTimeouts("queue-a");

  const host = db
    .prepare(`SELECT head_eligible_at FROM queue_entry WHERE id = 'e-host'`)
    .get() as { head_eligible_at: string };
  const guest = db
    .prepare(`SELECT head_eligible_at FROM queue_entry WHERE id = 'e-guest'`)
    .get() as { head_eligible_at: string };

  assert.equal(host.head_eligible_at, hostStamp);
  assert.ok(guest.head_eligible_at, "guest must be stamped");

  const deadlineFromHost = new Date(hostStamp).getTime() + 180_000;
  const guestDeadline = new Date(guest.head_eligible_at!).getTime() + 180_000;
  assert.ok(
    guestDeadline >= deadlineFromHost,
    "guest deadline must not be earlier than the group baseline",
  );
});

test("duo alone at head: timeout requeues to the tail and never unloads", async () => {
  const { getDb } = await import("../db");
  const { processTimeouts } = await import("./timeouts");
  const db = getDb();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const staleStamp = new Date(nowMs - 240_000).toISOString();

  insertUser(db, "u3", "Host2", now);
  insertUser(db, "u4", "Guest2", now);
  insertDuoParty(db, "party-duo2", "u3", "u4", "queue-b", now);
  db.prepare(
    `INSERT INTO queue_entry
     (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
      joined_at, head_eligible_at, head_miss_count, created_at, updated_at)
     VALUES
      ('e3', 'queue-b', 'u3', 'party-duo2', 'DUO', 10, 'WAITING', 1, ?, ?, 0, ?, ?),
      ('e4', 'queue-b', 'u4', 'party-duo2', 'DUO', 11, 'WAITING', 1, ?, NULL, 0, ?, ?)`,
  ).run(now, staleStamp, now, now, now, now, now);
  db.prepare(`UPDATE queue SET next_sequence = 12 WHERE id = 'queue-b'`).run();

  processTimeouts("queue-b");

  const row = (id: string) =>
    db
      .prepare(
        `SELECT status, sequence_number, head_miss_count, head_eligible_at FROM queue_entry WHERE id = ?`,
      )
      .get(id) as {
      status: string;
      sequence_number: number;
      head_miss_count: number;
      head_eligible_at: string | null;
    };
  const host = row("e3");
  const guest = row("e4");
  assert.equal(host.status, "WAITING", "duo must not be unloaded");
  assert.equal(host.head_miss_count, 0, "miss count resets");
  assert.ok(host.sequence_number > 10, "host requeued to the tail");
  assert.ok(guest.sequence_number > 11, "guest requeued to the tail");
  // 排到队尾后若仍是唯一队首，markHeadEligibility 会立即重新打新确认戳。
  assert.ok(
    host.head_eligible_at && host.head_eligible_at > staleStamp,
    "countdown restarts with a fresh head window",
  );
  assert.ok(
    guest.head_eligible_at && guest.head_eligible_at > staleStamp,
    "guest gets a fresh stamp too",
  );

  // A second elapsed window also requeues (never unloads / disbands).
  const again = new Date(Date.now() - 240_000).toISOString();
  db.prepare(`UPDATE queue_entry SET head_eligible_at = ? WHERE id IN ('e3','e4')`).run(again);
  processTimeouts("queue-b");

  const afterSecond = db
    .prepare(`SELECT status FROM queue_entry WHERE id IN ('e3','e4') ORDER BY id`)
    .all() as Array<{ status: string }>;
  assert.ok(afterSecond.every((r) => r.status === "WAITING"));
  const party = db
    .prepare(`SELECT status FROM queue_party WHERE id = 'party-duo2'`)
    .get() as { status: string };
  assert.equal(party.status, "PENDING", "party must not be disbanded");
});

test("duo timed out with a next group: the whole duo requeues behind it", async () => {
  const { getDb } = await import("../db");
  const { processTimeouts } = await import("./timeouts");
  const db = getDb();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const staleStamp = new Date(nowMs - 240_000).toISOString();
  const soloStamp = new Date(nowMs - 100_000).toISOString();

  insertUser(db, "u6", "Host3", now);
  insertUser(db, "u7", "Guest3", now);
  insertUser(db, "u8", "Solo", now);
  insertDuoParty(db, "party-duo3", "u6", "u7", "queue-east-a", now);
  db.prepare(
    `INSERT INTO queue_entry
     (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
      joined_at, head_eligible_at, head_miss_count, created_at, updated_at)
     VALUES
      ('e6', 'queue-east-a', 'u6', 'party-duo3', 'DUO', 20, 'WAITING', 1, ?, ?, 0, ?, ?),
      ('e7', 'queue-east-a', 'u7', 'party-duo3', 'DUO', 21, 'WAITING', 1, ?, NULL, 0, ?, ?),
      ('e8', 'queue-east-a', 'u8', NULL, 'SOLO', 22, 'WAITING', 1, ?, ?, 0, ?, ?)`,
  ).run(
    now, staleStamp, now, now, now, now, now,
    now, soloStamp, now, now,
  );
  db.prepare(`UPDATE queue SET next_sequence = 23 WHERE id = 'queue-east-a'`).run();

  processTimeouts("queue-east-a");

  const seq = (id: string) =>
    (db.prepare(`SELECT sequence_number FROM queue_entry WHERE id = ?`).get(id) as {
      sequence_number: number;
    }).sequence_number;
  const miss = (id: string) =>
    (db.prepare(`SELECT head_miss_count FROM queue_entry WHERE id = ?`).get(id) as {
      head_miss_count: number;
    }).head_miss_count;

  assert.ok(seq("e6") > seq("e8"), "duo host must be behind the solo group");
  assert.ok(seq("e7") > seq("e8"), "duo guest must be behind the solo group");
  assert.equal(miss("e6"), 0, "miss count resets under the new rule");
  assert.equal(miss("e7"), 0);
  assert.equal(miss("e8"), 0);

  const party = db
    .prepare(`SELECT status FROM queue_party WHERE id = 'party-duo3'`)
    .get() as { status: string };
  assert.equal(party.status, "PENDING");
});