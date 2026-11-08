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

  _migrateLocalAccountSchema(db);
  _removeOnSiteCallArtifacts(db);
  _ensureSecurityTables(db);
  _ensureIpDayBindingQuota(db);
  // Must run last: it indexes `queue_entry.party_id`, a column that only exists
  // after MIGRATIONS_SQL (and after the legacy table rebuild) has run.
  _ensureHotPathIndexes(db);
}

/**
 * Indexes for the queue/audit/session hot paths.
 *
 * Runs after the migrations and legacy rebuilds so every indexed column exists,
 * and re-creates the indexes that a legacy `queue_entry` rebuild dropped.
 */
function _ensureHotPathIndexes(db: Db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS queue_entry_party_idx ON queue_entry (party_id);
    CREATE INDEX IF NOT EXISTS audit_event_created_idx ON audit_event (created_at);
    CREATE INDEX IF NOT EXISTS session_issued_idx ON session (issued_at_ms);
  `);
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
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_user(id),
      ip_hash TEXT NOT NULL, issued_at_ms INTEGER NOT NULL, revoked_at_ms INTEGER
    );
    -- Every session query hits the primary key; the old (user_id) index was
    -- never used. Drop it so existing databases converge with new installs.
    DROP INDEX IF EXISTS idx_session_user;
    -- Identity tables from the former QR/Gateway login flow are gone.
    DROP TABLE IF EXISTS completion_token;
    DROP TABLE IF EXISTS qr_concurrency_slot;
    DROP TABLE IF EXISTS join_attempt;
  `);
}

/**
 * Rebuild databases whose `app_user` table still carries the removed
 * external-scan identity columns (openid, profile rating/title, ...).
 *
 * Legacy accounts have no local password, so they cannot be carried over:
 * players re-register with a username, password and a venue check-in code.
 * Queue history and sessions that referenced those accounts are removed in the
 * same transaction so foreign keys stay consistent.  Release notes for
 * operators are in docs/DEPLOYMENT.md.
 */
function _migrateLocalAccountSchema(db: Db) {
  const sql = _tableSql(db, "app_user");
  if (!sql) return;
  const hasLocalCredentialColumns =
    /\busername\b/i.test(sql) &&
    /\bpassword_algo\b/i.test(sql) &&
    !/\bwechat_openid\b/i.test(sql);
  if (hasLocalCredentialColumns) return;

  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      DELETE FROM session;
      DELETE FROM queue_entry;
      DELETE FROM queue_party;
      DELETE FROM ip_day_binding;
      DROP TABLE IF EXISTS completion_token;
      DROP TABLE IF EXISTS qr_concurrency_slot;
      DROP TABLE IF EXISTS join_attempt;

      CREATE TABLE app_user__new (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        nickname TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_algo TEXT NOT NULL,
        qq TEXT UNIQUE,
        checkin_venue_id TEXT REFERENCES venue(id),
        registered_at TEXT NOT NULL,
        last_login_ip_hash TEXT,
        last_login_day TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      DROP TABLE app_user;
      ALTER TABLE app_user__new RENAME TO app_user;
    `);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    db.pragma("foreign_keys = ON");
  }
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
  const isLegacy =
    /PRIMARY\s+KEY\s*\(\s*ip_hash\s*,\s*day_key\s*\)/i.test(sql) &&
    !/PRIMARY\s+KEY\s*\(\s*ip_hash\s*,\s*day_key\s*,\s*user_id\s*\)/i.test(sql);
  if (!isLegacy) return;

  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      DELETE FROM ip_day_binding;
      CREATE TABLE ip_day_binding__new (
        ip_hash TEXT NOT NULL, day_key TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES app_user(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (ip_hash, day_key, user_id)
      );
      DROP TABLE ip_day_binding;
      ALTER TABLE ip_day_binding__new RENAME TO ip_day_binding;
    `);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
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
  const hasSwapTables = Boolean(
    _tableSql(db, "swap_request") || _tableSql(db, "swap_vote"),
  );
  if (!needsRebuild && !hasSwapTables) return;

  db.pragma("foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec("DROP TABLE IF EXISTS swap_vote; DROP TABLE IF EXISTS swap_request;");
    if (needsRebuild) {
      const queueCols = new Set(
        (
          db.prepare(`PRAGMA table_info(queue)`).all() as Array<{ name: string }>
        ).map((c) => c.name),
      );
      const entryCols = new Set(
        (
          db.prepare(`PRAGMA table_info(queue_entry)`).all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );
      const coinExpr = queueCols.has("coin_cost")
        ? "COALESCE(NULLIF(coin_cost, 0), 1)"
        : "1";
      const headEligExpr = entryCols.has("head_eligible_at")
        ? "head_eligible_at"
        : "NULL";
      const headMissExpr = entryCols.has("head_miss_count")
        ? "COALESCE(head_miss_count, 0)"
        : "0";

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
