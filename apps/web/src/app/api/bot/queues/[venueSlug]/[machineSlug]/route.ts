import { requireBot } from "@/lib/auth/bot";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { jsonError, jsonOk, mapServiceError } from "@/lib/api";
import { env } from "@/lib/env";
import { getBotQueueDetail } from "@/lib/queue/bot";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ venueSlug: string; machineSlug: string }> },
) {
  try {
    requireBot(req);
    const limited = consumeRateLimit({
      key: "bot:queue",
      limit: env.botQueueRateLimit,
      windowSec: 60,
    });
    if (!limited.ok) {
      return jsonError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429, {
        retryAfterSec: limited.retryAfterSec,
      });
    }
    const { venueSlug, machineSlug } = await ctx.params;
    const detail = getBotQueueDetail(venueSlug, machineSlug);
    if (!detail) return mapServiceError(new Error("QUEUE_NOT_FOUND"));
    return jsonOk(detail);
  } catch (err) {
    return mapServiceError(err);
  }
}
