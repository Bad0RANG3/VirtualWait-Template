import { ServiceError } from "../api";
import { getDb, nowIso } from "../db";
import { env } from "../env";
import { shanghaiDayKey } from "./time";

/**
 * One client IP may bind at most `IP_ACCOUNT_QUOTA_PER_DAY` different maimai
 * accounts per Shanghai calendar day. Re-binding an already-bound account is
 * always allowed. The quota (instead of a hard single-account limit) keeps
 * shared venue Wi-Fi / NAT usable while still capping multi-account abuse.
 */
export function assertIpCanBindUser(ipHash: string, userId: string): void {
  if (!ipHash || ipHash === "unknown") {
    // still allow login but skip exclusive binding enforcement for unknown IPs
    return;
  }
  const db = getDb();
  const day = shanghaiDayKey();
  const existing = db
    .prepare(`SELECT user_id FROM ip_day_binding WHERE ip_hash = ? AND day_key = ?`)
    .all(ipHash, day) as Array<{ user_id: string }>;

  if (existing.some((row) => row.user_id === userId)) return;
  if (existing.length >= env.ipAccountQuotaPerDay) {
    throw new ServiceError("IP_ACCOUNT_BOUND");
  }
}

export function bindIpToUser(ipHash: string, userId: string): void {
  if (!ipHash || ipHash === "unknown") return;
  const db = getDb();
  const day = shanghaiDayKey();
  const now = nowIso();

  // Fast-fail path for the common case.
  assertIpCanBindUser(ipHash, userId);

  // Atomic quota guard: INSERT ... SELECT is a single statement, so the quota
  // COUNT and the row write cannot interleave even if the fast-fail check
  // above is raced by concurrent requests (multi-process / multi-instance).
  const inserted = db
    .prepare(
      `INSERT INTO ip_day_binding (ip_hash, day_key, user_id, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM ip_day_binding
         WHERE ip_hash = ? AND day_key = ? AND user_id = ?
       )
         AND (
           SELECT COUNT(*) FROM ip_day_binding
           WHERE ip_hash = ? AND day_key = ?
         ) < ?`,
    )
    .run(
      ipHash, day, userId, now, now,
      ipHash, day, userId,
      ipHash, day, env.ipAccountQuotaPerDay,
    );
  if ((inserted.changes ?? 0) === 0) {
    // Either already bound (re-binding is always allowed) or the quota
    // filled up between the fast-fail check and this write.
    const bound = db
      .prepare(
        `SELECT 1 FROM ip_day_binding WHERE ip_hash = ? AND day_key = ? AND user_id = ?`,
      )
      .get(ipHash, day, userId);
    if (!bound) throw new ServiceError("IP_ACCOUNT_BOUND");
  }

  db.prepare(
    `UPDATE app_user SET last_login_ip_hash = ?, last_login_day = ?, updated_at = ? WHERE id = ?`
  ).run(ipHash, day, now, userId);
}
