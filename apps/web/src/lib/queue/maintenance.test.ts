import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function scalar(
  db: { prepare(sql: string): { get(...params: string[]): unknown } },
  sql: string,
  ...params: string[]
) {
  return db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
}

test("maintenance applies configured privacy retention policies", async () => {
  process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(
    path.join(tmpdir(), "vw-maintenance-"),
  );
  process.env.IP_BINDING_RETENTION_DAYS = "2";
  process.env.PROFILE_DATA_RETENTION_DAYS = "30";
  process.env.QUEUE_HISTORY_RETENTION_DAYS = "30";
  process.env.AUDIT_EVENT_RETENTION_DAYS = "90";
  process.env.TRANSIENT_DATA_RETENTION_SEC = "86400";
  process.env.RATE_LIMIT_BUCKET_RETENTION_SEC = "3600";

  const { getDb } = await import("../db");
  const { runMaintenance } = await import("./maintenance");
  const db = getDb();
  const now = "2026-07-16T08:00:00.000Z";
  const old = "2026-05-01T00:00:00.000Z";
  const recent = "2026-07-01T00:00:00.000Z";

  for (const user of [
    "history-user",
    "recent-user",
    "stale-user",
    "active-user",
  ]) {
    db.prepare(
      `INSERT INTO app_user
       (id, nickname, sdgb_identity_hash, display_name, rating, title, icon_url,
        avatar_url, profile_snapshot, last_login_ip_hash, last_login_day,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      user,
      user,
      `${user}-identity`,
      user === "history-user" || user === "recent-user"
        ? null
        : `${user} display`,
      user === "history-user" || user === "recent-user" ? null : 12345,
      user === "history-user" || user === "recent-user" ? null : "title",
      user === "history-user" || user === "recent-user"
        ? null
        : "https://example.test/icon.png",
      user === "history-user" || user === "recent-user"
        ? null
        : "https://example.test/avatar.png",
      user === "history-user" || user === "recent-user"
        ? null
        : JSON.stringify({ rating: 12345 }),
      user === "history-user" || user === "recent-user" ? null : "a".repeat(64),
      user === "history-user" || user === "recent-user" ? null : "2026-05-01",
      old,
      user === "recent-user" ? recent : old,
    );
  }

  db.prepare(
    `INSERT INTO queue_party
     (id, queue_id, play_mode, status, host_user_id, guest_user_id,
      host_confirmed, guest_confirmed, created_at, updated_at)
     VALUES ('party-old', 'queue-old', 'DUO', 'CONFIRMED', 'history-user', 'recent-user', 1, 1, ?, ?)`,
  ).run(old, old);

  db.prepare(
    `INSERT INTO queue_entry
     (id, queue_id, user_id, party_id, play_mode, sequence_number, status,
      version, joined_at, finished_at, created_at, updated_at)
     VALUES ('entry-old', 'queue-old', 'history-user', 'party-old', 'DUO', 100, 'DONE', 1, ?, ?, ?, ?)`,
  ).run(old, old, old, old);
  db.prepare(
    `INSERT INTO queue_entry
     (id, queue_id, user_id, party_id, play_mode, sequence_number, status,
      version, joined_at, finished_at, created_at, updated_at)
     VALUES ('entry-recent', 'queue-old', 'recent-user', NULL, 'SOLO', 101, 'DONE', 1, ?, ?, ?, ?)`,
  ).run(recent, recent, recent, recent);
  db.prepare(
    `INSERT INTO queue_entry
     (id, queue_id, user_id, party_id, play_mode, sequence_number, status,
      version, joined_at, created_at, updated_at)
     VALUES ('entry-active', 'queue-new', 'active-user', NULL, 'SOLO', 102, 'WAITING', 1, ?, ?, ?)`,
  ).run(old, old, old);


  db.prepare(
    `INSERT INTO ip_day_binding (ip_hash, day_key, user_id, created_at, updated_at)
     VALUES (?, '2026-05-01', 'stale-user', ?, ?),
            (?, '2026-07-16', 'active-user', ?, ?)`,
  ).run("b".repeat(64), old, old, "c".repeat(64), recent, recent);

  db.prepare(
    `INSERT INTO audit_event
     (id, actor_type, actor_id, action, resource_type, resource_id, metadata, request_id, created_at)
     VALUES ('audit-old', 'SYSTEM', NULL, 'OLD', 'queue_entry', 'entry-old', '{}', 'req-old', ?),
            ('audit-recent', 'SYSTEM', NULL, 'RECENT', 'queue_entry', 'entry-recent', '{}', 'req-recent', ?)`,
  ).run("2026-03-01T00:00:00.000Z", recent);

  const result = runMaintenance(now);

  assert.equal(result.terminalQueueEntriesDeleted, 1);
  assert.equal(result.queuePartiesDeleted, 1);
  assert.equal(result.auditEventsDeleted, 1);
  assert.equal(result.expiredIpDayBindingsDeleted, 1);
  assert.equal(result.staleProfilesScrubbed, 1);

  assert.equal(
    scalar(db, "SELECT id FROM queue_entry WHERE id = ?", "entry-old"),
    undefined,
  );
  assert.equal(
    scalar(db, "SELECT id FROM queue_party WHERE id = ?", "party-old"),
    undefined,
  );
  assert.equal(
    scalar(db, "SELECT id FROM audit_event WHERE id = ?", "audit-old"),
    undefined,
  );
  assert.equal(
    scalar(
      db,
      "SELECT day_key FROM ip_day_binding WHERE ip_hash = ?",
      "b".repeat(64),
    ),
    undefined,
  );
  assert.equal(
    (
      scalar(
        db,
        "SELECT day_key FROM ip_day_binding WHERE ip_hash = ?",
        "c".repeat(64),
      ) as { day_key: string }
    ).day_key,
    "2026-07-16",
  );
  assert.equal(
    (
      scalar(db, "SELECT id FROM queue_entry WHERE id = ?", "entry-recent") as {
        id: string;
      }
    ).id,
    "entry-recent",
  );
  assert.equal(
    (
      scalar(db, "SELECT id FROM audit_event WHERE id = ?", "audit-recent") as {
        id: string;
      }
    ).id,
    "audit-recent",
  );

  const stale = scalar(
    db,
    "SELECT display_name, rating, title, icon_url, avatar_url, profile_snapshot, last_login_ip_hash, last_login_day FROM app_user WHERE id = ?",
    "stale-user",
  ) as Record<string, unknown>;
  assert.deepEqual(Object.values(stale), [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ]);

  const active = scalar(
    db,
    "SELECT display_name, rating, title, icon_url, avatar_url, profile_snapshot, last_login_ip_hash, last_login_day FROM app_user WHERE id = ?",
    "active-user",
  ) as Record<string, unknown>;
  assert.equal(active.display_name, "active-user display");
  assert.equal(active.rating, 12345);
});
