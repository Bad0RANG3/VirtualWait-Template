export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS venue (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue (
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

CREATE TABLE IF NOT EXISTS app_user (
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(queue_id, sequence_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_entry_per_user
ON queue_entry (user_id)
WHERE status IN ('WAITING','PLAYING');

CREATE TABLE IF NOT EXISTS join_attempt (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES app_user(id),
  queue_id TEXT REFERENCES queue(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('REGISTER_BIND','LOGIN_BIND','JOIN_QUEUE')),
  gateway_job_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_ip_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('CREATED','PROCESSING','SUCCEEDED','FAILED','EXPIRED')),
  error_code TEXT,
  result_json TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS gateway_job_mock (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  public_result TEXT,
  error_code TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
`;

/** Lightweight migrations for existing local SQLite files. */
export const MIGRATIONS_SQL = [
  `ALTER TABLE app_user ADD COLUMN wechat_openid TEXT`,
  `ALTER TABLE app_user ADD COLUMN wechat_unionid TEXT`,
  `ALTER TABLE app_user ADD COLUMN avatar_url TEXT`,
  `ALTER TABLE queue_entry ADD COLUMN party_id TEXT`,
  `ALTER TABLE queue_entry ADD COLUMN play_mode TEXT NOT NULL DEFAULT 'SOLO'`,
  `ALTER TABLE app_user ADD COLUMN last_login_ip_hash TEXT`,
  `ALTER TABLE app_user ADD COLUMN last_login_day TEXT`,
  `ALTER TABLE app_user ADD COLUMN show_rating_public INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE join_attempt ADD COLUMN request_ip_hash TEXT`,
];
