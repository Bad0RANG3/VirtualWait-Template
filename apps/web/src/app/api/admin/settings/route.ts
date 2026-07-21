import { z } from "zod";
import { requireAdmin } from "@/lib/auth/admin";
import { assertSameOrigin, jsonError, jsonOk, mapServiceError, readJsonBody } from "@/lib/api";
import { getQueueTimeouts, setQueueTimeouts } from "@/lib/settings";

const patchSchema = z.object({
  playingTimeoutSec: z.number().int().min(60).max(86_400),
  headConfirmTimeoutSec: z.number().int().min(30).max(3_600),
});

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return jsonOk(getQueueTimeouts());
  } catch (err) {
    return mapServiceError(err);
  }
}

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    await requireAdmin(req);
    const body = patchSchema.parse(await readJsonBody(req));
    const next = setQueueTimeouts(body);
    return jsonOk(next);
  } catch (err) {
    if (err instanceof z.ZodError) return jsonError("INVALID_REQUEST", "参数无效");
    return mapServiceError(err);
  }
}
