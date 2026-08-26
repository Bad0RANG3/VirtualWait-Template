"use client";

import type { AdminEntryView } from "@/lib/types";

type EntryAction = "START" | "REQUEUE" | "CANCEL" | "FINISH";

export function AdminEntryActions({
  entries,
  busyKey,
  onAction,
}: {
  entries: AdminEntryView[];
  busyKey: string | null;
  onAction: (entry: AdminEntryView, action: EntryAction) => void;
}) {
  return (
    <section className="panel overflow-hidden">
      <div className="border-b border-ink-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-900">排队</h2>
      </div>
      <div className="divide-y divide-ink-100">
        {entries.length === 0 && (
          <p className="px-4 py-5 text-sm text-ink-500">暂无</p>
        )}
        {entries.map((e) => (
          <div key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="text-sm">
              <div className="font-medium text-ink-800">
                {e.nickname} · {e.venueName} / {e.queueName}
              </div>
              <div className="mt-1 text-xs text-ink-500">
                {e.status} · 版本 {e.version}{e.isDuo ? " · 拼机" : ""}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {e.status === "WAITING" && (
                <button className="btn-mint" disabled={busyKey === e.id}
                  onClick={() => onAction(e, "START")}>
                  开始游玩{e.isDuo ? "整组" : ""}
                </button>
              )}
              <button className="btn-ghost" disabled={busyKey === e.id}
                onClick={() => onAction(e, "REQUEUE")}>
                调至队尾{e.isDuo ? "整组" : ""}
              </button>
              {e.status !== "PLAYING" && (
                <button className="btn-coral" disabled={busyKey === e.id}
                  onClick={() => onAction(e, "CANCEL")}>
                  取消{e.isDuo ? "整组" : ""}
                </button>
              )}
              {e.status === "PLAYING" && (
                <button className="btn-primary" disabled={busyKey === e.id}
                  onClick={() => onAction(e, "FINISH")}>
                  结束并继续排队{e.isDuo ? "整组" : ""}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
