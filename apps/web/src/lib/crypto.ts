/**
 * 通用密码学原语：HMAC 匿名哈希、随机令牌、常量时间比较、载荷签名。
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { env } from "./env";

export function hmacHex(secret: string, input: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function signPayload(payload: string, secret = env.sessionSecret): string {
  return hmacHex(secret, payload);
}
