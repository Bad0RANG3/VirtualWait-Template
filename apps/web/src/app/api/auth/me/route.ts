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

const qqSchema = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .refine((value) => value === null || /^\d{5,12}$/.test(value), {
    message: "QQ 号格式无效，请填写 5-12 位数字或留空",
  });

const updateSchema = z.object({
  nickname: z
    .string()
    .trim()
    .min(2, "用户名至少 2 个字符")
    .max(20, "用户名最多 20 个字符")
    // 允许中日韩、字母数字、标点、符号、emoji 等可见字符；拒绝控制/格式字符
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
      message: "用户名不能包含控制或不可见格式字符",
    })
    .refine((value) => value.replace(/\s+/g, "").length >= 1, {
      message: "用户名不能全是空白",
    })
    .optional(),
  showRatingPublic: z.boolean().optional(),
  qq: qqSchema.optional(),
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
    const nextQq = body.qq !== undefined ? body.qq : user.qq;
    const db = getDb();

    if (nextNickname !== user.nickname) {
      const exists = db
        .prepare(`SELECT id FROM app_user WHERE nickname = ? AND id != ?`)
        .get(nextNickname, user.id) as { id: string } | undefined;
      if (exists) return mapServiceError(new Error("NICKNAME_TAKEN"));
    }

    if (nextQq && nextQq !== user.qq) {
      const taken = db
        .prepare(`SELECT id FROM app_user WHERE qq = ? AND id != ?`)
        .get(nextQq, user.id) as { id: string } | undefined;
      if (taken) return mapServiceError(new Error("QQ_TAKEN"));
    }

    db.prepare(
      `UPDATE app_user
       SET nickname = ?,
           show_rating_public = ?,
           qq = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(nextNickname, nextShowRating ? 1 : 0, nextQq, nowIso(), user.id);

    const updated = await getSessionUser(req);
    return jsonOk({ user: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonError("INVALID_REQUEST", err.errors[0]?.message || "参数无效");
    }
    return mapServiceError(err);
  }
}
