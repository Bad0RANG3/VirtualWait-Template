/**
 * 客户端 IP 提取（受 TRUST_PROXY_HEADERS 控制取代理头，XFF 取最右侧可信条目）与 HMAC 匿名哈希。
 */
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
    // 取最右侧（离代理最近）的可信条目：追加式代理会把真实客户端地址追加在
    // 末尾，客户端只能伪造左侧条目。官方 nginx 模板用 $remote_addr 覆盖，
    // 此时仅有一个值，最右 == 唯一值，同样正确。
    const entries = xff.split(",").map((entry) => entry.trim()).filter(Boolean);
    const last = entries[entries.length - 1];
    if (last && isIP(last)) return last;
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
