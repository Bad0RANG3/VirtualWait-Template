import type { QueueSlotView } from "@/lib/types";
import { UserPlus } from "lucide-react";

export function DuoDiscoveryList({
  slots, busy, canJoin, openLabel, onJoin,
}: {
  slots: QueueSlotView[];
  busy: string | null;
  canJoin: boolean;
  openLabel: string;
  onJoin: (partyId: string) => void;
}) {
  if (slots.length === 0) return null;
  return (
    <section className="panel overflow-hidden">
      <div className="border-b border-ink-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-900">拼机</h2>
      </div>
      <ul>
        {slots.map((slot) => {
          const host = slot.party?.members.find((m) => m.isHost);
          const key = `join-${slot.party?.id}`;
          return (
            <li key={slot.key} className="list-row">
              <div className="min-w-0">
                <div className="truncate font-medium text-ink-900">
                  {host?.displayName || "发起人"} 的拼机
                </div>
                <div className="mt-0.5 text-sm text-ink-500">
                  {host?.bound
                    ? host.ratingVisible && typeof host.rating === "number"
                      ? `R${host.rating}` : "R 隐藏"
                    : "未绑定"}
                  {host?.title ? ` · ${host.title}` : ""}
                </div>
              </div>
              <button className="btn-mint !py-1.5"
                disabled={busy === key || !canJoin}
                onClick={() => onJoin(slot.party!.id)}>
                <UserPlus className="h-4 w-4" />
                {busy === key ? "加入中…" : canJoin ? "加入" : `开放 ${openLabel}`}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
