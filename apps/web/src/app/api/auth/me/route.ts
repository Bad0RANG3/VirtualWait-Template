import { getSessionUser } from "@/lib/auth/session";
import { canonicalNickname, validateNickname } from "@/lib/auth/account";
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
  nickname: z.string().trim().min(1).max(40).optional(),
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
    const db = getDb();
    const nextNickname = canonicalNickname(body.nickname ?? user.nickname);
    const nextQq = body.qq !== undefined ? body.qq : user.qq;

    if (nextNickname !== user.nickname) {
      const nicknameError = validateNickname(nextNickname);
      if (nicknameError) throw new Error(nicknameError);
      const exists = db
        .prepare(`SELECT id FROM app_user WHERE nickname = ? COLLATE NOCASE AND id != ?`)
        .get(nextNickname, user.id) as { id: string } | undefined;
      if (exists) return mapServiceError(new Error("NICKNAME_TAKEN"));
    }

    if (nextQq && nextQq !== user.qq) {
      const taken = db
        .prepare(`SELECT id FROM app_user WHERE qq = ? AND id != ?`)
        .get(nextQq, user.id) as { id: string } | undefined;
      if (taken) return mapServiceError(new Error("QQ_TAKEN"));
    }

    try {
      db.prepare(
        `UPDATE app_user
         SET nickname = ?, qq = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nextNickname, nextQq, nowIso(), user.id);
    } catch (err) {
      // Two concurrent profile updates can both pass the pre-checks above; the
      // UNIQUE index is the final authority and must answer 409, not 500.
      const message = err instanceof Error ? err.message : "";
      if (/UNIQUE constraint failed/i.test(message)) {
        return mapServiceError(
          new Error(/nickname/i.test(message) ? "NICKNAME_TAKEN" : "QQ_TAKEN"),
        );
      }
      throw err;
    }

    const updated = await getSessionUser(req);
    return jsonOk({ user: updated });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonError("INVALID_REQUEST", err.errors[0]?.message || "参数无效");
    }
    return mapServiceError(err);
  }
}
