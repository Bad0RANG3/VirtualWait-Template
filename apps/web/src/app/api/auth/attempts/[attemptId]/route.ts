import { z } from "zod";
import { getClientIp, hashIp } from "@/lib/auth/ip";
import { resolveLoginAttempt } from "@/lib/auth/login-attempt";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { getDb, nowIso } from "@/lib/db";
import { env } from "@/lib/env";
import { jsonError, jsonOk, mapServiceError } from "@/lib/api";

const paramsSchema = z.object({ attemptId: z.string().uuid() });

/**
 * Poll an in-flight login attempt.  This endpoint is read-only — it never
 * sets a session cookie.  The client must present a one-time completion
 * capability to ``POST /api/auth/attempts/:id/complete`` to finalise login.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ attemptId: string }> }
) {
  try {
    const { attemptId } = paramsSchema.parse(await ctx.params);
    const ipHash = hashIp(getClientIp(req));
    const limit = consumeRateLimit({
      key: `auth-attempt-poll:ip:${ipHash}`,
      limit: env.authAttemptPollLimit,
      windowSec: env.authAttemptPollWindowSec,
    });
    if (!limit.ok) {
      return jsonError("RATE_LIMITED", `请求过于频繁，请 ${limit.retryAfterSec} 秒后再试`, 429);
    }

    const db = getDb();
    const attempt = db
      .prepare(
        `SELECT id, status, gateway_job_id, user_id, request_ip_hash, expires_at, error_code, result_json
         FROM join_attempt WHERE id = ? AND purpose IN ('LOGIN_BIND','REGISTER_BIND')`
      )
      .get(attemptId) as
      | {
          id: string;
          status: string;
          gateway_job_id: string | null;
          user_id: string | null;
          request_ip_hash: string | null;
          expires_at: string;
          error_code: string | null;
          result_json: string | null;
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

    // Terminal states — return status only, no session mutation. A resolved
    // bind attempt carries its public profile for the client to display.
    if (attempt.status === "SUCCEEDED") {
      let profile: unknown;
      if (attempt.result_json) {
        try {
          profile = (JSON.parse(attempt.result_json) as { profile?: unknown }).profile;
        } catch {
          // ignore malformed legacy rows; the client only needs the status
        }
      }
      return jsonOk({
        attemptId,
        status: "SUCCEEDED",
        ...(profile ? { profile } : {}),
      });
    }
    if (attempt.status === "FAILED" || !attempt.gateway_job_id) {
      return mapServiceError(new Error(attempt.error_code || "GATEWAY_FAILED"));
    }

    // Defer gateway polling to the resolve helper — success/failure is
    // persisted but we still do not set a session here.
    const resolved = await resolveLoginAttempt(attempt.id, attempt.gateway_job_id, ipHash);
    if (resolved.status === "SUCCEEDED") {
      return jsonOk({ attemptId, status: "SUCCEEDED" });
    }
    if (resolved.status === "FAILED") {
      return mapServiceError(new Error(resolved.errorCode || "GATEWAY_FAILED"));
    }
    return jsonOk({ attemptId, status: "PROCESSING" });
  } catch (err) {
    if (err instanceof z.ZodError) return jsonError("INVALID_REQUEST", "参数无效");
    return mapServiceError(err);
  }
}
