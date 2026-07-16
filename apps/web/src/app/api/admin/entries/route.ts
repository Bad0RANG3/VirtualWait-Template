import { requireAdmin } from "@/lib/auth/admin";
import { listAdminActiveEntries } from "@/lib/queue/service";
import { jsonOk, mapServiceError } from "@/lib/api";

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const entries = listAdminActiveEntries().map((entry) => ({
      id: entry.id,
      queueName: entry.queue_name,
      nickname: entry.nickname,
      status: entry.status,
      version: entry.version,
      isDuo: entry.play_mode === "DUO" || Boolean(entry.party_id),
    }));
    return jsonOk({ entries });
  } catch (err) {
    return mapServiceError(err);
  }
}
