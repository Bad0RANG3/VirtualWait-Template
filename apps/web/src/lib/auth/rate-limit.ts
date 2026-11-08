/**
 * 固定窗口限流桶 + 过期桶清理，以及注册/登录的限流组合。
 *
 * 关键不变量：**每个桶只在自己的窗口内被读取**，因此清理必须按「该行自己的
 * 窗口长度」判断是否过期。早期实现用「当前调用方的窗口 × 4」作为全局删除阈值，
 * 于是 60 秒窗口的 Bot 轮询会把仍在生效的 1 小时注册桶删掉，注册与登录限流
 * 大面积失效；窗口长度随行存储后不再存在跨调用方误删。
 */
import { getDb, nowIso } from "../db";
import { env } from "../env";

/** Minimum spacing between inline cleanups (one write per minute at most). */
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanupMs = 0;

type BucketRow = {
  key: string;
  window_start: number;
  window_sec: number;
  count: number;
};

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

/**
 * Delete buckets that ended more than `RATE_LIMIT_BUCKET_RETENTION_SEC` ago.
 *
 * Only rows whose own window (`window_start + window_sec`) has already elapsed
 * are eligible, so a short-window caller can never drop a long-window counter.
 */
export function cleanupExpiredRateLimitBuckets(nowMs = Date.now()): number {
  const cutoff = nowMs - env.rateLimitBucketRetentionSec * 1000;
  const result = getDb()
    .prepare(
      `DELETE FROM rate_limit_bucket WHERE window_start + window_sec * 1000 < ?`,
    )
    .run(cutoff) as { changes?: number };
  return result.changes ?? 0;
}

function maybeCleanup(nowMs: number) {
  if (nowMs - lastCleanupMs < CLEANUP_INTERVAL_MS) return;
  lastCleanupMs = nowMs;
  cleanupExpiredRateLimitBuckets(nowMs);
}

/**
 * Fixed-window counter in SQLite.
 * Returns whether the call is allowed, plus retry-after seconds when limited.
 */
export function consumeRateLimit(input: {
  key: string;
  limit: number;
  windowSec: number;
}): RateLimitDecision {
  const db = getDb();
  const now = Date.now();
  const windowMs = Math.max(1, Math.floor(input.windowSec)) * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;

  maybeCleanup(now);

  const row = db
    .prepare(
      `SELECT key, window_start, window_sec, count FROM rate_limit_bucket WHERE key = ?`,
    )
    .get(input.key) as BucketRow | undefined;

  if (!row || row.window_start !== windowStart) {
    db.prepare(
      `INSERT INTO rate_limit_bucket (key, window_start, window_sec, count, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         window_start = excluded.window_start,
         window_sec = excluded.window_sec,
         count = 1,
         updated_at = excluded.updated_at`,
    ).run(input.key, windowStart, Math.floor(input.windowSec), nowIso());
    return { ok: true };
  }

  if (row.count >= input.limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((windowStart + windowMs - now) / 1000),
    );
    return { ok: false, retryAfterSec };
  }

  db.prepare(
    `UPDATE rate_limit_bucket SET count = count + 1, updated_at = ? WHERE key = ?`,
  ).run(nowIso(), input.key);
  return { ok: true };
}

/**
 * Read a counter without recording a hit.
 *
 * Used to reject a caller that already exhausted its budget *before* doing any
 * expensive work (scrypt), without the check itself counting as a new attempt.
 */
export function peekRateLimit(input: {
  key: string;
  limit: number;
  windowSec: number;
}): RateLimitDecision {
  const db = getDb();
  const now = Date.now();
  const windowMs = Math.max(1, Math.floor(input.windowSec)) * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;

  const row = db
    .prepare(`SELECT window_start, count FROM rate_limit_bucket WHERE key = ?`)
    .get(input.key) as { window_start: number; count: number } | undefined;
  if (!row || row.window_start !== windowStart) return { ok: true };
  if (row.count < input.limit) return { ok: true };
  return {
    ok: false,
    retryAfterSec: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
  };
}

/**
 * Registration is the only path that creates identities, so it is limited both
 * per client IP and globally per window. A global cap bounds distributed
 * sign-ups even when every request comes from a different address.
 */
export function consumeRegistrationLimit(ipHash: string): RateLimitDecision {
  const perIp = consumeRateLimit({
    key: `account-register:ip:${ipHash}`,
    limit: env.registerIpLimit,
    windowSec: env.registerIpWindowSec,
  });
  if (!perIp.ok) return perIp;
  return consumeRateLimit({
    key: "account-register:global",
    limit: env.registerGlobalLimit,
    windowSec: env.registerGlobalWindowSec,
  });
}

/**
 * Password login limits.
 *
 * Two independent guards:
 * - **per account name** (`LOGIN_ACCOUNT_LIMIT`): bounds brute force against a
 *   single account, counting every attempt.
 * - **per client IP, failures only** (`LOGIN_IP_LIMIT`): bounds a host spraying
 *   many usernames. Successful logins are *not* counted here, because a venue
 *   Wi-Fi / NAT exit shares one address — throttling successful logins would
 *   lock the whole venue out (the same reasoning behind the registration-only
 *   per-IP quota).
 *
 * `consumeLoginLimit` checks both and consumes the account bucket only;
 * `recordLoginFailure` consumes the IP bucket after a rejected password.
 */
export function consumeLoginLimit(
  ipHash: string,
  username: string,
): RateLimitDecision {
  const ipCheck = peekRateLimit({
    key: `account-login:ip:${ipHash}`,
    limit: env.loginIpLimit,
    windowSec: env.loginIpWindowSec,
  });
  if (!ipCheck.ok) return ipCheck;
  return consumeRateLimit({
    key: `account-login:user:${username.trim().toLowerCase()}`,
    limit: env.loginAccountLimit,
    windowSec: env.loginAccountWindowSec,
  });
}

/** Record one rejected password attempt for the client IP. */
export function recordLoginFailure(ipHash: string): void {
  consumeRateLimit({
    key: `account-login:ip:${ipHash}`,
    limit: env.loginIpLimit,
    windowSec: env.loginIpWindowSec,
  });
}
