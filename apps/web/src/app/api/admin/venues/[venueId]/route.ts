import { z } from "zod";
import { requireAdmin } from "@/lib/auth/admin";
import { assertSameOrigin, jsonError, jsonOk, mapServiceError, readJsonBody } from "@/lib/api";
import { listVenueMeta, updateVenueMeta } from "@/lib/settings";

const patchSchema = z.object({
  address: z.string().max(200),
  regionName: z.string().max(40),
  regionKind: z.union([z.literal("district"), z.literal("county"), z.literal("")]),
  machineCount: z.number().int().min(0).max(999),
  openMinute: z.number().int().min(0).max(23 * 60 + 59),
  closeMinute: z.number().int().min(1).max(24 * 60),
  groupUmo: z.string().max(200).optional(),
});

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return jsonOk({ venues: listVenueMeta() });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ venueId: string }> },
) {
  try {
    assertSameOrigin(req);
    await requireAdmin(req);
    const { venueId } = await ctx.params;
    const body = patchSchema.parse(await readJsonBody(req));
    const venue = updateVenueMeta(venueId, body);
    return jsonOk({ venue });
  } catch (err) {
    if (err instanceof z.ZodError) return jsonError("INVALID_REQUEST", "参数无效");
    return mapServiceError(err);
  }
}
