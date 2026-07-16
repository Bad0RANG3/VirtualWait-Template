import { getDb, nowIso } from "../db";
import { shanghaiDayKey } from "./time";

/**
 * One client IP may bind to only one maimai account per Shanghai calendar day.
 * Prevents multi-account abuse from the same network endpoint.
 */
export function assertIpCanBindUser(ipHash: string, userId: string): void {
  if (!ipHash || ipHash === "unknown") {
    // still allow login but skip exclusive binding enforcement for unknown IPs
    return;
  }
  const db = getDb();
  const day = shanghaiDayKey();
  const existing = db
    .prepare(
      `SELECT user_id FROM ip_day_binding WHERE ip_hash = ? AND day_key = ?`
    )
    .get(ipHash, day) as { user_id: string } | undefined;

  if (existing && existing.user_id !== userId) {
    throw new Error("IP_ACCOUNT_BOUND");
  }
}

export function bindIpToUser(ipHash: string, userId: string): void {
  if (!ipHash || ipHash === "unknown") return;
  const db = getDb();
  const day = shanghaiDayKey();
  const now = nowIso();

  assertIpCanBindUser(ipHash, userId);

  db.prepare(
    `INSERT INTO ip_day_binding (ip_hash, day_key, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ip_hash, day_key) DO UPDATE SET
       user_id = excluded.user_id,
       updated_at = excluded.updated_at`
  ).run(ipHash, day, userId, now, now);

  db.prepare(
    `UPDATE app_user SET last_login_ip_hash = ?, last_login_day = ?, updated_at = ? WHERE id = ?`
  ).run(ipHash, day, now, userId);
}
