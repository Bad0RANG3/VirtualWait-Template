import type { Db } from "./sqlite";
import { MIGRATIONS_SQL } from "./schema";

/** Apply idempotent column/table additions.  Suppress only the known
 *  SQLite "duplicate column" error; propagate unexpected failures. */
export function migrate(db: Db) {
  for (const sql of MIGRATIONS_SQL) {
    try {
      db.exec(sql);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // SQLite error 1 with "duplicate column name" means the column already
      // exists — that is expected on second+ startup.  Everything else is
      // a real problem and must be surfaced.
      if (/duplicate column name/i.test(msg)) continue;
      throw err;
    }
  }

  _ensureWechatPasswordNullable(db);
  _removeOnSiteCallArtifacts(db);
  _ensureSecurityTables(db);
  _ensureIpDayBindingQuota(db);
}

// ---------------------------------------------------------------------------
// Internal helpers — only called from migrate() above
// ---------------------------------------------------------------------------

function _tableSql(db: Db, name: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { sql?: string } | undefined;
  return row?.sql || "";
}

function _ensureSecurityTables(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_day_binding (
      ip_hash TEXT NOT NULL, day_key TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES app_user(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (ip_hash, day_key, user_id)
    );
    CREATE TABLE IF NOT EXISTS rate_limit_bucket (
      key TEXT PRIMARY KEY, window_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qr_concurrency_slot (
      id TEXT PRIMARY KEY, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS completion_token (
      id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_user(id),
      ip_hash TEXT NOT NULL, issued_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER
    );
    -- Every session query hits the primary key; the old (user_id) index was
    -- never used. Drop it so existing databases converge with new installs.
    DROP INDEX IF EXISTS idx_session_user;
  `);
}

/**
 * Rebuild legacy ip_day_binding tables whose primary key only allowed one
 * account per IP per day. The quota model needs one row per
 * (ip_hash, day_key, user_id).
 *
 * NOTE: the legacy/new detection below parses the CREATE TABLE text that
 * SQLite stores in sqlite_master (quoted identifiers are preserved as-is).
 * If a future SQLite version changes how table DDL is persisted, re-check
 * both regexes against `SELECT sql FROM sqlite_master WHERE type='table'`.
 */
function _ensureIpDayBindingQuota(db: Db) {
  const sql = _tableSql(db, "ip_day_binding");
  if (!sql) return;
  const isLegacy = /PRIMARY\s+KEY\s*\(\s*ip_hash\s*,\s*day_key\s*\)/i.test(sql) &&
    !/PRIMARY\s+KEY\s*\(\s*ip_hash\s*,\s*day_key\s*,\s*user_id\s*\)/i.test(sql);
  if (!isLegacy) return;

  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE ip_day_binding__new (
        ip_hash TEXT NOT NULL, day_key TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES app_user(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (ip_hash, day_key, user_id)
      );
      INSERT INTO ip_day_binding__new (ip_hash, day_key, user_id, created_at, updated_at)
        SELECT ip_hash, day_key, user_id, created_at, updated_at FROM ip_day_binding;
      DROP TABLE ip_day_binding;
      ALTER TABLE ip_day_binding__new RENAME TO ip_day_binding;
    `);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function _ensureWechatPasswordNullable(db: Db) {
  const sql = _tableSql(db, "app_user");
  if (!sql) return;
  const needsRebuild =
    /password_hash\s+TEXT\s+NOT\s+NULL/i.test(sql) ||
    /password_salt\s+TEXT\s+NOT\s+NULL/i.test(sql);
  if (!needsRebuild) return;

  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE app_user__new (
        id TEXT PRIMARY KEY, nickname TEXT NOT NULL UNIQUE,
        password_hash TEXT, password_salt TEXT,
        wechat_openid TEXT UNIQUE, wechat_unionid TEXT, avatar_url TEXT,
        sdgb_identity_hash TEXT UNIQUE, sdgb_user_id_cipher TEXT,
        display_name TEXT, rating INTEGER,
        show_rating_public INTEGER NOT NULL DEFAULT 1,
        title TEXT, icon_url TEXT, profile_snapshot TEXT, bound_at TEXT,
        last_login_ip_hash TEXT, last_login_day TEXT, qq TEXT UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);

    const cols = db.prepare(`PRAGMA table_info(app_user)`).all() as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    const wanted = [
      "id", "nickname", "password_hash", "password_salt", "wechat_openid",
      "wechat_unionid", "avatar_url", "sdgb_identity_hash", "sdgb_user_id_cipher",
      "display_name", "rating", "show_rating_public", "title", "icon_url",
      "profile_snapshot", "bound_at", "last_login_ip_hash", "last_login_day",
      "qq", "created_at", "updated_at",
    ];
    const selectList = wanted
      .map((c) => (existing.has(c) ? c : c === "show_rating_public" ? `1 AS ${c}` : `NULL AS ${c}`))
      .join(", ");

    db.exec(
      `INSERT INTO app_user__new (${wanted.join(", ")})
       SELECT ${selectList} FROM app_user`
    );
    db.exec(`DROP TABLE app_user`);
    db.exec(`ALTER TABLE app_user__new RENAME TO app_user`);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function _removeOnSiteCallArtifacts(db: Db) {
  const queueEntrySql = _tableSql(db, "queue_entry");
  const queueSql = _tableSql(db, "queue");
  const needsRebuild =
    /\bCALLED\b|called_at|no_show_count/i.test(queueEntrySql) ||
    /called_timeout_sec/i.test(queueSql);
  const hasSwapTables = Boolean(_tableSql(db, "swap_request") || _tableSql(db, "swap_vote"));
  if (!needsRebuild && !hasSwapTables) return;

  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec("DROP TABLE IF EXISTS swap_vote; DROP TABLE IF EXISTS swap_request;");
    if (needsRebuild) {
      const queueCols = new Set(
        (db.prepare(`PRAGMA table_info(queue)`).all() as Array<{ name: string }>).map((c) => c.name),
      );
      const entryCols = new Set(
        (db.prepare(`PRAGMA table_info(queue_entry)`).all() as Array<{ name: string }>).map((c) => c.name),
      );
      const coinExpr = queueCols.has("coin_cost") ? "COALESCE(NULLIF(coin_cost, 0), 1)" : "1";
      const headEligExpr = entryCols.has("head_eligible_at") ? "head_eligible_at" : "NULL";
      const headMissExpr = entryCols.has("head_miss_count") ? "COALESCE(head_miss_count, 0)" : "0";

      db.exec(`
        CREATE TABLE queue__new (
          id TEXT PRIMARY KEY, venue_id TEXT NOT NULL REFERENCES venue(id),
          name TEXT NOT NULL, slug TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('OPEN','PAUSED','CLOSED')),
          next_sequence INTEGER NOT NULL DEFAULT 1,
          coin_cost INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(venue_id, slug)
        );
        INSERT INTO queue__new (id, venue_id, name, slug, status, next_sequence, coin_cost, created_at, updated_at)
        SELECT id, venue_id, name, slug, status, next_sequence,
               ${coinExpr}, created_at, updated_at FROM queue;

        CREATE TABLE queue_entry__new (
          id TEXT PRIMARY KEY, queue_id TEXT NOT NULL REFERENCES queue(id),
          user_id TEXT NOT NULL REFERENCES app_user(id),
          party_id TEXT REFERENCES queue_party(id),
          play_mode TEXT NOT NULL DEFAULT 'SOLO' CHECK (play_mode IN ('SOLO','DUO')),
          sequence_number INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('WAITING','PLAYING','DONE','CANCELLED','EXPIRED')),
          version INTEGER NOT NULL DEFAULT 1,
          joined_at TEXT NOT NULL, playing_at TEXT, finished_at TEXT, cancelled_at TEXT,
          head_eligible_at TEXT, head_miss_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(queue_id, sequence_number)
        );
        INSERT INTO queue_entry__new
          (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
           joined_at, playing_at, finished_at, cancelled_at, head_eligible_at, head_miss_count,
           created_at, updated_at)
        SELECT id, queue_id, user_id, party_id, play_mode, sequence_number,
               CASE WHEN status IN ('WAITING','PLAYING','DONE','CANCELLED','EXPIRED') THEN status ELSE 'WAITING' END,
               version, joined_at, playing_at, finished_at, cancelled_at,
               ${headEligExpr}, ${headMissExpr}, created_at, updated_at FROM queue_entry;

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
