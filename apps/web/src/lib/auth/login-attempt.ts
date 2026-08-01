/**
 * 登录尝试落库：消费 Gateway 验证结果 → upsert 用户、执行 IP 绑定
 * （配额失败回滚新建账号并记审计）、写 join_attempt.result_json。
 */
import { ServiceError } from "../api";
import { bindIpToUser } from "./ip-binding";
import { getUserById, upsertMaimaiUser } from "./session";
import { getDb, nowIso } from "../db";
import { audit } from "../queue/core";
import { getVerificationJob } from "../gateway/client";

export type LoginAttemptResult =
  | { status: "SUCCEEDED"; userId: string }
  | { status: "FAILED"; errorCode: string }
  | { status: "PROCESSING" };

/**
 * Consume the Gateway result for a login attempt. QR input is intentionally
 * absent: this function only receives the opaque Gateway job id.
 */
export async function resolveLoginAttempt(
  attemptId: string,
  gatewayJobId: string,
  ipHash: string
): Promise<LoginAttemptResult> {
  const result = await getVerificationJob(gatewayJobId);
  const db = getDb();
  const now = nowIso();

  if (result.status === "FAILED") {
    const errorCode = result.errorCode || "GATEWAY_FAILED";
    db.prepare(
      `UPDATE join_attempt SET status = 'FAILED', error_code = ?, updated_at = ? WHERE id = ?`
    ).run(errorCode, now, attemptId);
    return { status: "FAILED", errorCode };
  }
  if (result.status !== "SUCCEEDED" || !result.identityHash || !result.profile) {
    return { status: "PROCESSING" };
  }

  // Remember whether the user row existed before upsert so a failed IP
  // binding can roll back a newly created account instead of leaving an
  // orphan user behind.
  const preExisting = db
    .prepare(`SELECT id FROM app_user WHERE sdgb_identity_hash = ?`)
    .get(result.identityHash) as { id: string } | undefined;

  const userId = upsertMaimaiUser({
    identityHash: result.identityHash,
    sdgbUserIdCipher: null,
    displayName: result.profile.displayName,
    rating: result.profile.rating ?? null,
    title: result.profile.title ?? null,
    iconUrl: result.profile.iconUrl ?? null,
    profileSnapshot: {
      displayName: result.profile.displayName,
      rating: result.profile.rating ?? null,
      title: result.profile.title ?? null,
    },
  });

  try {
    bindIpToUser(ipHash, userId);
  } catch (err) {
    db.prepare(
      `UPDATE join_attempt
       SET status = 'FAILED', error_code = 'IP_ACCOUNT_BOUND', user_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(userId, now, attemptId);
    audit("IP_BINDING_QUOTA_HIT", "ip_day_binding", ipHash, "USER", userId, {
      reason: "per-day account quota exceeded",
    });
    if (!preExisting) {
      // A fresh account was created only for this login; drop it so the
      // quota failure does not leave orphan users behind.
      db.prepare(`DELETE FROM app_user WHERE id = ?`).run(userId);
    }
    throw err;
  }

  db.prepare(
    `UPDATE join_attempt
     SET status = 'SUCCEEDED', user_id = ?, result_json = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    userId,
    JSON.stringify({ profile: result.profile }),
    now,
    attemptId
  );
  return { status: "SUCCEEDED", userId };
}

export function loginAttemptUser(userId: string) {
  const user = getUserById(userId);
  if (!user) throw new ServiceError("GATEWAY_FAILED");
  return user;
}
