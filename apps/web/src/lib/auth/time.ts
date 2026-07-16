/** Asia/Shanghai is fixed UTC+8 (no DST). */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar day key YYYY-MM-DD in Asia/Shanghai. */
export function shanghaiDayKey(nowMs = Date.now()): string {
  const shifted = new Date(nowMs + SHANGHAI_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Next local midnight (00:00) Asia/Shanghai, as UTC epoch ms. */
export function nextShanghaiMidnightMs(nowMs = Date.now()): number {
  const shanghaiNow = nowMs + SHANGHAI_OFFSET_MS;
  const dayIndex = Math.floor(shanghaiNow / DAY_MS);
  return (dayIndex + 1) * DAY_MS - SHANGHAI_OFFSET_MS;
}

/** Seconds remaining until next Shanghai midnight (min 1). */
export function secondsUntilShanghaiMidnight(nowMs = Date.now()): number {
  return Math.max(1, Math.floor((nextShanghaiMidnightMs(nowMs) - nowMs) / 1000));
}
