import { getSessionUser } from "@/lib/auth/session";
import { finishPlay } from "@/lib/queue/service";
import { assertSameOrigin, jsonOk, mapServiceError } from "@/lib/api";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ entryId: string }> }
) {
  try {
    assertSameOrigin(req);
    const user = await getSessionUser(req);
    if (!user) return mapServiceError(new Error("NOT_AUTHENTICATED"));
    const { entryId } = await ctx.params;
    finishPlay(entryId, user.id);
    return jsonOk({ ok: true });
  } catch (err) {
    return mapServiceError(err);
  }
}
