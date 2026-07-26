import { z } from "zod";
import { getClientIp, hashIp } from "@/lib/auth/ip";
import { loginAttemptUser } from "@/lib/auth/login-attempt";
import { setSession } from "@/lib/auth/session";
import { consumeCompletionCapability } from "@/lib/auth/completion-capability";
import { getDb, nowIso } from "@/lib/db";
import {
  assertSameOrigin,
  jsonError,
  jsonOk,
  mapServiceError,
  readJsonBody,
} from "@/lib/api";

const bodySchema = z.object({
  attemptId: z.string().uuid(),
  completionToken: z.string().min(32),
});

/**
 * Finalise a successful QR login attempt.
 *
 * Requires the one-time *completionToken* returned by the initial QR POST
 * (or a subsequent idempotent retry).  Once consumed the token is
 * invalidated so a GET on the poll endpoint cannot be exploited to obtain
 * a session from a shared IP address.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const body = bodySchema.parse(await readJsonBody(req));
    const ipHash = hashIp(getClientIp(req));

    // Validate and consume the one-time completion capability.
    if (!consumeCompletionCapability(body.attemptId, body.completionToken)) {
      throw new Error("AUTH_ATTEMPT_NOT_FOUND");
    }

    const db = getDb();
    const attempt = db
      .prepare(
        `SELECT id, status, user_id, request_ip_hash, expires_at
         FROM join_attempt WHERE id = ? AND purpose = 'LOGIN_BIND'`
      )
      .get(body.attemptId) as
      | {
          id: string;
          status: string;
          user_id: string | null;
          request_ip_hash: string | null;
          expires_at: string;
        }
      | undefined;

    if (!attempt || attempt.request_ip_hash !== ipHash) {
      throw new Error("AUTH_ATTEMPT_NOT_FOUND");
    }
    if (attempt.expires_at <= nowIso()) {
      db.prepare(
        `UPDATE join_attempt SET status = 'EXPIRED', error_code = 'JOB_EXPIRED', updated_at = ? WHERE id = ?`
      ).run(nowIso(), attempt.id);
      throw new Error("AUTH_ATTEMPT_NOT_FOUND");
    }
    if (attempt.status !== "SUCCEEDED" || !attempt.user_id) {
      return mapServiceError(new Error("GATEWAY_FAILED"));
    }

    // All checks passed — establish the session.
    await setSession(attempt.user_id, ipHash);
    const user = loginAttemptUser(attempt.user_id);
    return jsonOk({ status: "SUCCEEDED", user });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonError("INVALID_REQUEST", err.errors[0]?.message || "参数无效");
    }
    return mapServiceError(err);
  }
}
