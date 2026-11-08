/**
 * 本地账号：注册（用户名 + 口令 + 展示昵称，用场地签到码证明在场所）与口令登录。
 *
 * 这是系统唯一的身份来源。全流程只读写本地 SQLite，不向任何外部服务发包。
 */
import { ServiceError } from "../api";
import { getDb, nowIso, type Db } from "../db";
import { env } from "../env";
import { audit } from "../queue/core";
import { venueIdBySlug, verifyVenueCheckinCode } from "../settings/checkin";
import { bindIpToUser, recordUserLogin } from "./ip-binding";
import {
  burnPasswordWork,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
  type PasswordHash,
} from "./password";
import { createUserId, toSessionUser } from "./session";
import type { SessionUser } from "../types";

/** Login name: ASCII only, so it stays unambiguous in logs and support. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;
export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 20;

type CredentialRow = {
  id: string;
  username: string;
  nickname: string;
  password_hash: string | null;
  password_salt: string | null;
  password_algo: string | null;
  qq: string | null;
  checkin_venue_id: string | null;
  registered_at: string;
};

type AccountRow = {
  id: string;
  username: string;
  nickname: string;
  qq: string | null;
  checkin_venue_id: string | null;
  registered_at: string;
};

/**
 * Canonical form used for uniqueness and lookup.
 *
 * NFKC folds full-width/compatibility characters, so "Ａdmin" and "Admin"
 * cannot coexist; the case-insensitive comparison happens in SQL
 * (`COLLATE NOCASE`). Cross-script homoglyphs (Cyrillic "А") remain a residual
 * risk documented in docs/SECURITY.md — the venue queue is not an identity
 * provider and has no skeleton table for every Unicode script.
 */
export function canonicalNickname(raw: string): string {
  return (raw || "").normalize("NFKC").trim();
}

/** Username lookup is case-insensitive (the column is COLLATE NOCASE). */
export function findCredentialByUsername(username: string): CredentialRow | null {
  const value = (username || "").trim();
  if (!value) return null;
  return (
    (getDb()
      .prepare(
        `SELECT id, username, nickname, password_hash, password_salt, password_algo,
                qq, checkin_venue_id, registered_at
         FROM app_user WHERE username = ? COLLATE NOCASE`,
      )
      .get(value) as CredentialRow | undefined) || null
  );
}

export function validateUsername(raw: string): string | null {
  const value = (raw || "").trim();
  if (!USERNAME_PATTERN.test(value)) return "INVALID_USERNAME";
  return null;
}

export function validateNickname(raw: string): string | null {
  const value = canonicalNickname(raw);
  if (value.length < NICKNAME_MIN_LENGTH || value.length > NICKNAME_MAX_LENGTH) {
    return "INVALID_NICKNAME";
  }
  // Allow CJK, letters, digits, punctuation and emoji; reject control and
  // invisible format characters that would let one account impersonate another.
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return "INVALID_NICKNAME";
  if (value.replace(/\s+/g, "").length < 1) return "INVALID_NICKNAME";
  return null;
}

type NewAccountInput = {
  username: string;
  nickname: string;
  /** Pre-computed by the caller so scrypt never runs inside a write transaction. */
  credential: PasswordHash;
  qq: string | null;
  checkinVenueId: string | null;
};

/**
 * Insert one account row plus its credential columns.
 *
 * The password hash is passed in: hashing takes tens of milliseconds and must
 * happen *before* the transaction opens, otherwise the SQLite write lock (which
 * the maintenance process also needs) would be held during scrypt.
 *
 * Uniqueness violations surface as ServiceError so the API can answer 409
 * instead of leaking a raw SQLite message.
 */
function insertAccount(db: Db, input: NewAccountInput) {
  const id = createUserId();
  const now = nowIso();
  try {
    db.prepare(
      `INSERT INTO app_user
       (id, username, nickname, password_hash, password_salt, password_algo, qq,
        checkin_venue_id, registered_at, last_login_ip_hash, last_login_day,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      id,
      input.username,
      input.nickname,
      input.credential.hash,
      input.credential.salt,
      input.credential.algo,
      input.qq,
      input.checkinVenueId,
      now,
      now,
      now,
    );
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      const message = err.message;
      throw new ServiceError(
        /nickname/i.test(message)
          ? "NICKNAME_TAKEN"
          : /app_user\.qq/i.test(message)
            ? "QQ_TAKEN"
            : "USERNAME_TAKEN",
      );
    }
    throw err;
  }
  return id;
}

function accountById(id: string): SessionUser {
  const row = getDb()
    .prepare(
      `SELECT id, username, nickname, qq, checkin_venue_id, registered_at
       FROM app_user WHERE id = ?`,
    )
    .get(id) as AccountRow;
  return toSessionUser(row);
}

function assertCheckin(
  venueSlug: string | null | undefined,
  checkinCode: string | null | undefined,
): string | null {
  const slug = (venueSlug || "").trim();
  const code = (checkinCode || "").trim();
  if (!slug) {
    if (env.checkinRequired) throw new ServiceError("CHECKIN_REQUIRED");
    return null;
  }
  const venueId = venueIdBySlug(slug);
  if (!venueId) throw new ServiceError("CHECKIN_VENUE_UNKNOWN");
  if (code) {
    if (!verifyVenueCheckinCode(venueId, code)) {
      throw new ServiceError("CHECKIN_INVALID");
    }
    return venueId;
  }
  if (env.checkinRequired) throw new ServiceError("CHECKIN_REQUIRED");
  return null;
}

export type RegisterAccountInput = {
  username: string;
  password: string;
  nickname: string;
  venueSlug?: string | null;
  checkinCode?: string | null;
  ipHash: string;
};

/**
 * Create a local account through the public self-service path.
 *
 * A live venue check-in code (see lib/settings/checkin.ts) proves the player is
 * on site and pins the account to that venue.  When `CHECKIN_REQUIRED=false`
 * the code may be omitted, which is intended for closed/intranet deployments
 * only.
 *
 * The account row and its per-IP registration quota entry are written in one
 * transaction: a quota rejection can no longer leave an account behind (or a
 * binding that points at a deleted row).
 */
export function registerAccount(input: RegisterAccountInput): SessionUser {
  if (!env.registrationEnabled) throw new ServiceError("REGISTRATION_DISABLED");
  if (validateUsername(input.username)) throw new ServiceError("INVALID_USERNAME");
  const nickname = canonicalNickname(input.nickname);
  const nicknameError = validateNickname(nickname);
  if (nicknameError) throw new ServiceError(nicknameError);
  const passwordError = validatePasswordStrength(input.password);
  if (passwordError) throw new ServiceError(passwordError);

  const username = input.username.trim();
  const checkinVenueId = assertCheckin(input.venueSlug, input.checkinCode);

  const db = getDb();
  const taken = db
    .prepare(`SELECT id FROM app_user WHERE username = ? COLLATE NOCASE`)
    .get(username) as { id: string } | undefined;
  if (taken) throw new ServiceError("USERNAME_TAKEN");
  const nicknameTaken = db
    .prepare(`SELECT id FROM app_user WHERE nickname = ? COLLATE NOCASE`)
    .get(nickname) as { id: string } | undefined;
  if (nicknameTaken) throw new ServiceError("NICKNAME_TAKEN");

  // Hash before opening the transaction: scrypt must not hold the write lock.
  const credential = hashPassword(input.password);

  let id: string;
  try {
    id = db.transaction(() => {
      const created = insertAccount(db, {
        username,
        nickname,
        credential,
        qq: null,
        checkinVenueId,
      });
      // Per-IP daily account quota: the only place new identities can be minted.
      bindIpToUser(input.ipHash, created);
      return created;
    })();
  } catch (err) {
    if (err instanceof ServiceError && err.code === "IP_ACCOUNT_BOUND") {
      // Recorded after the rollback so the audit row survives.
      audit("IP_BINDING_QUOTA_HIT", "ip_day_binding", input.ipHash, "USER", null, {
        reason: "per-day registration quota exceeded",
      });
    }
    throw err;
  }

  audit("ACCOUNT_REGISTERED", "app_user", id, "USER", id, {
    venueId: checkinVenueId,
    checkinVerified: Boolean(checkinVenueId),
  });
  return accountById(id);
}

export type OperatorAccountInput = {
  username: string;
  password: string;
  nickname: string;
  qq?: string | null;
  venueSlug?: string | null;
};

/**
 * Create an account on behalf of an operator (CLI only, see
 * `npm run account:create`).
 *
 * It intentionally skips `REGISTRATION_ENABLED` and the per-IP quota — the
 * caller already has filesystem/environment access — but keeps every other
 * validation rule so an operator-created account is indistinguishable from a
 * self-service one.  No check-in code is required: an operator is the proof of
 * presence.
 */
export function createAccountAsOperator(input: OperatorAccountInput): SessionUser {
  if (validateUsername(input.username)) throw new ServiceError("INVALID_USERNAME");
  const nickname = canonicalNickname(input.nickname);
  const nicknameError = validateNickname(nickname);
  if (nicknameError) throw new ServiceError(nicknameError);
  const passwordError = validatePasswordStrength(input.password);
  if (passwordError) throw new ServiceError(passwordError);

  const qq = (input.qq || "").trim() || null;
  if (qq && !/^\d{5,12}$/.test(qq)) throw new ServiceError("INVALID_QQ");

  const venueSlug = (input.venueSlug || "").trim();
  let checkinVenueId: string | null = null;
  if (venueSlug) {
    checkinVenueId = venueIdBySlug(venueSlug);
    if (!checkinVenueId) throw new ServiceError("CHECKIN_VENUE_UNKNOWN");
  }

  const db = getDb();
  const username = input.username.trim();
  const taken = db
    .prepare(`SELECT id FROM app_user WHERE username = ? COLLATE NOCASE`)
    .get(username) as { id: string } | undefined;
  if (taken) throw new ServiceError("USERNAME_TAKEN");
  const nicknameTaken = db
    .prepare(`SELECT id FROM app_user WHERE nickname = ? COLLATE NOCASE`)
    .get(nickname) as { id: string } | undefined;
  if (nicknameTaken) throw new ServiceError("NICKNAME_TAKEN");
  if (qq) {
    const qqTaken = db
      .prepare(`SELECT id FROM app_user WHERE qq = ?`)
      .get(qq) as { id: string } | undefined;
    if (qqTaken) throw new ServiceError("QQ_TAKEN");
  }

  const credential = hashPassword(input.password);
  const id = db.transaction(() =>
    insertAccount(db, {
      username,
      nickname,
      credential,
      qq,
      checkinVenueId,
    }),
  )();

  audit("ACCOUNT_CREATED_BY_OPERATOR", "app_user", id, "ADMIN", "cli", {
    venueId: checkinVenueId,
    qqBound: Boolean(qq),
  });
  return accountById(id);
}

/**
 * Verify a username/password pair.
 *
 * Failures always surface the same `INVALID_CREDENTIALS` code and still run a
 * dummy hash comparison so the response time does not reveal whether the
 * username exists.
 */
export function authenticate(input: {
  username: string;
  password: string;
  ipHash: string;
}): SessionUser {
  const row = findCredentialByUsername(input.username);
  if (!row) {
    // Same scrypt cost as a real check, so response time is not an oracle.
    burnPasswordWork(input.password || "");
    throw new ServiceError("INVALID_CREDENTIALS");
  }
  const ok = verifyPassword(input.password || "", {
    hash: row.password_hash,
    salt: row.password_salt,
    algo: row.password_algo,
  });
  if (!ok) throw new ServiceError("INVALID_CREDENTIALS");

  recordUserLogin(input.ipHash, row.id);
  audit("ACCOUNT_LOGGED_IN", "app_user", row.id, "USER", row.id);
  return toSessionUser({
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    qq: row.qq,
    checkin_venue_id: row.checkin_venue_id,
    registered_at: row.registered_at,
  });
}
