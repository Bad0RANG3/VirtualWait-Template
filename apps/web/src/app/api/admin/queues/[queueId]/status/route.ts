import { z } from "zod";
import { requireAdmin } from "@/lib/auth/admin";
import { setQueueStatus } from "@/lib/queue/service";
import { assertSameOrigin, jsonError, jsonOk, mapServiceError, readJsonBody } from "@/lib/api";

const schema = z.object({ status: z.enum(["OPEN", "PAUSED", "CLOSED"]) });

export async function POST(
  req: Request,
  ctx: { params: Promise<{ queueId: string }> }
) {
  try {
    assertSameOrigin(req);
    const adminId = await requireAdmin(req);
    const { status } = schema.parse(await readJsonBody(req));
    const { queueId } = await ctx.params;
    setQueueStatus(queueId, status, adminId);
    return jsonOk({ queueId, status });
  } catch (err) {
    if (err instanceof z.ZodError) return jsonError("INVALID_REQUEST", "参数无效");
    return mapServiceError(err);
  }
}
