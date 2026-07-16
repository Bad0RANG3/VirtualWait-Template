import { randomUUID } from "crypto";
import { z } from "zod";
import { setSession } from "@/lib/auth/session";
import { loginAttemptUser, resolveLoginAttempt } from "@/lib/auth/login-attempt";
import { getClientIp, hashIp } from "@/lib/auth/ip";
import { bindIpToUser } from "@/lib/auth/ip-binding";
import {
  releaseQrSlot,
  reserveQrVerification,
} from "@/lib/auth/rate-limit";
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
 * issue day-scoped cookie, enforce one account per IP per day.
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
      if (existing.status === "SUCCEEDED" && existing.user_id) {
        bindIpToUser(ipHash, existing.user_id);
        await setSession(existing.user_id, ipHash);
        const user = loginAttemptUser(existing.user_id);
        return jsonOk({ attemptId: existing.id, status: "SUCCEEDED", user });
      }
      return jsonOk({ attemptId: existing.id, status: existing.status });
    }

    const jobId = await createVerificationJob(body.qrCode);
    // qrCode intentionally not persisted
    db.prepare(
      `INSERT INTO join_attempt
       (id, user_id, queue_id, purpose, gateway_job_id, idempotency_key, request_ip_hash, status,
        expires_at, created_at, updated_at)
       VALUES (?, NULL, NULL, 'LOGIN_BIND', ?, ?, ?, 'PROCESSING', ?, ?, ?)`
    ).run(attemptId, jobId, idem, ipHash, addSeconds(now, 120), now, now);

    const result = await resolveLoginAttempt(attemptId, jobId, ipHash);
    if (result.status === "SUCCEEDED") {
      await setSession(result.userId, ipHash);
      return jsonOk({
        attemptId,
        status: "SUCCEEDED",
        user: loginAttemptUser(result.userId),
      });
    }

    if (result.status === "FAILED") {
      return mapServiceError(new Error("GATEWAY_FAILED"));
    }

    return jsonOk({ attemptId, status: "PROCESSING" });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonError("INVALID_REQUEST", err.errors[0]?.message || "参数无效");
    }
    return mapServiceError(err);
  } finally {
    if (slotId) releaseQrSlot(slotId);
  }
}
