import { requireAdmin } from "@/lib/auth/admin";
import { jsonOk, mapServiceError } from "@/lib/api";
import { listVenueMeta } from "@/lib/settings";

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return jsonOk({ venues: listVenueMeta() });
  } catch (err) {
    return mapServiceError(err);
  }
}
