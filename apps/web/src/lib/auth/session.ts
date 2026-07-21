import { cookies } from "next/headers";
import { getDb, nowIso } from "../db";
import { env } from "../env";
import { randomToken, safeEqual, signPayload } from "../crypto";
import type { SessionUser } from "../types";
const COOKIE = "vw_session";
const SESSION_MAX_AGE_SECONDS_PER_DAY = 24 * 60 * 60;

type SessionPayload = {
  uid: string;
  /** Legacy field from the old midnight-expiring session format. */
  day?: string;
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
      Buffer.from(body, "base64url").toString("utf8")
    ) as SessionPayload;
    if (
      typeof payload.uid !== "string" ||
      payload.uid.length < 1 ||
      payload.uid.length > 128 ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      (payload.day !== undefined &&
        (typeof payload.day !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(payload.day))) ||
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
  const token = encodeSession({
    uid: userId,
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

export async function clearSession() {
  const jar = await cookies();
  jar.set(COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

/**
 * Read session cookie and optionally enforce IP binding continuity.
 * Pass request when available so a stolen cookie on another IP is rejected.
 */
export async function getSessionUser(
  req?: Request | null
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
      currentIp !== "unknown" &&
      payload.ip !== currentIp
    ) {
      return null;
    }
  }

  return getUserById(payload.uid);
}

/** Return the browser-safe representation of a persisted application user. */
export function getUserById(userId: string): SessionUser | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, nickname, display_name, rating, show_rating_public, title, sdgb_identity_hash,
              avatar_url
       FROM app_user WHERE id = ?`
    )
    .get(userId) as
    | {
        id: string;
        nickname: string;
        display_name: string | null;
        rating: number | null;
        show_rating_public: number;
        title: string | null;
        sdgb_identity_hash: string | null;
        avatar_url: string | null;
      }
    | undefined;
  if (!row) return null;
  const bound = Boolean(row.sdgb_identity_hash);
  return {
    id: row.id,
    nickname: row.nickname,
    displayName: row.nickname,
    rating: bound ? row.rating : null,
    showRatingPublic: Boolean(row.show_rating_public),
    title: bound ? row.title : null,
    bound,
    avatarUrl: row.avatar_url,
    loginProvider: bound ? "maimai" : "unknown",
  };
}

export function createUserId() {
  return randomToken(16);
}

export function touchUserUpdatedAt(userId: string) {
  getDb()
    .prepare(`UPDATE app_user SET updated_at = ? WHERE id = ?`)
    .run(nowIso(), userId);
}

/**
 * Find or create a user by maimai identity hash. Existing users keep their
 * editable public nickname; maimai profile fields are refreshed separately.
 */
export function upsertMaimaiUser(input: {
  identityHash: string;
  /** Ciphered/opaque sdgb user id storage; never return to browser. */
  sdgbUserIdCipher: string | null;
  displayName: string;
  rating?: number | null;
  title?: string | null;
  iconUrl?: string | null;
  profileSnapshot?: Record<string, unknown> | null;
}) {
  const db = getDb();
  const now = nowIso();
  const existing = db
    .prepare(
      `SELECT id, nickname FROM app_user WHERE sdgb_identity_hash = ?`
    )
    .get(input.identityHash) as { id: string; nickname: string } | undefined;

  const preferredName = (input.displayName || "").trim().slice(0, 20) || "舞萌玩家";

  if (existing) {
    db.prepare(
      `UPDATE app_user
       SET display_name = ?,
           sdgb_user_id_cipher = COALESCE(?, sdgb_user_id_cipher),
           rating = ?,
           title = ?,
           icon_url = ?,
           profile_snapshot = ?,
           bound_at = COALESCE(bound_at, ?),
           updated_at = ?
       WHERE id = ?`
    ).run(
      input.displayName,
      input.sdgbUserIdCipher,
      input.rating ?? null,
      input.title ?? null,
      input.iconUrl ?? null,
      input.profileSnapshot ? JSON.stringify(input.profileSnapshot) : null,
      now,
      now,
      existing.id
    );
    return existing.id;
  }

  const id = createUserId();
  let nickname = preferredName;
  let i = 1;
  while (db.prepare(`SELECT id FROM app_user WHERE nickname = ?`).get(nickname)) {
    nickname = `${preferredName.slice(0, 16)}_${i++}`;
  }

  db.prepare(
    `INSERT INTO app_user
     (id, nickname, password_hash, password_salt, wechat_openid, wechat_unionid,
      avatar_url, sdgb_identity_hash, sdgb_user_id_cipher, display_name, rating,
      title, icon_url, profile_snapshot, bound_at, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    nickname,
    input.iconUrl ?? null,
    input.identityHash,
    input.sdgbUserIdCipher,
    nickname,
    input.rating ?? null,
    input.title ?? null,
    input.iconUrl ?? null,
    input.profileSnapshot ? JSON.stringify(input.profileSnapshot) : null,
    now,
    now,
    now
  );
  return id;
}
