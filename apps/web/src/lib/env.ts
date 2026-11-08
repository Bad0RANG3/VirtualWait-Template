/**
 * 环境变量集中解析与校验：类型化 `env` 对象、生产环境不安全密钥检查
 * （占位符/弱密钥/明文 https 决策）。
 *
 * 系统只与自己的 SQLite 通信：没有 Gateway、没有上游身份 provider，
 * 因此这里不再有任何外部服务地址与配对密钥。
 */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEV_SESSION_SECRET = "dev-session-secret-change-me";

function str(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}

function bool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "true";
}

const UNSAFE_SECRET_MARKERS = [
  /dev-/i,
  /change[_-]?me/i,
  /replace/i,
  /placeholder/i,
  /example/i,
];

export function isUnsafeProductionSecret(value: string, devValue: string) {
  return (
    !value ||
    value === devValue ||
    value.length < 32 ||
    UNSAFE_SECRET_MARKERS.some((pattern) => pattern.test(value))
  );
}

function requireProductionSecret(
  name: string,
  value: string,
  devValue: string,
) {
  if (process.env.NODE_ENV !== "production") return;
  if (isUnsafeProductionSecret(value, devValue)) {
    throw new Error(
      `${name} must be set to a unique non-placeholder value with at least 32 characters in production`,
    );
  }
}

function parseAppBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function isValidAppBaseUrl(value: string) {
  return parseAppBaseUrl(value) !== null;
}

function requireProductionAppUrl(name: string, value: string) {
  if (process.env.NODE_ENV !== "production") return;
  if (!isValidAppBaseUrl(value)) {
    throw new Error(`${name} must be a valid HTTP or HTTPS URL in production`);
  }
}

const sessionSecret = str("SESSION_SECRET", DEV_SESSION_SECRET);
const adminApiToken = str("ADMIN_API_TOKEN");
const botApiToken = str("BOT_API_TOKEN");
const appBaseUrl = str("APP_BASE_URL").replace(/\/$/, "");
const trustProxyHeaders = bool(
  "TRUST_PROXY_HEADERS",
  process.env.NODE_ENV !== "production",
);
const sessionMaxAgeDays = num("SESSION_MAX_AGE_DAYS", 30);
const checkinWindowSec = num("CHECKIN_WINDOW_SEC", 600);
// Additional *previous* windows a submitted code stays valid for (0 disables).
const parsedCheckinGrace = Number(process.env.CHECKIN_GRACE_WINDOWS);
const checkinGraceWindows = Number.isFinite(parsedCheckinGrace)
  ? Math.max(0, Math.floor(parsedCheckinGrace))
  : 1;

requireProductionSecret("SESSION_SECRET", sessionSecret, DEV_SESSION_SECRET);
if (
  process.env.NODE_ENV === "production" &&
  isUnsafeProductionSecret(adminApiToken, "")
) {
  throw new Error(
    "ADMIN_API_TOKEN must be set to a unique non-placeholder value with at least 32 characters in production",
  );
}
requireProductionAppUrl("APP_BASE_URL", appBaseUrl);
if (process.env.NODE_ENV === "production") {
  if (!trustProxyHeaders) {
    throw new Error(
      "TRUST_PROXY_HEADERS=true is required in production behind a proxy that overwrites client IP headers",
    );
  }
}

export const env = {
  sessionSecret,
  /** Persistent user session lifetime in days. */
  sessionMaxAgeDays,
  adminApiToken,
  /** Separate bearer for QQ bot (services/bot) machine-to-machine queue APIs. Empty disables /api/bot/*. */
  botApiToken,
  /** Catalog pulls per minute for BOT_API_TOKEN. */
  botCatalogRateLimit: num("BOT_CATALOG_RATE_LIMIT", 20),
  /** Queue detail pulls per minute for BOT_API_TOKEN (budget for polling several hot machines). */
  botQueueRateLimit: num("BOT_QUEUE_RATE_LIMIT", 240),
  trustProxyHeaders,
  playingTimeoutSec: num("PLAYING_TIMEOUT_SEC", 1500),
  /** Seconds the head group has to confirm onto a free machine. */
  headConfirmTimeoutSec: num("HEAD_CONFIRM_TIMEOUT_SEC", 180),
  /** Set false to make the queue usable without a bound QQ (bot @ is then skipped). */
  requireQqForQueue: bool("REQUIRE_QQ_FOR_QUEUE", true),
  /** Set false to close self-service registration; operators then use `npm run account:create`. */
  registrationEnabled: bool("REGISTRATION_ENABLED", true),
  /** Require a live venue check-in code when registering a new account. */
  checkinRequired: bool("CHECKIN_REQUIRED", true),
  /** Rotation period of a venue check-in code, in seconds. */
  checkinWindowSec,
  /** How many previous windows a submitted check-in code stays valid. */
  checkinGraceWindows,
  /** Registrations allowed per IP per window. */
  registerIpLimit: num("REGISTER_IP_LIMIT", 5),
  registerIpWindowSec: num("REGISTER_IP_WINDOW_SEC", 3600),
  /** Global registration cap per window (defends against distributed sign-ups). */
  registerGlobalLimit: num("REGISTER_GLOBAL_LIMIT", 40),
  registerGlobalWindowSec: num("REGISTER_GLOBAL_WINDOW_SEC", 3600),
  /** Password login attempts per IP per window. */
  loginIpLimit: num("LOGIN_IP_LIMIT", 10),
  loginIpWindowSec: num("LOGIN_IP_WINDOW_SEC", 300),
  /** Password login attempts per account per window. */
  loginAccountLimit: num("LOGIN_ACCOUNT_LIMIT", 8),
  loginAccountWindowSec: num("LOGIN_ACCOUNT_WINDOW_SEC", 300),
  /** Frequency for the standalone queue/temporary-data maintenance process. */
  maintenanceIntervalSec: num("MAINTENANCE_INTERVAL_SEC", 15),
  /** SQLite busy handler: how long a writer waits for a lock (web + maintenance share the file). */
  dbBusyTimeoutMs: num("DB_BUSY_TIMEOUT_MS", 5_000),
  /** Retain inactive rate-limit counters before maintenance removes them. */
  rateLimitBucketRetentionSec: num("RATE_LIMIT_BUCKET_RETENTION_SEC", 3_600),
  /** Max different accounts one client IP may register per Shanghai day. */
  ipAccountQuotaPerDay: num("IP_ACCOUNT_QUOTA_PER_DAY", 5),
  /** Remove expired per-day IP/account bindings after this many Shanghai calendar days. */
  ipBindingRetentionDays: num("IP_BINDING_RETENTION_DAYS", 2),
  /** Scrub stale last-login IP/day metadata for inactive accounts after this many days. */
  loginMetadataRetentionDays: num("LOGIN_METADATA_RETENTION_DAYS", 180),
  /** Remove terminal queue/party history after this many days. */
  queueHistoryRetentionDays: num("QUEUE_HISTORY_RETENTION_DAYS", 180),
  /** Remove audit events after this many days. */
  auditEventRetentionDays: num("AUDIT_EVENT_RETENTION_DAYS", 365),
  /** 站点对外 origin，例如 https://wait.example.com 或 http://wait.example.com */
  appBaseUrl,
  /** Whether auth cookies should require HTTPS transport. */
  secureCookies: parseAppBaseUrl(appBaseUrl)?.protocol === "https:",
};
