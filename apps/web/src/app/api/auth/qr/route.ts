import { randomUUID } from "crypto";
import { z } from "zod";
import { resolveLoginAttempt } from "@/lib/auth/login-attempt";
import { getClientIp, hashIp } from "@/lib/auth/ip";
import { bindIpToUser } from "@/lib/auth/ip-binding";
import {
  releaseQrSlot,
  reserveQrVerification,
} from "@/lib/auth/rate-limit";
import { createCompletionCapability } from "@/lib/auth/completion-capability";
import { getDb, nowIso, addSeconds } from "@/lib/db";
import { createVerificationJob } from "@/lib/gateway/client";
import {
  assertSameOrigin,
  jsonError,
  jsonOk,
  mapServiceError,
  readJsonBody,
} from "@/lib/api";

const schema = z.object({
  qrCode: z.string().trim().min(4).max(2048),
  idempotencyKey: z.string().uuid().optional(),
});

/**
 * Primary login: exchange maimai QR once, identify by userid (HMAC),
 * enforce one account per IP per day.
 *
 * The response includes a one-time *completionToken* that the client must
 * present to ``POST /api/auth/attempts/:id/complete`` to finalise the
 * session.  Neither this endpoint nor the polling GET set a cookie.
 */
export async function POST(req: Request) {
  let slotId: string | null = null;
  try {
    assertSameOrigin(req);
    const ip = getClientIp(req);
    const ipHash = hashIp(ip);

    const reservation = reserveQrVerification(ipHash);
    if (!reservation.ok && reservation.code === "RATE_LIMITED") {
      return jsonError(
        "RATE_LIMITED",
        `请求过于频繁，请 ${reservation.retryAfterSec} 秒后再试`,
        429
      );
    }
    if (!reservation.ok) return mapServiceError(new Error("QR_BUSY"));
    slotId = reservation.slotId;

    const body = schema.parse(await readJsonBody(req));
    const db = getDb();
    const now = nowIso();
    const attemptId = randomUUID();
    const idem = body.idempotencyKey || randomUUID();

    const existing = db
      .prepare(
        `SELECT id, status, gateway_job_id, result_json, user_id, request_ip_hash
         FROM join_attempt WHERE idempotency_key = ?`
      )
      .get(idem) as
      | {
          id: string;
          status: string;
          gateway_job_id: string | null;
          result_json: string | null;
          user_id: string | null;
          request_ip_hash: string | null;
        }
      | undefined;

    if (existing) {
      // An idempotency key is a client capability: do not allow a key observed
      // on one network to restore another account's session.
      if (existing.request_ip_hash !== ipHash) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      // Rotate: invalidate any unconsumed capability for the attempt so a
      // replayed POST can never resurrect a stolen/leaked earlier token.
      db.prepare(`DELETE FROM completion_token WHERE attempt_id = ?`).run(existing.id);
      const completionToken = createCompletionCapability(existing.id);
      if (existing.status === "SUCCEEDED" && existing.user_id) {
        bindIpToUser(ipHash, existing.user_id);
        return jsonOk({
          attemptId: existing.id,
          status: "SUCCEEDED",
          completionToken,
        });
      }
      // Still processing — reissue the token: the original may have been lost
      // client-side (network error between POST response and storage).
      return jsonOk({ attemptId: existing.id, status: existing.status, completionToken });
    }

    const jobId = await createVerificationJob(body.qrCode);
    // qrCode intentionally not persisted
    db.prepare(
      `INSERT INTO join_attempt
       (id, user_id, queue_id, purpose, gateway_job_id, idempotency_key, request_ip_hash, status,
        expires_at, created_at, updated_at)
       VALUES (?, NULL, NULL, 'LOGIN_BIND', ?, ?, ?, 'PROCESSING', ?, ?, ?)`
    ).run(attemptId, jobId, idem, ipHash, addSeconds(now, 120), now, now);

    // Issue a completion capability before resolving — the client needs it
    // regardless of whether resolution is synchronous or deferred.
    const completionToken = createCompletionCapability(attemptId);

    const result = await resolveLoginAttempt(attemptId, jobId, ipHash);
    if (result.status === "SUCCEEDED") {
      return jsonOk({
        attemptId,
        status: "SUCCEEDED",
        completionToken,
      });
    }

    if (result.status === "FAILED") {
      return mapServiceError(new Error(result.errorCode || "GATEWAY_FAILED"));
    }

    return jsonOk({ attemptId, status: "PROCESSING", completionToken });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonError("INVALID_REQUEST", err.errors[0]?.message || "参数无效");
    }
    return mapServiceError(err);
  } finally {
    if (slotId) releaseQrSlot(slotId);
  }
}
