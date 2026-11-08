import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { migrate } from "./migrate";
import { SCHEMA_SQL } from "./schema";
import { openDatabase } from "./sqlite";

/**
 * Recreate the pre-refactor schema: accounts came from an external QR scan, so
 * `app_user` had no local credentials and identity lived in extra columns.
 */
const LEGACY_SCHEMA = `
CREATE TABLE app_user (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  wechat_openid TEXT UNIQUE,
  wechat_unionid TEXT,
  avatar_url TEXT,
  sdgb_identity_hash TEXT UNIQUE,
  sdgb_user_id_cipher TEXT,
  display_name TEXT,
  rating INTEGER,
  show_rating_public INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  icon_url TEXT,
  profile_snapshot TEXT,
  bound_at TEXT,
  last_login_ip_hash TEXT,
  last_login_day TEXT,
  qq TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE join_attempt (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES app_user(id),
  purpose TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE qr_concurrency_slot (id TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL);
CREATE TABLE completion_token (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
`;

function tableColumns(db: ReturnType<typeof openDatabase>, table: string) {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function tableExists(db: ReturnType<typeof openDatabase>, table: string) {
  return Boolean(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table),
  );
}

test("migrate rebuilds legacy external-identity accounts into local accounts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vw-migrate-"));
  const db = openDatabase(path.join(dir, "legacy.db"));
  db.pragma("foreign_keys = ON");
  db.exec(LEGACY_SCHEMA);

  const now = "2026-05-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO app_user (id, nickname, sdgb_identity_hash, display_name, rating, created_at, updated_at)
     VALUES ('legacy-user', 'LegacyPlayer', 'identity-hash', 'Legacy Display', 12000, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO join_attempt (id, user_id, purpose, idempotency_key, status, expires_at, created_at, updated_at)
     VALUES ('attempt-1', 'legacy-user', 'LOGIN_BIND', 'idem-1', 'SUCCEEDED', ?, ?, ?)`,
  ).run(now, now, now);
  db.prepare(
    `INSERT INTO completion_token (id, attempt_id, created_at_ms) VALUES ('token-1', 'attempt-1', 1)`,
  ).run();

  // The app always applies the current schema first (IF NOT EXISTS keeps the
  // legacy app_user table), then runs the migration.
  db.exec(SCHEMA_SQL);
  migrate(db);

  const columns = tableColumns(db, "app_user");
  for (const required of [
    "id",
    "username",
    "nickname",
    "password_hash",
    "password_salt",
    "password_algo",
    "qq",
    "checkin_venue_id",
    "registered_at",
  ]) {
    assert.ok(columns.includes(required), `app_user must gain ${required}`);
  }
  for (const removed of [
    "sdgb_identity_hash",
    "wechat_openid",
    "rating",
    "title",
    "icon_url",
    "profile_snapshot",
  ]) {
    assert.ok(!columns.includes(removed), `app_user must no longer expose ${removed}`);
  }

  // Legacy accounts have no local password, so the rebuild drops them.
  const survivors = db
    .prepare(`SELECT COUNT(*) AS c FROM app_user`)
    .get() as { c: number };
  assert.equal(Number(survivors.c), 0);

  // Removed identity tables disappear; the current security tables stay.
  for (const gone of ["join_attempt", "qr_concurrency_slot", "completion_token"]) {
    assert.equal(tableExists(db, gone), false, `${gone} must be dropped`);
  }
  for (const kept of ["session", "ip_day_binding", "rate_limit_bucket", "queue_entry", "audit_event"]) {
    assert.ok(tableExists(db, kept), `${kept} must still exist`);
  }

  // Hot-path indexes are created together with the schema, including for
  // databases that already existed before they were introduced.
  const indexes = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  for (const index of [
    "queue_entry_party_idx",
    "audit_event_created_idx",
    "session_issued_idx",
    "one_active_entry_per_user",
  ]) {
    assert.ok(indexes.includes(index), `missing index ${index}`);
  }

  // The rebuilt table accepts a modern account row and is idempotent.
  db.prepare(
    `INSERT INTO app_user
     (id, username, nickname, password_hash, password_salt, password_algo, qq,
      checkin_venue_id, registered_at, last_login_ip_hash, last_login_day,
      created_at, updated_at)
     VALUES ('u1', 'freshuser', 'FreshNick', 'h', 's', 'scrypt-v1', NULL, NULL, ?, NULL, NULL, ?, ?)`,
  ).run(now, now, now);
  migrate(db);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS c FROM app_user`).get() as { c: number }).c,
    1,
    "running the migration again must not wipe local accounts",
  );

  db.exec("PRAGMA foreign_key_check");
});

/**
 * The oldest supported shape: `queue_entry` without `party_id`. SCHEMA_SQL runs
 * before MIGRATIONS_SQL, so anything that references a migrated column (an
 * index, for example) must not live in SCHEMA_SQL or the process cannot start.
 */
const LEGACY_QUEUE_SQL = `
CREATE TABLE venue (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE TABLE queue (id TEXT PRIMARY KEY, venue_id TEXT NOT NULL, name TEXT NOT NULL,
  slug TEXT NOT NULL, status TEXT NOT NULL, next_sequence INTEGER NOT NULL DEFAULT 1,
  called_timeout_sec INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE queue_entry (id TEXT PRIMARY KEY, queue_id TEXT NOT NULL, user_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL, status TEXT NOT NULL, called_at TEXT, no_show_count INTEGER,
  version INTEGER NOT NULL DEFAULT 1, joined_at TEXT NOT NULL, playing_at TEXT,
  finished_at TEXT, cancelled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE app_user (id TEXT PRIMARY KEY, nickname TEXT NOT NULL UNIQUE,
  wechat_openid TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

test("migrate upgrades a queue_entry without party_id and rebuilds its indexes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vw-migrate-queue-"));
  const db = openDatabase(path.join(dir, "legacy-queue.db"));
  db.pragma("foreign_keys = ON");
  db.exec(LEGACY_QUEUE_SQL);
  db.prepare(
    `INSERT INTO queue_entry (id, queue_id, user_id, sequence_number, status, version, joined_at, created_at, updated_at)
     VALUES ('e-old', 'q1', 'u-old', 1, 'WAITING', 1, '2026-05-01T00:00:00.000Z',
             '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')`,
  ).run();

  // Must not throw: this is the upgrade path operators rely on.
  db.exec(SCHEMA_SQL);
  migrate(db);

  const entryColumns = tableColumns(db, "queue_entry");
  assert.ok(entryColumns.includes("party_id"), "party_id must be added");
  const indexes = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  for (const index of [
    "queue_entry_party_idx",
    "audit_event_created_idx",
    "session_issued_idx",
  ]) {
    assert.ok(indexes.includes(index), `missing index ${index} after legacy rebuild`);
  }
  db.exec("PRAGMA foreign_key_check");
});
