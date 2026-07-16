import fs from "fs";
import path from "path";
import { SCHEMA_SQL, MIGRATIONS_SQL } from "./schema";
import { openDatabase, type Db } from "./sqlite";
import { MACHINES, VENUE } from "../constants/venue";

const globalForDb = globalThis as unknown as {
  __vwDb?: Db;
};

function dbPath() {
  const configured = process.env.VIRTUALWAIT_DATA_DIR;
  const dir = configured
    ? path.resolve(configured)
    : path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "virtualwait.db");
}

function seed(db: Db) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO venue (id, name, slug, timezone, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  ).run(VENUE.id, VENUE.name, VENUE.slug, VENUE.timezone, now, now);

  for (const m of MACHINES) {
    db.prepare(
      `INSERT OR IGNORE INTO queue
       (id, venue_id, name, slug, status, next_sequence, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'OPEN', 1, ?, ?)`
    ).run(m.id, m.venueId, m.name, m.slug, now, now);
  }
}


function ensureSecurityTables(db: Db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS ip_day_binding (
  ip_hash TEXT NOT NULL,
  day_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_user(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ip_hash, day_key)
);

CREATE TABLE IF NOT EXISTS rate_limit_bucket (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qr_concurrency_slot (
  id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL
);
`);
}

function migrate(db: Db) {
  for (const sql of MIGRATIONS_SQL) {
    try {
      db.exec(sql);
    } catch {
      // column may already exist
    }
  }

  // Older local DBs required password_hash/salt NOT NULL; WeChat-only users need null.
  ensureWechatPasswordNullable(db);
  removeOnSiteCallArtifacts(db);
  ensureSecurityTables(db);
}

function tableSql(db: Db, name: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { sql?: string } | undefined;
  return row?.sql || "";
}

function ensureWechatPasswordNullable(db: Db) {
  const sql = tableSql(db, "app_user");
  if (!sql) return;
  // Only rebuild when legacy NOT NULL constraints remain on password columns.
  const needsRebuild =
    /password_hash\s+TEXT\s+NOT\s+NULL/i.test(sql) ||
    /password_salt\s+TEXT\s+NOT\s+NULL/i.test(sql);
  if (!needsRebuild) return;

  // FK children (queue_entry, etc.) block DROP TABLE while foreign_keys=ON.
  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE app_user__new (
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const cols = db
      .prepare(`PRAGMA table_info(app_user)`)
      .all() as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    const wanted = [
      "id",
      "nickname",
      "password_hash",
      "password_salt",
      "wechat_openid",
      "wechat_unionid",
      "avatar_url",
      "sdgb_identity_hash",
      "sdgb_user_id_cipher",
      "display_name",
      "rating",
      "show_rating_public",
      "title",
      "icon_url",
      "profile_snapshot",
      "bound_at",
      "last_login_ip_hash",
      "last_login_day",
      "created_at",
      "updated_at",
    ];
    const selectList = wanted
      .map((c) =>
        existing.has(c)
          ? c
          : c === "show_rating_public"
            ? `1 AS ${c}`
            : `NULL AS ${c}`
      )
      .join(", ");

    db.exec(
      `INSERT INTO app_user__new (${wanted.join(", ")})
       SELECT ${selectList} FROM app_user`
    );
    db.exec(`DROP TABLE app_user`);
    db.exec(`ALTER TABLE app_user__new RENAME TO app_user`);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

/**
 * Rebuild legacy local tables so retired queue-state artifacts and data cannot
 * be revived by an existing SQLite file.
 */
function removeOnSiteCallArtifacts(db: Db) {
  const queueEntrySql = tableSql(db, "queue_entry");
  const queueSql = tableSql(db, "queue");
  const needsRebuild =
    /\bCALLED\b|called_at|no_show_count/i.test(queueEntrySql) ||
    /called_timeout_sec/i.test(queueSql);
  const hasSwapTables = Boolean(tableSql(db, "swap_request") || tableSql(db, "swap_vote"));
  if (!needsRebuild && !hasSwapTables) return;

  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec("DROP TABLE IF EXISTS swap_vote; DROP TABLE IF EXISTS swap_request;");
    if (needsRebuild) {
      db.exec(`
        CREATE TABLE queue__new (
          id TEXT PRIMARY KEY,
          venue_id TEXT NOT NULL REFERENCES venue(id),
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('OPEN','PAUSED','CLOSED')),
          next_sequence INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(venue_id, slug)
        );
        INSERT INTO queue__new (id, venue_id, name, slug, status, next_sequence, created_at, updated_at)
        SELECT id, venue_id, name, slug, status, next_sequence, created_at, updated_at FROM queue;

        CREATE TABLE queue_entry__new (
          id TEXT PRIMARY KEY,
          queue_id TEXT NOT NULL REFERENCES queue(id),
          user_id TEXT NOT NULL REFERENCES app_user(id),
          party_id TEXT REFERENCES queue_party(id),
          play_mode TEXT NOT NULL DEFAULT 'SOLO' CHECK (play_mode IN ('SOLO','DUO')),
          sequence_number INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('WAITING','PLAYING','DONE','CANCELLED','EXPIRED')),
          version INTEGER NOT NULL DEFAULT 1,
          joined_at TEXT NOT NULL,
          playing_at TEXT,
          finished_at TEXT,
          cancelled_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(queue_id, sequence_number)
        );
        INSERT INTO queue_entry__new
          (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
           joined_at, playing_at, finished_at, cancelled_at, created_at, updated_at)
        SELECT id, queue_id, user_id, party_id, play_mode, sequence_number,
               CASE WHEN status IN ('WAITING','PLAYING','DONE','CANCELLED','EXPIRED') THEN status ELSE 'WAITING' END,
               version, joined_at, playing_at, finished_at, cancelled_at, created_at, updated_at
        FROM queue_entry;

        DROP INDEX IF EXISTS one_active_entry_per_user;
        DROP TABLE queue_entry;
        DROP TABLE queue;
        ALTER TABLE queue__new RENAME TO queue;
        ALTER TABLE queue_entry__new RENAME TO queue_entry;
        CREATE UNIQUE INDEX one_active_entry_per_user
          ON queue_entry (user_id) WHERE status IN ('WAITING','PLAYING');
      `);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export function getDb() {
  if (!globalForDb.__vwDb) {
    const db = openDatabase(dbPath());
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    migrate(db);
    seed(db);
    globalForDb.__vwDb = db;
  }
  return globalForDb.__vwDb;
}

export function nowIso() {
  return new Date().toISOString();
}

export function addSeconds(iso: string, seconds: number) {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}
