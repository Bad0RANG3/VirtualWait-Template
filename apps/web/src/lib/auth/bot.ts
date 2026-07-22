import { env } from "../env";
import { safeEqual } from "../crypto";

function botToken(): string {
  // Prefer module env; fall back to process for tests that set BOT_API_TOKEN after import.
  return env.botApiToken || process.env.BOT_API_TOKEN || "";
}

/** Require BOT_API_TOKEN bearer for machine-to-machine bot routes. */
export function requireBot(req: Request): void {
  const expected = botToken();
  if (!expected) throw new Error("BOT_DISABLED");
  const authorization = req.headers.get("authorization") || "";
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) throw new Error("BOT_UNAUTHORIZED");
  const token = authorization.slice(prefix.length);
  if (!token || !safeEqual(token, expected)) {
    throw new Error("BOT_UNAUTHORIZED");
  }
}
