import { getSessionUser } from "@/lib/auth/session";
import { getDb, nowIso } from "@/lib/db";
import {
  assertSameOrigin,
  jsonError,
  jsonOk,
  mapServiceError,
  readJsonBody,
} from "@/lib/api";
import { z } from "zod";

const updateSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(2, "用户名至少 2 个字符")
    .max(20, "用户名最多 20 个字符")
    .regex(/^[\w\u4e00-\u9fa5-]+$/u, "用户名仅支持中英文、数字、下划线和短横线")
    .optional(),
  showRatingPublic: z.boolean().optional(),
});

export async function GET(req: Request) {
  const user = await getSessionUser(req);
  return jsonOk({ user });
}

export async function PATCH(req: Request) {
  try {
    assertSameOrigin(req);
    const user = await getSessionUser(req);
    if (!user) return mapServiceError(new Error("NOT_AUTHENTICATED"));

    const body = updateSchema.parse(await readJsonBody(req));
    const nextNickname = body.nickname ?? user.nickname;
    const nextShowRating = body.showRatingPublic ?? user.showRatingPublic;
    const db = getDb();

    if (nextNickname !== user.nickname) {
      const exists = db
        .prepare(`SELECT id FROM app_user WHERE nickname = ? AND id != ?`)
        .get(nextNickname, user.id) as { id: string } | undefined;
      if (exists) return mapServiceError(new Error("NICKNAME_TAKEN"));
    }

    db.prepare(
      `UPDATE app_user
       SET nickname = ?,
           show_rating_public = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(nextNickname, nextShowRating ? 1 : 0, nowIso(), user.id);

    const updated = await getSessionUser(req);
    return jsonOk({ user: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonError("INVALID_REQUEST", err.errors[0]?.message || "参数无效");
    }
    return mapServiceError(err);
  }
}
