import { z } from "zod";
import { requireAdmin } from "@/lib/auth/admin";
import { assertSameOrigin, jsonError, jsonOk, mapServiceError, readJsonBody } from "@/lib/api";
import { listMachinesMeta, updateMachineMeta } from "@/lib/settings";

const patchSchema = z.object({
  coinCost: z.number().int().min(1).max(99),
});

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return jsonOk({ machines: listMachinesMeta() });
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ machineId: string }> },
) {
  try {
    assertSameOrigin(req);
    await requireAdmin(req);
    const { machineId } = await ctx.params;
    const body = patchSchema.parse(await readJsonBody(req));
    const machine = updateMachineMeta(machineId, body);
    return jsonOk({ machine });
  } catch (err) {
    if (err instanceof z.ZodError) return jsonError("INVALID_REQUEST", "参数无效");
    return mapServiceError(err);
  }
}
