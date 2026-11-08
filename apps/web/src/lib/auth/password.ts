/**
 * 本地账号密码原语：scrypt 加盐哈希、常量时间校验、口令强度校验。
 *
 * 本系统不再依赖任何外部身份服务；玩家身份完全由本地账号承载，因此口令
 * 哈希必须是自适应、抗离线爆破的算法。这里使用 Node 内置 scrypt
 * （N=16384, r=8, p=1, 64 字节输出），单次哈希约 16 MiB 内存。
 */
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

/** Stored algorithm tag; changing the parameters requires a migration path. */
export const PASSWORD_ALGO = "scrypt-n16384-r8-p1";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 64;
// scrypt needs roughly 128 * N * r bytes; keep headroom above the default cap.
const MAX_MEM = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordHash = {
  hash: string;
  salt: string;
  algo: string;
};

function normalize(password: string): string {
  // Unicode normalization so a password typed with a different composition
  // still verifies, without widening the accepted character set.
  return password.normalize("NFC");
}

function derive(password: string, salt: string, keyLength: number): Buffer {
  return scryptSync(normalize(password), salt, keyLength, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
}

/** Hash a plaintext password with a fresh random salt. */
export function hashPassword(password: string): PasswordHash {
  const salt = randomBytes(16).toString("base64url");
  const hash = derive(password, salt, KEY_BYTES).toString("base64url");
  return { hash, salt, algo: PASSWORD_ALGO };
}

/** Constant-time verification of a plaintext password against a stored hash. */
export function verifyPassword(
  password: string,
  stored: { hash: string | null; salt: string | null; algo: string | null },
): boolean {
  if (!stored.hash || !stored.salt) return false;
  if (stored.algo !== PASSWORD_ALGO) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(stored.hash, "base64url");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const actual = derive(password, stored.salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Burn the same scrypt work used by a real verification.
 *
 * Login runs this when the username does not exist, so the response time does
 * not disclose account existence.
 */
export function burnPasswordWork(password: string): void {
  derive(password, "vw-nonexistent-account-salt", KEY_BYTES);
}

/**
 * Password policy for new accounts.  Returns a stable error code the API can
 * map to an HTTP status, or `null` when the password is acceptable.
 */
export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== "string") return "INVALID_PASSWORD";
  const value = normalize(password);
  if (value.length < PASSWORD_MIN_LENGTH) return "PASSWORD_TOO_SHORT";
  if (value.length > PASSWORD_MAX_LENGTH) return "PASSWORD_TOO_LONG";
  if (value.trim().length === 0) return "INVALID_PASSWORD";
  // Reject the most common throwaway choices outright; the length rule above
  // is the real control, this only removes the worst offenders.
  if (/^(.)\1+$/.test(value)) return "PASSWORD_TOO_WEAK";
  return null;
}
