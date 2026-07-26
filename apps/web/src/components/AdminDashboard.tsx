"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { minutesToTimeInput, parseTimeToMinutes } from "@/lib/time/hours";
import type { AdminAuditEvent, AdminEntryView, AdminQueueView, AdminTimeouts } from "@/lib/types";
import type { MachineMeta, VenueMeta } from "@/lib/settings/venue-meta";

import { AdminTimeoutSettings } from "./admin/AdminTimeoutSettings";
import { AdminVenueEditor, makeVenueDrafts, type VenueDraft } from "./admin/AdminVenueEditor";
import { AdminMachineCoinEditor } from "./admin/AdminMachineCoinEditor";
import { AdminQueueControls } from "./admin/AdminQueueControls";
import { AdminEntryActions } from "./admin/AdminEntryActions";
import { AdminAuditLog } from "./admin/AdminAuditLog";

export function AdminDashboard({
  queues, events, entries, timeouts, venues, machines,
}: {
  queues: AdminQueueView[];
  events: AdminAuditEvent[];
  entries: AdminEntryView[];
  timeouts: AdminTimeouts;
  venues: VenueMeta[];
  machines: MachineMeta[];
}) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [playingMin, setPlayingMin] = useState(Math.round(timeouts.playingTimeoutSec / 60));
  const [headMin, setHeadMin] = useState(Math.round(timeouts.headConfirmTimeoutSec / 60));

  const [venueDrafts, setVenueDrafts] = useState<Record<string, VenueDraft>>(() => makeVenueDrafts(venues));
  const [machineDrafts, setMachineDrafts] = useState<Record<string, number>>(
    () => Object.fromEntries(machines.map((m) => [m.id, m.coinCost])),
  );

  // ---- mutations ----

  async function mutate(key: string, fn: () => Promise<Response>, okMsg?: string) {
    setBusyKey(key);
    setError(null);
    setOk(null);
    try {
      const res = await fn();
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || "操作失败");
      if (okMsg) setOk(okMsg);
      router.refresh();
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyKey(null);
    }
  }

  const updateStatus = (queueId: string, status: AdminQueueView["status"]) =>
    mutate(queueId, () => fetch(`/api/admin/queues/${encodeURIComponent(queueId)}/status`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }));

  const entryAction = (entry: AdminEntryView, action: string) =>
    mutate(entry.id, () => fetch(`/api/admin/entries/${encodeURIComponent(entry.id)}/action`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: entry.version }),
    }));

  const saveTimeouts = () =>
    mutate("timeouts", () => fetch("/api/admin/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playingTimeoutSec: Math.round(playingMin) * 60, headConfirmTimeoutSec: Math.round(headMin) * 60 }),
    })).then((d) => {
      if (d) { setPlayingMin(Math.round(d.playingTimeoutSec / 60)); setHeadMin(Math.round(d.headConfirmTimeoutSec / 60)); }
    });

  const saveVenue = (venueId: string) => {
    const d = venueDrafts[venueId];
    if (!d) return;
    const openMinute = parseTimeToMinutes(d.openTime);
    const closeMinute = parseTimeToMinutes(d.closeTime);
    if (openMinute == null || closeMinute == null || closeMinute <= openMinute) {
      setError("时间无效"); return;
    }
    mutate(venueId, () => fetch(`/api/admin/venues/${encodeURIComponent(venueId)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: d.address, regionName: d.regionName, regionKind: d.regionKind,
        machineCount: Number(d.machineCount), openMinute, closeMinute, groupUmo: d.groupUmo }),
    })).then((data) => {
      if (data?.venue) {
        setVenueDrafts((prev) => ({ ...prev, [venueId]: {
          address: data.venue.address, regionName: data.venue.regionName,
          regionKind: data.venue.regionKind, machineCount: data.venue.machineCount,
          openTime: minutesToTimeInput(data.venue.openMinute),
          closeTime: minutesToTimeInput(data.venue.closeMinute),
          groupUmo: data.venue.groupUmo || "",
        }}));
        setOk(`${data.venue.name || "场地"} · ${data.venue.hoursLabel || ""}`);
      }
    });
  };

  const saveMachine = (machineId: string) =>
    mutate(machineId, () => fetch(`/api/admin/machines/${encodeURIComponent(machineId)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coinCost: Number(machineDrafts[machineId]) }),
    })).then((data) => {
      if (data?.machine) setOk(`${data.machine.venueName || ""} / ${data.machine.name || "机台"} · ${data.machine.coinCost} 币`);
    });

  // ---- render ----

  return (
    <div className="space-y-5">
      <Header onLogout={async () => { await fetch("/api/admin/session", { method: "DELETE" }); router.refresh(); }} />
      <StatusBanner error={error} ok={ok} />

      <AdminTimeoutSettings playingMin={playingMin} headMin={headMin} busy={busyKey === "timeouts"}
        onPlayingMin={setPlayingMin} onHeadMin={setHeadMin} onSave={saveTimeouts} />

      <AdminVenueEditor venues={venues} drafts={venueDrafts} busyKey={busyKey}
        onPatch={(id, p) => setVenueDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }))}
        onSave={saveVenue} />

      <AdminMachineCoinEditor machines={machines} drafts={machineDrafts} busyKey={busyKey}
        onDraft={(id, v) => setMachineDrafts((prev) => ({ ...prev, [id]: v }))}
        onSave={saveMachine} />

      <AdminQueueControls queues={queues} busyKey={busyKey} onStatus={updateStatus} />
      <AdminEntryActions entries={entries} busyKey={busyKey} onAction={entryAction} />
      <AdminAuditLog events={events} />
    </div>
  );
}

function Header({ onLogout }: { onLogout: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <h1 className="font-display text-2xl font-semibold text-ink-950">运维</h1>
      <button className="btn-ghost" onClick={onLogout}>退出</button>
    </div>
  );
}

function StatusBanner({ error, ok }: { error: string | null; ok: string | null }) {
  return <>
    {error && <div className="rounded-md border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-600">{error}</div>}
    {ok && <div className="rounded-md border border-mint-200 bg-mint-50 px-3 py-2 text-sm text-mint-700">{ok}</div>}
  </>;
}
