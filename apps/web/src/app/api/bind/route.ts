import { randomUUID } from "crypto";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { getClientIp, hashIp } from "@/lib/auth/ip";
import { releaseQrSlot, reserveQrVerification } from "@/lib/auth/rate-limit";
import { getDb, nowIso, addSeconds } from "@/lib/db";
import { createVerificationJob, getVerificationJob } from "@/lib/gateway/client";
import {
  assertSameOrigin,
  jsonError,
  jsonOk,
  mapServiceError,
  readJsonBody,
} from "@/lib/api";

const schema = z.object({
  qrCode: z.string().trim().min(4).max(2048),
  purpose: z.enum(["REGISTER_BIND", "LOGIN_BIND"]).default("LOGIN_BIND"),
  idempotencyKey: z.string().uuid().optional(),
});

/** Refresh maimai public profile for the already-logged-in account. */
export async function POST(req: Request) {
  let slotId: string | null = null;
  try {
    assertSameOrigin(req);
    const user = await getSessionUser(req);
    if (!user) return mapServiceError(new Error("NOT_AUTHENTICATED"));

    const body = schema.parse(await readJsonBody(req));
    const ipHash = hashIp(getClientIp(req));
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
    const db = getDb();
    const now = nowIso();
    const attemptId = randomUUID();
    const idem = body.idempotencyKey || randomUUID();

    const existing = db
      .prepare(
        `SELECT id, status, gateway_job_id, user_id, request_ip_hash
         FROM join_attempt WHERE idempotency_key = ?`
      )
      .get(idem) as
      | {
          id: string;
          status: string;
          gateway_job_id: string | null;
          user_id: string | null;
          request_ip_hash: string | null;
        }
      | undefined;
    if (existing) {
      if (existing.user_id !== user.id || existing.request_ip_hash !== ipHash) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      return jsonOk({
        attemptId: existing.id,
        status: existing.status,
      });
    }

    const jobId = await createVerificationJob(body.qrCode);
    // qrCode intentionally not persisted
    db.prepare(
      `INSERT INTO join_attempt
       (id, user_id, queue_id, purpose, gateway_job_id, idempotency_key, request_ip_hash, status, expires_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, 'PROCESSING', ?, ?, ?)`
    ).run(
      attemptId,
      user.id,
      body.purpose,
      jobId,
      idem,
      ipHash,
      addSeconds(now, 120),
      now,
      now
    );

    const result = await getVerificationJob(jobId);
    if (result.status === "SUCCEEDED" && result.identityHash && result.profile) {
      const current = db
        .prepare(`SELECT sdgb_identity_hash FROM app_user WHERE id = ?`)
        .get(user.id) as { sdgb_identity_hash: string | null } | undefined;

      if (
        current?.sdgb_identity_hash &&
        current.sdgb_identity_hash !== result.identityHash
      ) {
        db.prepare(
          `UPDATE join_attempt
           SET status = 'FAILED', error_code = 'IDENTITY_MISMATCH', updated_at = ?
           WHERE id = ?`
        ).run(now, attemptId);
        return mapServiceError(new Error("IDENTITY_MISMATCH"));
      }

      const conflict = db
        .prepare(
          `SELECT id FROM app_user
           WHERE sdgb_identity_hash = ? AND id != ?`
        )
        .get(result.identityHash, user.id) as { id: string } | undefined;
      if (conflict) {
        db.prepare(
          `UPDATE join_attempt
           SET status = 'FAILED', error_code = 'BIND_CONFLICT', updated_at = ?
           WHERE id = ?`
        ).run(now, attemptId);
        return mapServiceError(new Error("BIND_CONFLICT"));
      }

      db.prepare(
        `UPDATE app_user
         SET sdgb_identity_hash = ?,
             sdgb_user_id_cipher = COALESCE(?, sdgb_user_id_cipher),
             rating = ?,
             title = ?,
             icon_url = ?,
             profile_snapshot = ?,
             bound_at = COALESCE(bound_at, ?),
             updated_at = ?
         WHERE id = ?`
      ).run(
        result.identityHash,
        null,
        result.profile.rating ?? null,
        result.profile.title ?? null,
        result.profile.iconUrl ?? null,
        JSON.stringify({
          ...result.profile,
          maimaiDisplayName: result.profile.displayName,
        }),
        now,
        now,
        user.id
      );

      db.prepare(
        `UPDATE join_attempt
         SET status = 'SUCCEEDED', result_json = ?, updated_at = ?
         WHERE id = ?`
      ).run(JSON.stringify({ profile: result.profile }), now, attemptId);

      return jsonOk({
        attemptId,
        status: "SUCCEEDED",
        profile: {
          displayName: user.nickname,
          rating: result.profile.rating ?? null,
          title: result.profile.title ?? null,
          iconUrl: result.profile.iconUrl ?? null,
          maimaiDisplayName: result.profile.displayName,
        },
      });
    }

    if (result.status === "FAILED") {
      db.prepare(
        `UPDATE join_attempt
         SET status = 'FAILED', error_code = ?, updated_at = ?
         WHERE id = ?`
      ).run(result.errorCode || "GATEWAY_FAILED", now, attemptId);
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
