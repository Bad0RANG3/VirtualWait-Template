import { z } from "zod";
import { safeEqual } from "@/lib/crypto";
import { env } from "@/lib/env";
import { clearAdminSession, setAdminSession } from "@/lib/auth/admin";
import { assertSameOrigin, jsonError, jsonOk, mapServiceError, readJsonBody } from "@/lib/api";

const loginSchema = z.object({ token: z.string().min(1).max(512) });

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    if (!env.adminApiToken) throw new Error("ADMIN_DISABLED");
    const { token } = loginSchema.parse(await readJsonBody(req));
    if (!safeEqual(token, env.adminApiToken)) throw new Error("ADMIN_UNAUTHORIZED");
    await setAdminSession();
    return jsonOk({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) return jsonError("INVALID_REQUEST", "参数无效");
    return mapServiceError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    assertSameOrigin(req);
    await clearAdminSession();
    return jsonOk({ ok: true });
  } catch (err) {
    return mapServiceError(err);
  }
}
