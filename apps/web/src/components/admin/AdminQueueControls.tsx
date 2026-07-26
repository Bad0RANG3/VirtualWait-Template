"use client";

import type { AdminQueueView } from "@/lib/types";

const STATUSES = ["OPEN", "PAUSED", "CLOSED"] as const;

export function AdminQueueControls({
  queues,
  busyKey,
  onStatus,
}: {
  queues: AdminQueueView[];
  busyKey: string | null;
  onStatus: (queueId: string, status: AdminQueueView["status"]) => void;
}) {
  return (
    <section className="grid gap-3 md:grid-cols-2">
      {queues.map((q) => (
        <div key={q.id} className="panel p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-ink-400">{q.venueName}</div>
              <h2 className="mt-1 font-display text-lg font-semibold text-ink-950">{q.name}</h2>
            </div>
            <span className="chip bg-ink-50 text-ink-600">{q.status}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <button
                key={s}
                className={s === "OPEN" ? "btn-mint" : s === "CLOSED" ? "btn-coral" : "btn-ghost"}
                disabled={busyKey === q.id || q.status === s}
                onClick={() => onStatus(q.id, s)}
              >
                {s === "OPEN" ? "开放" : s === "PAUSED" ? "暂停" : "关闭"}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
