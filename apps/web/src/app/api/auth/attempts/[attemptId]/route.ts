import { z } from "zod";
import { getClientIp, hashIp } from "@/lib/auth/ip";
import { loginAttemptUser, resolveLoginAttempt } from "@/lib/auth/login-attempt";
import { setSession } from "@/lib/auth/session";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { getDb, nowIso } from "@/lib/db";
import { env } from "@/lib/env";
import { jsonError, jsonOk, mapServiceError } from "@/lib/api";

const paramsSchema = z.object({ attemptId: z.string().uuid() });

/** Poll an in-flight login without re-submitting a QR code. */
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
        `SELECT id, status, gateway_job_id, user_id, request_ip_hash, expires_at, error_code
         FROM join_attempt WHERE id = ? AND purpose = 'LOGIN_BIND'`
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
    if (attempt.status === "SUCCEEDED" && attempt.user_id) {
      await setSession(attempt.user_id, ipHash);
      return jsonOk({ attemptId, status: "SUCCEEDED", user: loginAttemptUser(attempt.user_id) });
    }
    if (attempt.status === "FAILED" || !attempt.gateway_job_id) {
      return mapServiceError(new Error(attempt.error_code || "GATEWAY_FAILED"));
    }

    const resolved = await resolveLoginAttempt(attempt.id, attempt.gateway_job_id, ipHash);
    if (resolved.status === "SUCCEEDED") {
      await setSession(resolved.userId, ipHash);
      return jsonOk({ attemptId, status: "SUCCEEDED", user: loginAttemptUser(resolved.userId) });
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
