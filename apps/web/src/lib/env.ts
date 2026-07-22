function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEV_SESSION_SECRET = "dev-session-secret-change-me";
const DEV_PUBLIC_ID_SECRET = "dev-public-id-secret-change-me";
const DEV_GATEWAY_SECRET = "dev-gateway-secret";

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

function requireProductionGatewayUrl(value: string) {
  if (process.env.NODE_ENV !== "production") return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "GATEWAY_BASE_URL must be a valid HTTPS URL or loopback HTTP URL in production",
    );
  }
  if (url.protocol === "https:" && !url.username && !url.password) return;

  // The supported self-hosted topology keeps the Gateway on the same host,
  // bound to loopback only. HTTP is safe on that private hop; it must never
  // become a general remote-Gateway exception.
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && isLoopback && !url.username && !url.password)
    return;

  throw new Error(
    "GATEWAY_BASE_URL must use HTTPS unless it is an unauthenticated http://127.0.0.1 or http://[::1] URL in production",
  );
}

const rawGatewayMode = process.env.GATEWAY_MODE || "remote";
if (rawGatewayMode === "mock") {
  throw new Error(
    "GATEWAY_MODE=mock is no longer supported. Run services/sdgb-gateway with VW_GATEWAY_PROVIDER=mock and set GATEWAY_MODE=remote so Web uses the signed login interface.",
  );
}
if (rawGatewayMode !== "remote") {
  throw new Error('GATEWAY_MODE must be "remote"');
}
const gatewayMode = "remote" as const;
const sessionSecret = str("SESSION_SECRET", DEV_SESSION_SECRET);
const publicIdHmacSecret = str("PUBLIC_ID_HMAC_SECRET", DEV_PUBLIC_ID_SECRET);
const gatewaySharedSecret = str("GATEWAY_SHARED_SECRET", DEV_GATEWAY_SECRET);
const adminApiToken = str("ADMIN_API_TOKEN");
const botApiToken = str("BOT_API_TOKEN");
const appBaseUrl = str("APP_BASE_URL").replace(/\/$/, "");
const gatewayBaseUrl = str("GATEWAY_BASE_URL", "http://127.0.0.1:8787");
const trustProxyHeaders = bool(
  "TRUST_PROXY_HEADERS",
  process.env.NODE_ENV !== "production",
);
const sessionMaxAgeDays = num("SESSION_MAX_AGE_DAYS", 30);

requireProductionSecret("SESSION_SECRET", sessionSecret, DEV_SESSION_SECRET);
requireProductionSecret(
  "PUBLIC_ID_HMAC_SECRET",
  publicIdHmacSecret,
  DEV_PUBLIC_ID_SECRET,
);
if (process.env.NODE_ENV === "production" && gatewayMode !== "remote") {
  throw new Error("GATEWAY_MODE must be remote in production");
}
requireProductionSecret(
  "GATEWAY_SHARED_SECRET",
  gatewaySharedSecret,
  DEV_GATEWAY_SECRET,
);
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
  requireProductionGatewayUrl(gatewayBaseUrl);
}

export const env = {
  sessionSecret,
  /** Persistent user session lifetime in days. */
  sessionMaxAgeDays,
  publicIdHmacSecret,
  gatewayMode,
  gatewayBaseUrl,
  gatewayKeyId: process.env.GATEWAY_KEY_ID || "template-web-1",
  gatewaySharedSecret,
  adminApiToken,
  /** Separate bearer for AstrBot / machine-to-machine queue APIs. Empty disables /api/bot/*. */
  botApiToken,
  /** Catalog pulls per minute for BOT_API_TOKEN. */
  botCatalogRateLimit: num("BOT_CATALOG_RATE_LIMIT", 20),
  /** Queue detail pulls per minute for BOT_API_TOKEN. */
  botQueueRateLimit: num("BOT_QUEUE_RATE_LIMIT", 120),
  trustProxyHeaders,
  playingTimeoutSec: num("PLAYING_TIMEOUT_SEC", 1500),
  /** Seconds the head group has to confirm onto a free machine. */
  headConfirmTimeoutSec: num("HEAD_CONFIRM_TIMEOUT_SEC", 180),
  /** Max concurrent maimai QR verifications (anti-abuse). */
  qrMaxConcurrent: num("QR_MAX_CONCURRENT", 3),
  /** Max QR login attempts per IP per window. */
  qrLoginIpLimit: num("QR_LOGIN_IP_LIMIT", 8),
  qrLoginIpWindowSec: num("QR_LOGIN_IP_WINDOW_SEC", 300),
  /** Global QR login attempts per window. */
  qrLoginGlobalLimit: num("QR_LOGIN_GLOBAL_LIMIT", 40),
  qrLoginGlobalWindowSec: num("QR_LOGIN_GLOBAL_WINDOW_SEC", 60),
  /** Per-IP polling limit for an in-flight remote verification job. */
  authAttemptPollLimit: num("AUTH_ATTEMPT_POLL_LIMIT", 30),
  authAttemptPollWindowSec: num("AUTH_ATTEMPT_POLL_WINDOW_SEC", 60),
  /** Frequency for the standalone queue/temporary-data maintenance process. */
  maintenanceIntervalSec: num("MAINTENANCE_INTERVAL_SEC", 15),
  /** Retain expired verification attempt metadata for this long before removal. */
  transientDataRetentionSec: num("TRANSIENT_DATA_RETENTION_SEC", 86_400),
  /** Retain inactive fixed-window rate-limit counters before maintenance removes them. */
  rateLimitBucketRetentionSec: num("RATE_LIMIT_BUCKET_RETENTION_SEC", 3_600),
  /** Remove expired per-day IP/account bindings after this many Shanghai calendar days. */
  ipBindingRetentionDays: num("IP_BINDING_RETENTION_DAYS", 2),
  /** Scrub stale SDGB profile/IP metadata for inactive accounts after this many days. */
  profileDataRetentionDays: num("PROFILE_DATA_RETENTION_DAYS", 180),
  /** Remove terminal queue/party history after this many days. */
  queueHistoryRetentionDays: num("QUEUE_HISTORY_RETENTION_DAYS", 180),
  /** Remove audit events after this many days. */
  auditEventRetentionDays: num("AUDIT_EVENT_RETENTION_DAYS", 365),
  /** Remote gateway fetch timeout. */
  gatewayTimeoutMs: num("GATEWAY_TIMEOUT_MS", 15_000),
  /** 站点对外 origin，例如 https://wait.example.com 或 http://wait.example.com */
  appBaseUrl,
  /** Whether auth cookies should require HTTPS transport. */
  secureCookies: parseAppBaseUrl(appBaseUrl)?.protocol === "https:",
};
