import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { joinQueue } from "@/lib/queue/service";
import {
  assertSameOrigin,
  jsonError,
  jsonOk,
  mapServiceError,
  readJsonBody,
} from "@/lib/api";

const schema = z.object({
  playMode: z.enum(["SOLO", "DUO"]).default("SOLO"),
  partyId: z.string().uuid().optional().nullable(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ venueSlug: string; machineSlug: string }> }
) {
  try {
    assertSameOrigin(req);
    const user = await getSessionUser(req);
    if (!user) return mapServiceError(new Error("NOT_AUTHENTICATED"));
    // 舞萌绑定改为可选，不再拦截排卡

    const body = schema.parse(await readJsonBody(req, { emptyBody: {} }));
    const { venueSlug, machineSlug } = await ctx.params;
    const queue = getDb()
      .prepare(
        `SELECT q.id FROM queue q
         JOIN venue v ON v.id = q.venue_id
         WHERE v.slug = ? AND q.slug = ?`
      )
      .get(venueSlug, machineSlug) as { id: string } | undefined;
    if (!queue) return mapServiceError(new Error("QUEUE_NOT_FOUND"));

    const result = joinQueue(
      queue.id,
      user.id,
      body.playMode,
      body.partyId || null
    );
    return jsonOk(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return jsonError("INVALID_REQUEST", err.errors[0]?.message || "参数无效");
    }
    return mapServiceError(err);
  }
}
