import { randomToken, sha256Hex } from "../crypto";
import { getDb } from "../db";

/**
 * One-time completion capability tied to a ``join_attempt`` row.
 *
 * The raw token is returned to the browser once and must be presented to
 * ``POST /api/auth/complete`` within the attempt's lifetime.  The
 * server-side only stores a SHA-256 hash so a database leak cannot
 * produce valid tokens.
 *
 * Tokens live in their own table: sharing the QR concurrency-slot table
 * would let unconsumed tokens block new QR logins (and the slot cleanup
 * could delete a token before the client used it).
 */

/** Generate a fresh capability for *attemptId* and return the raw token. */
export function createCompletionCapability(attemptId: string): string {
  const db = getDb();
  const token = randomToken(32);
  const hash = sha256Hex(token);
  db.prepare(
    `INSERT INTO completion_token (id, attempt_id, created_at_ms) VALUES (?, ?, ?)`,
  ).run(`completion:${attemptId}:${hash}`, attemptId, Date.now());
  return token;
}

/** Validate and consume a capability.  Returns `true` once; subsequent
 *  calls with the same token return `false`. */
export function consumeCompletionCapability(
  attemptId: string,
  token: string,
): boolean {
  if (!token || token.length < 32) return false;
  const db = getDb();
  const hash = sha256Hex(token);
  const slotId = `completion:${attemptId}:${hash}`;
  const row = db
    .prepare(`SELECT id FROM completion_token WHERE id = ?`)
    .get(slotId) as { id: string } | undefined;
  if (!row) return false;
  // Single-use: delete immediately.  Stale tokens are purged by maintenance.
  db.prepare(`DELETE FROM completion_token WHERE id = ?`).run(slotId);
  return true;
}

/** Maintenance: purge capabilities that outlived their attempt lifetime. */
export function cleanupExpiredCompletionCapabilities(olderThanMs: number): number {
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM completion_token WHERE created_at_ms < ?`)
    .run(olderThanMs) as { changes?: number };
  return result.changes ?? 0;
}
