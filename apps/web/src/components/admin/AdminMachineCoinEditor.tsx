"use client";

import type { MachineMeta } from "@/lib/settings/venue-meta";

export function AdminMachineCoinEditor({
  machines,
  drafts,
  busyKey,
  onDraft,
  onSave,
}: {
  machines: MachineMeta[];
  drafts: Record<string, number>;
  busyKey: string | null;
  onDraft: (id: string, v: number) => void;
  onSave: (id: string) => void;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-ink-900">机台币</h2>
      <div className="panel overflow-hidden">
        <div className="divide-y divide-ink-100">
          {machines.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="font-medium text-ink-900">{m.venueName} / {m.name}</div>
              </div>
              <div className="flex items-center gap-2">
                <input className="field !w-20" type="number" min={1} max={99}
                  value={drafts[m.id] ?? m.coinCost}
                  onChange={(e) => onDraft(m.id, Number(e.target.value))} />
                <span className="text-sm text-ink-500">币</span>
                <button className="btn-mint" disabled={busyKey === m.id}
                  onClick={() => onSave(m.id)}>
                  {busyKey === m.id ? "…" : "保存"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
