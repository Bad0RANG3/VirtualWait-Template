import { getDb, nowIso } from "../db";
import { env } from "../env";

type BucketRow = {
  key: string;
  window_start: number;
  count: number;
};

export function cleanupOldRateLimitBuckets(olderThanMs: number): number {
  const result = getDb()
    .prepare(`DELETE FROM rate_limit_bucket WHERE window_start < ?`)
    .run(olderThanMs) as { changes?: number };
  return result.changes ?? 0;
}

/**
 * Fixed-window counter in SQLite.
 * Returns null if allowed, or retry-after seconds if limited.
 */
export function consumeRateLimit(input: {
  key: string;
  limit: number;
  windowSec: number;
}): { ok: true } | { ok: false; retryAfterSec: number } {
  const db = getDb();
  const now = Date.now();
  const windowMs = input.windowSec * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;

  cleanupOldRateLimitBuckets(now - windowMs * 4);

  const row = db
    .prepare(
      `SELECT key, window_start, count FROM rate_limit_bucket WHERE key = ?`
    )
    .get(input.key) as BucketRow | undefined;

  if (!row || row.window_start !== windowStart) {
    db.prepare(
      `INSERT INTO rate_limit_bucket (key, window_start, count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         window_start = excluded.window_start,
         count = 1,
         updated_at = excluded.updated_at`
    ).run(input.key, windowStart, nowIso());
    return { ok: true };
  }

  if (row.count >= input.limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((windowStart + windowMs - now) / 1000)
    );
    return { ok: false, retryAfterSec };
  }

  db.prepare(
    `UPDATE rate_limit_bucket SET count = count + 1, updated_at = ? WHERE key = ?`
  ).run(nowIso(), input.key);
  return { ok: true };
}

export type QrVerificationReservation =
  | { ok: true; slotId: string }
  | { ok: false; code: "RATE_LIMITED"; retryAfterSec: number }
  | { ok: false; code: "QR_BUSY" };

/** Apply the same abuse controls to every endpoint that contacts the gateway. */
export function reserveQrVerification(ipHash: string): QrVerificationReservation {
  const ipLimit = consumeRateLimit({
    key: `qr-login:ip:${ipHash}`,
    limit: env.qrLoginIpLimit,
    windowSec: env.qrLoginIpWindowSec,
  });
  if (!ipLimit.ok) {
    return { ok: false, code: "RATE_LIMITED", retryAfterSec: ipLimit.retryAfterSec };
  }

  const globalLimit = consumeRateLimit({
    key: "qr-login:global",
    limit: env.qrLoginGlobalLimit,
    windowSec: env.qrLoginGlobalWindowSec,
  });
  if (!globalLimit.ok) {
    return {
      ok: false,
      code: "RATE_LIMITED",
      retryAfterSec: globalLimit.retryAfterSec,
    };
  }

  const slot = acquireQrSlot();
  return slot
    ? { ok: true, slotId: slot.id }
    : { ok: false, code: "QR_BUSY" };
}

/** Global concurrent QR verification slots. */
export function acquireQrSlot(): { id: string } | null {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `DELETE FROM qr_concurrency_slot WHERE created_at_ms < ?`
  ).run(now - 120_000);

  const count = db
    .prepare(`SELECT COUNT(*) as c FROM qr_concurrency_slot`)
    .get() as { c: number };
  if (count.c >= env.qrMaxConcurrent) return null;

  const id = `${now}:${Math.random().toString(36).slice(2, 12)}`;
  try {
    db.prepare(
      `INSERT INTO qr_concurrency_slot (id, created_at_ms) VALUES (?, ?)`
    ).run(id, now);
    return { id };
  } catch {
    return null;
  }
}

export function releaseQrSlot(slotId: string) {
  getDb().prepare(`DELETE FROM qr_concurrency_slot WHERE id = ?`).run(slotId);
}
