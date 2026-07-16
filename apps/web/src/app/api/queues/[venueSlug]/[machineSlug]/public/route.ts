import { getSessionUser } from "@/lib/auth/session";
import { getPublicQueue } from "@/lib/queue/service";
import { jsonError, jsonOk } from "@/lib/api";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ venueSlug: string; machineSlug: string }> }
) {
  const { venueSlug, machineSlug } = await ctx.params;
  const user = await getSessionUser(req);
  const snapshot = getPublicQueue(venueSlug, machineSlug, user?.id);
  if (!snapshot) return jsonError("QUEUE_NOT_FOUND", "队列不存在", 404);
  return jsonOk(snapshot);
}
