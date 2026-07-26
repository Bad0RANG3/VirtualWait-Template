import type { QueueSlotView } from "@/lib/types";
import { statusLabel, statusClass, partyStatusLabel, slotBadge } from "./queue-formatters";

export function QueueSlotList({ slots }: { slots: QueueSlotView[] }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-0.5">
        <h2 className="text-sm font-semibold text-ink-900">队列</h2>
        <span className="text-xs text-ink-400">{slots.length} 组</span>
      </div>
      {slots.length === 0 ? (
        <div className="panel px-4 py-10 text-center text-sm text-ink-400">暂无</div>
      ) : (
        slots.map((slot) => (
          <article key={slot.key} className={`panel p-3 ${slot.isMine ? "border-mint-400" : ""}`}>
            <div className="flex items-start gap-3">
              <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-md text-sm font-semibold ${
                slot.status === "PLAYING" ? "bg-mint-600 text-white" : "bg-ink-950 text-white"}`}>
                {slotBadge(slot)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`chip ${slot.playMode === "DUO" ? "bg-sky-50 text-sky-500" : "bg-ink-50 text-ink-600"}`}>
                    {slot.playMode === "DUO" ? "拼机" : "单刷"}
                  </span>
                  <span className={`chip ${statusClass(slot.status)}`}>{statusLabel(slot.status)}</span>
                  {slot.party && <span className="chip bg-sun-50 text-sun-500">{partyStatusLabel(slot.party.status)}</span>}
                  {slot.isMine && <span className="chip bg-mint-50 text-mint-700">我</span>}
                </div>
                <div className="mt-2 space-y-1.5">
                  {slot.entries.map((entry) => (
                    <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ink-50/80 px-2.5 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink-900">
                          {entry.profile.displayName}{entry.isMine ? "（我）" : ""}
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ink-500">
                          {entry.profile.bound && entry.profile.ratingVisible && typeof entry.profile.rating === "number"
                            ? <span>R{entry.profile.rating}</span>
                            : !entry.profile.bound ? <span className="text-ink-400">未绑定</span>
                            : <span className="text-ink-400">Rating 隐藏</span>}
                          {entry.profile.bound && entry.profile.title && <span>{entry.profile.title}</span>}
                          <span>#{entry.sequenceNumber}</span>
                        </div>
                      </div>
                      <span className={`chip ${statusClass(entry.status)}`}>{statusLabel(entry.status)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
