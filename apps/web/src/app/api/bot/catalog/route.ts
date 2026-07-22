import { requireBot } from "@/lib/auth/bot";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { jsonError, jsonOk, mapServiceError } from "@/lib/api";
import { env } from "@/lib/env";
import { getBotCatalog } from "@/lib/queue/bot";

export async function GET(req: Request) {
  try {
    requireBot(req);
    const limited = consumeRateLimit({
      key: "bot:catalog",
      limit: env.botCatalogRateLimit,
      windowSec: 60,
    });
    if (!limited.ok) {
      return jsonError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429, {
        retryAfterSec: limited.retryAfterSec,
      });
    }
    return jsonOk(getBotCatalog());
  } catch (err) {
    return mapServiceError(err);
  }
}
