import { z } from "zod";
import { registerAccount } from "@/lib/auth/account";
import { getClientIp, hashIp } from "@/lib/auth/ip";
import { consumeRegistrationLimit } from "@/lib/auth/rate-limit";
import { setSession } from "@/lib/auth/session";
import { env } from "@/lib/env";
import {
  assertSameOrigin,
  jsonError,
  jsonOk,
  mapServiceError,
  readJsonBody,
} from "@/lib/api";

const bodySchema = z.object({
  username: z.string().trim().min(3).max(20),
  password: z.string().min(1).max(200),
  nickname: z.string().trim().min(1).max(40),
  venueSlug: z.string().trim().max(80).optional(),
  checkinCode: z.string().trim().max(32).optional(),
});

/**
 * Self-service account creation.
 *
 * A live venue check-in code proves the player is on site and pins the new
 * account to that venue; the daily per-IP quota limits how many accounts one
 * device can mint.  The password is stored only as a scrypt hash.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    if (!env.registrationEnabled) {
      return jsonError("REGISTRATION_DISABLED", "当前未开放注册，请联系现场管理员", 403);
    }
    const body = bodySchema.parse(await readJsonBody(req));
    const ipHash = hashIp(getClientIp(req));

    const limit = consumeRegistrationLimit(ipHash);
    if (!limit.ok) {
      return jsonError(
        "RATE_LIMITED",
        `请求过于频繁，请 ${limit.retryAfterSec} 秒后再试`,
        429,
      );
    }

    const user = registerAccount({
      username: body.username,
      password: body.password,
      nickname: body.nickname,
      venueSlug: body.venueSlug ?? null,
      checkinCode: body.checkinCode ?? null,
      ipHash,
    });

    await setSession(user.id, ipHash);
    return jsonOk({ user });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonError("INVALID_REQUEST", err.issues[0]?.message || "参数无效");
    }
    return mapServiceError(err);
  }
}
