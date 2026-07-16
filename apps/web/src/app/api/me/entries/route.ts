import { getSessionUser } from "@/lib/auth/session";
import { getUserActiveEntries } from "@/lib/queue/service";
import { jsonOk, mapServiceError } from "@/lib/api";

export async function GET(req: Request) {
  try {
    const user = await getSessionUser(req);
    if (!user) return mapServiceError(new Error("NOT_AUTHENTICATED"));
    const entries = getUserActiveEntries(user.id);
    return jsonOk({ entries });
  } catch (err) {
    return mapServiceError(err);
  }
}
