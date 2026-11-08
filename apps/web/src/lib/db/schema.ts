/**
 * 全量 DDL（SCHEMA_SQL）与增量迁移（MIGRATIONS_SQL）：场地、机台队列、
 * 本地账号（app_user）、审计、防滥用（ip_day_binding、rate_limit_bucket）、
 * session 等表。
 *
 * 身份模型：每个玩家一个**本地账号**（用户名 + scrypt 口令 + 展示昵称），
 * 注册时用场地动态签到码证明本人在现场（见 lib/settings/checkin.ts）。
 * 系统不再与任何外部身份服务或游戏服务器通信。
 */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS venue (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  address TEXT,
  region_name TEXT,
  region_kind TEXT,
  machine_count INTEGER,
  open_minute INTEGER,
  close_minute INTEGER,
  group_umo TEXT,
  checkin_secret TEXT,
  checkin_rotated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venue(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','PAUSED','CLOSED')),
  next_sequence INTEGER NOT NULL DEFAULT 1,
  coin_cost INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(venue_id, slug)
);

CREATE TABLE IF NOT EXISTS app_user (
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

CREATE TABLE IF NOT EXISTS queue_party (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES queue(id),
  play_mode TEXT NOT NULL CHECK (play_mode IN ('SOLO','DUO')),
  status TEXT NOT NULL CHECK (status IN ('SEEKING','PENDING','CONFIRMED','DISBANDED')),
  host_user_id TEXT NOT NULL REFERENCES app_user(id),
  guest_user_id TEXT REFERENCES app_user(id),
  host_confirmed INTEGER NOT NULL DEFAULT 0,
  guest_confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_entry (
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
  head_eligible_at TEXT,
  head_miss_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(queue_id, sequence_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_entry_per_user
ON queue_entry (user_id)
WHERE status IN ('WAITING','PLAYING');

CREATE TABLE IF NOT EXISTS audit_event (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ip_day_binding (
  ip_hash TEXT NOT NULL,
  day_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES app_user(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ip_hash, day_key, user_id)
);

CREATE TABLE IF NOT EXISTS rate_limit_bucket (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  window_sec INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_user(id),
  ip_hash TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER
);

-- NOTE: indexes that depend on a *migrated* column must live in migrate.ts
-- (see _ensureHotPathIndexes): SCHEMA_SQL runs before MIGRATIONS_SQL, so an
-- index on queue_entry.party_id would fail on a database that predates that
-- column and take the whole process down with it.
`;

/** Lightweight migrations for existing local SQLite files. */
export const MIGRATIONS_SQL = [
  `ALTER TABLE queue_entry ADD COLUMN party_id TEXT`,
  `ALTER TABLE queue_entry ADD COLUMN play_mode TEXT NOT NULL DEFAULT 'SOLO'`,
  `ALTER TABLE app_user ADD COLUMN last_login_ip_hash TEXT`,
  `ALTER TABLE app_user ADD COLUMN last_login_day TEXT`,
  `ALTER TABLE queue_entry ADD COLUMN head_eligible_at TEXT`,
  `ALTER TABLE queue_entry ADD COLUMN head_miss_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE venue ADD COLUMN address TEXT`,
  `ALTER TABLE venue ADD COLUMN region_name TEXT`,
  `ALTER TABLE venue ADD COLUMN region_kind TEXT`,
  `ALTER TABLE venue ADD COLUMN machine_count INTEGER`,
  `ALTER TABLE queue ADD COLUMN coin_cost INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE venue ADD COLUMN open_minute INTEGER`,
  `ALTER TABLE venue ADD COLUMN close_minute INTEGER`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `ALTER TABLE app_user ADD COLUMN qq TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS app_user_qq_unique ON app_user(qq) WHERE qq IS NOT NULL`,
  `ALTER TABLE venue ADD COLUMN group_umo TEXT`,
  `ALTER TABLE venue ADD COLUMN checkin_secret TEXT`,
  `ALTER TABLE venue ADD COLUMN checkin_rotated_at TEXT`,
  `ALTER TABLE rate_limit_bucket ADD COLUMN window_sec INTEGER NOT NULL DEFAULT 0`,
];
