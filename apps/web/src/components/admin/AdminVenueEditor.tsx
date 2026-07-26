"use client";

import { minutesToTimeInput } from "@/lib/time/hours";
import type { VenueMeta } from "@/lib/settings/venue-meta";

export type VenueDraft = {
  address: string;
  regionName: string;
  regionKind: "district" | "county" | "";
  machineCount: number;
  openTime: string;
  closeTime: string;
  groupUmo: string;
};

export function makeVenueDrafts(venues: VenueMeta[]): Record<string, VenueDraft> {
  return Object.fromEntries(
    venues.map((v) => [v.id, {
      address: v.address,
      regionName: v.regionName,
      regionKind: v.regionKind,
      machineCount: v.machineCount,
      openTime: minutesToTimeInput(v.openMinute),
      closeTime: minutesToTimeInput(v.closeMinute),
      groupUmo: v.groupUmo || "",
    }]),
  );
}

export function AdminVenueEditor({
  venues,
  drafts,
  busyKey,
  onPatch,
  onSave,
}: {
  venues: VenueMeta[];
  drafts: Record<string, VenueDraft>;
  busyKey: string | null;
  onPatch: (id: string, p: Partial<VenueDraft>) => void;
  onSave: (id: string) => void;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-ink-900">场地</h2>
      {venues.map((venue) => {
        const draft = drafts[venue.id];
        if (!draft) return null;
        return (
          <div key={venue.id} className="panel p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium text-ink-950">{venue.name}</div>
              <button className="btn-mint" disabled={busyKey === venue.id}
                onClick={() => onSave(venue.id)}>
                {busyKey === venue.id ? "保存中…" : "保存"}
              </button>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">区/县</label>
                <input className="field" value={draft.regionName}
                  onChange={(e) => onPatch(venue.id, { regionName: e.target.value })} />
              </div>
              <div>
                <label className="label">类型</label>
                <select className="field" value={draft.regionKind}
                  onChange={(e) => onPatch(venue.id, { regionKind: e.target.value as "district" | "county" | "" })}>
                  <option value="">未设置</option>
                  <option value="district">区</option>
                  <option value="county">县</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="label">地址</label>
                <input className="field" value={draft.address}
                  onChange={(e) => onPatch(venue.id, { address: e.target.value })} />
              </div>
              <div className="sm:col-span-2">
                <label className="label">群 UMO</label>
                <input className="field" value={draft.groupUmo} placeholder="aiocqhttp:GroupMessage:群号"
                  onChange={(e) => onPatch(venue.id, { groupUmo: e.target.value })} />
              </div>
              <div>
                <label className="label">机台数</label>
                <input className="field" type="number" min={0} max={999} value={draft.machineCount}
                  onChange={(e) => onPatch(venue.id, { machineCount: Number(e.target.value) })} />
              </div>
              <div>
                <label className="label">开始</label>
                <input className="field" type="time" value={draft.openTime}
                  onChange={(e) => onPatch(venue.id, { openTime: e.target.value })} />
              </div>
              <div>
                <label className="label">结束</label>
                <input className="field" type="time" value={draft.closeTime}
                  onChange={(e) => onPatch(venue.id, { closeTime: e.target.value })} />
              </div>
            </div>
          </div>
        );
      })}
    </section>
  );
}
