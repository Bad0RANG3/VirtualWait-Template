/**
 * 场地签到码：注册新账号时必须提供某个场地当前有效的动态码，用来替代过去
 * 「扫机台二维码」所承担的两件事——证明本人在现场、且身份来自真实场地。
 *
 * 码由场地私有的 `checkin_secret`（随机 32 字节，存于 SQLite，绝不外发脚本）
 * 与时间窗口号做 HMAC-SHA256 派生，取 6 位十进制。默认 10 分钟轮换，注册时
 * 额外接受上一个窗口，避免跨窗口边界把用户挡在门外。
 */
import { createHmac } from "crypto";
import { getDb, nowIso } from "../db";
import { env } from "../env";
import { randomToken, safeEqual } from "../crypto";
import type { VenueCheckinCode } from "./checkin-shared";

// 客户端安全的部分（类型 + 倒计时）在 checkin-shared.ts，这里只做服务端工作。
// 客户端组件必须从 checkin-shared 导入，否则会把 node:crypto / node:fs 拉进浏览器包。
export type { VenueCheckinCode } from "./checkin-shared";

type VenueCheckinRow = {
  id: string;
  name: string;
  slug: string;
  checkin_secret: string | null;
  checkin_rotated_at: string | null;
};

function readVenue(venueId: string): VenueCheckinRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, name, slug, checkin_secret, checkin_rotated_at
         FROM venue WHERE id = ?`,
      )
      .get(venueId) as VenueCheckinRow | undefined) || null
  );
}

export function venueIdBySlug(venueSlug: string): string | null {
  const row = getDb()
    .prepare(`SELECT id FROM venue WHERE slug = ?`)
    .get(venueSlug) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Display name of a venue by primary key (used on the profile page). */
export function venueNameById(venueId: string): string | null {
  const row = getDb()
    .prepare(`SELECT name FROM venue WHERE id = ?`)
    .get(venueId) as { name: string } | undefined;
  return row?.name ?? null;
}

function windowIndex(nowMs: number): number {
  return Math.floor(nowMs / (env.checkinWindowSec * 1000));
}

/** Derive the 6-digit code for one time window. */
export function checkinCodeForWindow(secret: string, index: number): string {
  const digest = createHmac("sha256", secret)
    .update(`vw-checkin:${index}`)
    .digest();
  const value =
    (((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0) %
    1_000_000;
  return String(value).padStart(6, "0");
}

/** Read (creating on first use) the per-venue rotating secret. */
export function ensureVenueCheckinSecret(venueId: string): string | null {
  const venue = readVenue(venueId);
  if (!venue) return null;
  if (venue.checkin_secret) return venue.checkin_secret;
  const secret = randomToken(32);
  getDb()
    .prepare(
      `UPDATE venue
       SET checkin_secret = ?, checkin_rotated_at = COALESCE(checkin_rotated_at, ?), updated_at = ?
       WHERE id = ? AND checkin_secret IS NULL`,
    )
    .run(secret, nowIso(), nowIso(), venueId);
  return readVenue(venueId)?.checkin_secret ?? secret;
}

/** Current code plus its validity window, for the admin dashboard. */
export function getVenueCheckinCode(
  venueId: string,
  nowMs = Date.now(),
): VenueCheckinCode | null {
  const venue = readVenue(venueId);
  if (!venue) return null;
  const secret = ensureVenueCheckinSecret(venueId);
  if (!secret) return null;
  const windowMs = env.checkinWindowSec * 1000;
  const index = windowIndex(nowMs);
  const startedMs = index * windowMs;
  return {
    venueId: venue.id,
    venueSlug: venue.slug,
    venueName: venue.name,
    code: checkinCodeForWindow(secret, index),
    windowSec: env.checkinWindowSec,
    windowStartedAt: new Date(startedMs).toISOString(),
    expiresAt: new Date(startedMs + windowMs).toISOString(),
    rotatedAt: venue.checkin_rotated_at,
  };
}

/**
 * Validate a user-supplied code against the current window (and the configured
 * number of previous windows).  Always recomputes; never stores the input.
 */
export function verifyVenueCheckinCode(
  venueId: string,
  input: string,
  nowMs = Date.now(),
): boolean {
  const candidate = (input || "").trim();
  if (!/^\d{6}$/.test(candidate)) return false;
  const secret = ensureVenueCheckinSecret(venueId);
  if (!secret) return false;
  const index = windowIndex(nowMs);
  const grace = Math.max(0, env.checkinGraceWindows);
  for (let offset = 0; offset <= grace; offset += 1) {
    const expected = checkinCodeForWindow(secret, index - offset);
    if (safeEqual(candidate, expected)) return true;
  }
  return false;
}

/** Issue a new secret, immediately invalidating the previous code. */
export function rotateVenueCheckinSecret(
  venueId: string,
  nowMs = Date.now(),
): VenueCheckinCode | null {
  const venue = readVenue(venueId);
  if (!venue) return null;
  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE venue SET checkin_secret = ?, checkin_rotated_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(randomToken(32), now, now, venueId);
  return getVenueCheckinCode(venueId, nowMs);
}
