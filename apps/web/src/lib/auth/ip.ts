import { isIP } from "node:net";
import { env } from "../env";
import { hmacHex } from "../crypto";

type HeaderReader = Pick<Headers, "get">;

export function clientIpFromHeaders(
  headers: HeaderReader,
  trustProxyHeaders: boolean,
): string {
  // These headers are client-controlled unless the deployment proxy removes and
  // rewrites them. Production requires that trust to be explicitly enabled.
  if (!trustProxyHeaders) return "unknown";

  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && isIP(first)) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  if (real && isIP(real)) return real;
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf && isIP(cf)) return cf;
  return "unknown";
}

/** Best-effort client IP from common proxy headers. */
export function getClientIp(req: Request): string {
  return clientIpFromHeaders(req.headers, env.trustProxyHeaders);
}

/** Keyed hash so a leaked database cannot cheaply reverse client IPs. */
export function hashIp(ip: string): string {
  return hmacHex(env.sessionSecret, `vw-ip:${ip}`);
}
