import { z } from "zod";
import { requireAdmin } from "@/lib/auth/admin";
import { adminEntryAction } from "@/lib/queue/service";
import { assertSameOrigin, jsonError, jsonOk, mapServiceError, readJsonBody } from "@/lib/api";

const bodySchema = z.object({
  version: z.number().int().positive(),
  action: z.enum(["START", "REQUEUE", "CANCEL", "FINISH"]),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ entryId: string }> }
) {
  try {
    assertSameOrigin(req);
    const adminId = await requireAdmin(req);
    const body = bodySchema.parse(await readJsonBody(req));
    const { entryId } = await ctx.params;
    adminEntryAction(entryId, body.version, body.action, adminId);
    return jsonOk({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) return jsonError("INVALID_REQUEST", "参数无效");
    return mapServiceError(err);
  }
}
