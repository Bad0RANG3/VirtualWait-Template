import { z } from "zod";
import { authenticate } from "@/lib/auth/account";
import { getClientIp, hashIp } from "@/lib/auth/ip";
import { consumeLoginLimit, recordLoginFailure } from "@/lib/auth/rate-limit";
import { setSession } from "@/lib/auth/session";
import { ServiceError } from "@/lib/api";
import {
  assertSameOrigin,
  jsonError,
  jsonOk,
  mapServiceError,
  readJsonBody,
} from "@/lib/api";

const bodySchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

/** Username + password login. All verification is local to this deployment. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const body = bodySchema.parse(await readJsonBody(req));
    const ipHash = hashIp(getClientIp(req));

    const limit = consumeLoginLimit(ipHash, body.username);
    if (!limit.ok) {
      return jsonError(
        "RATE_LIMITED",
        `尝试过于频繁，请 ${limit.retryAfterSec} 秒后再试`,
        429,
      );
    }

    let user;
    try {
      user = authenticate({
        username: body.username,
        password: body.password,
        ipHash,
      });
    } catch (err) {
      // Only rejected passwords count against the shared client IP, so a venue
      // NAT full of successful logins never trips the limiter.
      if (err instanceof ServiceError && err.code === "INVALID_CREDENTIALS") {
        recordLoginFailure(ipHash);
      }
      throw err;
    }

    await setSession(user.id, ipHash);
    return jsonOk({ user });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonError("INVALID_REQUEST", err.errors[0]?.message || "参数无效");
    }
    return mapServiceError(err);
  }
}
