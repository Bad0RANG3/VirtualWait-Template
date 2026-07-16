import { bindIpToUser } from "./ip-binding";
import { getUserById, upsertMaimaiUser } from "./session";
import { getDb, nowIso } from "../db";
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
  if (!user) throw new Error("GATEWAY_FAILED");
  return user;
}
