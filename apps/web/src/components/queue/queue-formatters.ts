/** Pure presentation helpers for QueueBoard — no React / hooks. */

export function statusLabel(status: string) {
  switch (status) {
    case "PLAYING": return "游玩中";
    case "WAITING": return "等待中";
    default: return status;
  }
}

export function statusClass(status: string) {
  return status === "PLAYING" ? "bg-mint-50 text-mint-700" : "bg-ink-50 text-ink-600";
}

export function partyStatusLabel(status: string) {
  switch (status) {
    case "SEEKING": return "招募拼机";
    case "PENDING": return "待双方确认";
    case "CONFIRMED": return "拼机已确认";
    default: return status;
  }
}

export function formatRemain(expiresAt: string, nowMs: number) {
  if (!nowMs) return "--";
  const ms = new Date(expiresAt).getTime() - nowMs;
  if (ms <= 0) return "结算中";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}

export function slotBadge(slot: { status: string; position: number | null }) {
  return slot.status === "PLAYING" ? "P" : (slot.position ?? "·");
}
