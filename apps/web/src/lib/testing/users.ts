/**
 * Test-only fixtures for the `app_user` table.
 *
 * Application code must create accounts through `lib/auth/account.ts`; this
 * module exists so queue/abuse tests can seed identities without repeating the
 * credential columns. It is never imported by runtime code paths.
 */
import type { Db } from "../db/sqlite";

export type TestUser = {
  id: string;
  username?: string;
  nickname?: string;
  qq?: string | null;
  checkinVenueId?: string | null;
  registeredAt?: string;
  updatedAt?: string;
  lastLoginIpHash?: string | null;
  lastLoginDay?: string | null;
};

/** Insert fixture accounts; `now` is the default for every timestamp. */
export function insertTestUsers(
  db: Db,
  users: readonly TestUser[],
  now = new Date().toISOString(),
) {
  const stmt = db.prepare(
    `INSERT INTO app_user
     (id, username, nickname, password_hash, password_salt, password_algo, qq,
      checkin_venue_id, registered_at, last_login_ip_hash, last_login_day,
      created_at, updated_at)
     VALUES (?, ?, ?, 'fixture-hash', 'fixture-salt', 'scrypt-v1', ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const user of users) {
    const registered = user.registeredAt ?? now;
    stmt.run(
      user.id,
      user.username ?? user.id,
      user.nickname ?? user.id,
      user.qq ?? null,
      user.checkinVenueId ?? null,
      registered,
      user.lastLoginIpHash ?? null,
      user.lastLoginDay ?? null,
      registered,
      user.updatedAt ?? now,
    );
  }
}
