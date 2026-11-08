/**
 * 签到码的纯数据形状与时间计算。
 *
 * 这个文件**不导入任何服务端模块**（数据库、node:crypto 等），因此客户端组件
 * 也可以安全引用它。服务端实现（派生、校验、轮换）在 `checkin.ts`。
 */

export type VenueCheckinCode = {
  venueId: string;
  venueSlug: string;
  venueName: string;
  code: string;
  windowSec: number;
  windowStartedAt: string;
  expiresAt: string;
  rotatedAt: string | null;
};

/** Seconds until the current code changes; used for the admin countdown. */
export function checkinSecondsRemaining(
  code: { expiresAt: string },
  nowMs = Date.now(),
): number {
  const expiresMs = Date.parse(code.expiresAt);
  if (!Number.isFinite(expiresMs)) return 0;
  return Math.max(0, Math.ceil((expiresMs - nowMs) / 1000));
}

/** `m:ss` label for a countdown that is still running. */
export function formatCheckinCountdown(left: number): string {
  const minutes = Math.floor(left / 60);
  const seconds = left % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
