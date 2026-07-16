import { z } from "zod";
import { requireAdmin } from "@/lib/auth/admin";
import { listAuditEvents } from "@/lib/queue/service";
import { jsonError, jsonOk, mapServiceError } from "@/lib/api";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const { limit } = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    const events = listAuditEvents(limit).map((event) => ({
      ...event,
      metadata: JSON.parse(event.metadata) as unknown,
    }));
    return jsonOk({ events });
  } catch (err) {
    if (err instanceof z.ZodError) return jsonError("INVALID_REQUEST", "参数无效");
    return mapServiceError(err);
  }
}
