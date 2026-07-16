import { clearSession } from "@/lib/auth/session";
import { assertSameOrigin, jsonOk, mapServiceError } from "@/lib/api";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    await clearSession();
    return jsonOk({ ok: true });
  } catch (err) {
    return mapServiceError(err);
  }
}
