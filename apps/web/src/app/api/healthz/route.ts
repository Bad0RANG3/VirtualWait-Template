import { getDb } from "@/lib/db";
import { jsonError, jsonOk } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Local/process health endpoint for the service manager and monitoring only.
 * It returns no user, queue, configuration, or error detail.
 */
export function GET() {
  try {
    getDb().prepare("SELECT 1").get();
    return jsonOk({ ok: true });
  } catch {
    return jsonError("HEALTHCHECK_FAILED", "服务暂不可用", 503);
  }
}
