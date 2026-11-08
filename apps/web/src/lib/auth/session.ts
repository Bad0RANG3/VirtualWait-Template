/**
 * 用户会话：HMAC 签名 Cookie（vw_session，含 uid/sid/ip/exp）+ session 表行
 * （支持服务端吊销）；提供 setSession/clearSession/getSessionUser 与用户读取。
 *
 * 账号本身（注册、口令校验）见 lib/auth/account.ts。
 */
import { cookies } from "next/headers";
import { getDb } from "../db";
import { env } from "../env";
import { randomToken, safeEqual, signPayload } from "../crypto";
import type { SessionUser } from "../types";
const COOKIE = "vw_session";
const SESSION_MAX_AGE_SECONDS_PER_DAY = 24 * 60 * 60;

type SessionPayload = {
  uid: string;
  /** Server-side session row id — supports logout revocation. */
  sid: string;
  /** Bound client IP hash at login time. */
  ip: string;
  exp: number;
};

function encodeSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = signPayload(body);
  return `${body}.${sig}`;
}

function decodeSession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = signPayload(body);
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as SessionPayload;
    if (
      typeof payload.uid !== "string" ||
      payload.uid.length < 1 ||
      payload.uid.length > 128 ||
      typeof payload.sid !== "string" ||
      payload.sid.length < 1 ||
      payload.sid.length > 128 ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      typeof payload.ip !== "string" ||
      !(/^[a-f0-9]{64}$/.test(payload.ip) || payload.ip === "unknown")
    ) {
      return null;
    }
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function setSession(userId: string, ipHash: string) {
  const jar = await cookies();
  const maxAge = env.sessionMaxAgeDays * SESSION_MAX_AGE_SECONDS_PER_DAY;
  const exp = Date.now() + maxAge * 1000;
  // Persist a session row so logout can revoke the token even if it was
  // copied from the cookie jar.
  const sid = randomToken(24);
  getDb()
    .prepare(
      `INSERT INTO session (id, user_id, ip_hash, issued_at_ms, revoked_at_ms)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .run(sid, userId, ipHash || "unknown", Date.now());
  const token = encodeSession({
    uid: userId,
    sid,
    ip: ipHash || "unknown",
    exp,
  });
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: env.secureCookies,
    path: "/",
    maxAge,
  });
}

function revokeSessionToken(token: string | undefined) {
  const payload = decodeSession(token);
  if (!payload) return;
  getDb()
    .prepare(`UPDATE session SET revoked_at_ms = ? WHERE id = ? AND user_id = ?`)
    .run(Date.now(), payload.sid, payload.uid);
}

export async function clearSession() {
  const jar = await cookies();
  revokeSessionToken(jar.get(COOKIE)?.value);
  jar.set(COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

/**
 * Read session cookie and optionally enforce IP binding continuity.
 * Pass request when available so a stolen cookie on another IP is rejected.
 */
export async function getSessionUser(
  req?: Request | null,
): Promise<SessionUser | null> {
  const jar = await cookies();
  const payload = decodeSession(jar.get(COOKIE)?.value);
  if (!payload) return null;

  {
    const { getClientIp, hashIp } = await import("./ip");
    let currentIp = "unknown";
    if (req) {
      currentIp = hashIp(getClientIp(req));
    } else {
      try {
        const { headers } = await import("next/headers");
        const h = await headers();
        const fakeReq = {
          headers: {
            get(name: string) {
              return h.get(name);
            },
          },
        } as Request;
        currentIp = hashIp(getClientIp(fakeReq));
      } catch {
        currentIp = "unknown";
      }
    }
    if (
      payload.ip &&
      payload.ip !== "unknown" &&
      payload.ip !== currentIp
    ) {
      return null;
    }
  }

  // Reject tokens whose server-side session row was revoked (logout) or
  // never existed (forged/stale token).
  const row = getDb()
    .prepare(`SELECT revoked_at_ms FROM session WHERE id = ? AND user_id = ?`)
    .get(payload.sid, payload.uid) as
    | { revoked_at_ms: number | null }
    | undefined;
  if (!row || row.revoked_at_ms != null) return null;

  return getUserById(payload.uid);
}

type SessionUserRow = {
  id: string;
  username: string;
  nickname: string;
  qq: string | null;
  checkin_venue_id: string | null;
  registered_at: string;
};

function userRowById(userId: string): SessionUserRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, username, nickname, qq, checkin_venue_id, registered_at
         FROM app_user WHERE id = ?`,
      )
      .get(userId) as SessionUserRow | undefined) || null
  );
}

/** Return the browser-safe representation of a persisted application user. */
export function getUserById(userId: string): SessionUser | null {
  const row = userRowById(userId);
  if (!row) return null;
  return toSessionUser(row);
}

export function toSessionUser(row: SessionUserRow): SessionUser {
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    displayName: row.nickname,
    qq: row.qq || null,
    checkinVenueId: row.checkin_venue_id,
    registeredAt: row.registered_at,
  };
}

export function createUserId() {
  return randomToken(16);
}
