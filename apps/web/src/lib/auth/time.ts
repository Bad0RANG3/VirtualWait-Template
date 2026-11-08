/**
 * Asia/Shanghai is fixed UTC+8 (no DST).
 *
 * Only the calendar-day key is needed today: the per-IP registration quota and
 * `last_login_day` are both scoped to a Shanghai day.
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Calendar day key YYYY-MM-DD in Asia/Shanghai. */
export function shanghaiDayKey(nowMs = Date.now()): string {
  const shifted = new Date(nowMs + SHANGHAI_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

