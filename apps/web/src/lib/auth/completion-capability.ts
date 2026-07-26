import { randomToken, sha256Hex } from "../crypto";
import { getDb } from "../db";

/**
 * One-time completion capability tied to a ``join_attempt`` row.
 *
 * The raw token is returned to the browser once and must be presented to
 * ``POST /api/auth/complete`` within the attempt's lifetime.  The
 * server-side only stores a SHA-256 hash so a database leak cannot
 * produce valid tokens.
 */

/** Generate a fresh capability for *attemptId* and return the raw token. */
export function createCompletionCapability(attemptId: string): string {
  const db = getDb();
  const token = randomToken(32);
  const hash = sha256Hex(token);
  db.prepare(
    `INSERT INTO qr_concurrency_slot (id, created_at_ms) VALUES (?, ?)`
  ).run(`completion:${attemptId}:${hash}`, Date.now());
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
    .prepare(`SELECT id FROM qr_concurrency_slot WHERE id = ?`)
    .get(slotId) as { id: string } | undefined;
  if (!row) return false;
  // Single-use: delete immediately.  qr_concurrency_slot rows are
  // ephemeral and already cleaned up by maintenance.
  db.prepare(`DELETE FROM qr_concurrency_slot WHERE id = ?`).run(slotId);
  return true;
}
