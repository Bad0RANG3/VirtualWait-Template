"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  minutesToTimeInput,
  parseTimeToMinutes,
} from "@/lib/time/hours";


type Queue = {
  id: string;
  name: string;
  slug: string;
  status: "OPEN" | "PAUSED" | "CLOSED";
  venueName: string;
};
type AuditEvent = {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: unknown;
  createdAt: string;
};
type Entry = {
  id: string;
  queueName: string;
  venueName: string;
  nickname: string;
  status: "WAITING" | "PLAYING";
  version: number;
  isDuo: boolean;
};
type VenueMeta = {
  id: string;
  name: string;
  slug: string;
  address: string;
  regionName: string;
  regionKind: "district" | "county" | "";
  machineCount: number;
  openMinute: number;
  closeMinute: number;
  hoursLabel: string;
  groupUmo: string;
};
type MachineMeta = {
  id: string;
  venueName: string;
  name: string;
  slug: string;
  coinCost: number;
};
type Timeouts = {
  playingTimeoutSec: number;
  headConfirmTimeoutSec: number;
};

export function AdminDashboard({
  queues,
  events,
  entries,
  timeouts,
  venues,
  machines,
}: {
  queues: Queue[];
  events: AuditEvent[];
  entries: Entry[];
  timeouts: Timeouts;
  venues: VenueMeta[];
  machines: MachineMeta[];
}) {
  const router = useRouter();
  const [busyQueue, setBusyQueue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const [playingMin, setPlayingMin] = useState(
    Math.round(timeouts.playingTimeoutSec / 60),
  );
  const [headMin, setHeadMin] = useState(
    Math.round(timeouts.headConfirmTimeoutSec / 60),
  );

  const [venueDrafts, setVenueDrafts] = useState<
    Record<
      string,
      {
        address: string;
        regionName: string;
        regionKind: "district" | "county" | "";
        machineCount: number;
        openTime: string;
        closeTime: string;
        groupUmo: string;
      }
    >
  >(() =>
    Object.fromEntries(
      venues.map((v) => [
        v.id,
        {
          address: v.address,
          regionName: v.regionName,
          regionKind: v.regionKind,
          machineCount: v.machineCount,
          openTime: minutesToTimeInput(v.openMinute),
          closeTime: minutesToTimeInput(v.closeMinute),
          groupUmo: v.groupUmo || "",
        },
      ]),
    ),
  );

  const [machineDrafts, setMachineDrafts] = useState<Record<string, number>>(
    () => Object.fromEntries(machines.map((m) => [m.id, m.coinCost])),
  );

  async function updateStatus(queueId: string, status: Queue["status"]) {
    setBusyQueue(queueId);
    setError(null);
    setOk(null);
    try {
      const response = await fetch(
        `/api/admin/queues/${encodeURIComponent(queueId)}/status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "队列更新失败");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失败");
    } finally {
      setBusyQueue(null);
    }
  }

  async function logout() {
    await fetch("/api/admin/session", { method: "DELETE" });
    router.refresh();
  }

  async function entryAction(
    entry: Entry,
    action: "START" | "REQUEUE" | "CANCEL" | "FINISH",
  ) {
    setBusyQueue(entry.id);
    setError(null);
    setOk(null);
    try {
      const response = await fetch(
        `/api/admin/entries/${encodeURIComponent(entry.id)}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, version: entry.version }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "记录操作失败");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyQueue(null);
    }
  }

  async function saveTimeouts() {
    setBusyQueue("timeouts");
    setError(null);
    setOk(null);
    try {
      const response = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playingTimeoutSec: Math.round(playingMin) * 60,
          headConfirmTimeoutSec: Math.round(headMin) * 60,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "超时设置失败");
      setPlayingMin(Math.round(data.playingTimeoutSec / 60));
      setHeadMin(Math.round(data.headConfirmTimeoutSec / 60));
      setOk("已保存");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusyQueue(null);
    }
  }

  async function saveVenue(venueId: string) {
    const draft = venueDrafts[venueId];
    if (!draft) return;
    const openMinute = parseTimeToMinutes(draft.openTime);
    const closeMinute = parseTimeToMinutes(draft.closeTime);
    if (openMinute == null || closeMinute == null || closeMinute <= openMinute) {
      setError("时间无效");
      return;
    }
    setBusyQueue(venueId);
    setError(null);
    setOk(null);
    try {
      const response = await fetch(
        `/api/admin/venues/${encodeURIComponent(venueId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: draft.address,
            regionName: draft.regionName,
            regionKind: draft.regionKind,
            machineCount: Number(draft.machineCount),
            openMinute,
            closeMinute,
            groupUmo: draft.groupUmo,
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "场地信息保存失败");
      if (data.venue) {
        setVenueDrafts((prev) => ({
          ...prev,
          [venueId]: {
            address: data.venue.address,
            regionName: data.venue.regionName,
            regionKind: data.venue.regionKind,
            machineCount: data.venue.machineCount,
            openTime: minutesToTimeInput(data.venue.openMinute),
            closeTime: minutesToTimeInput(data.venue.closeMinute),
            groupUmo: data.venue.groupUmo || "",
          },
        }));
      }
      setOk(
        `${data.venue?.name || "场地"} · ${data.venue?.hoursLabel || ""}`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusyQueue(null);
    }
  }

  async function saveMachine(machineId: string) {
    const coinCost = machineDrafts[machineId];
    setBusyQueue(machineId);
    setError(null);
    setOk(null);
    try {
      const response = await fetch(
        `/api/admin/machines/${encodeURIComponent(machineId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ coinCost: Number(coinCost) }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "机台硬币保存失败");
      setOk(
        `${data.machine?.venueName || ""} / ${data.machine?.name || "机台"} · ${data.machine?.coinCost} 币`,
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusyQueue(null);
    }
  }

  function patchVenue(
    venueId: string,
    patch: Partial<(typeof venueDrafts)[string]>,
  ) {
    setVenueDrafts((prev) => ({
      ...prev,
      [venueId]: { ...prev[venueId], ...patch },
    }));
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <h1 className="font-display text-2xl font-semibold text-ink-950">
          运维
        </h1>
        <button className="btn-ghost" onClick={logout}>
          退出
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-600">
          {error}
        </div>
      )}
      {ok && (
        <div className="rounded-md border border-mint-200 bg-mint-50 px-3 py-2 text-sm text-mint-700">
          {ok}
        </div>
      )}

      <section className="panel p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-ink-900">超时</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="playing-min">
              游玩
            </label>
            <input
              id="playing-min"
              className="field"
              type="number"
              min={1}
              max={1440}
              value={playingMin}
              onChange={(e) => setPlayingMin(Number(e.target.value))}
            />
          </div>
          <div>
            <label className="label" htmlFor="head-min">
              队头确认
            </label>
            <input
              id="head-min"
              className="field"
              type="number"
              min={1}
              max={60}
              value={headMin}
              onChange={(e) => setHeadMin(Number(e.target.value))}
            />
          </div>
        </div>
        <button
          className="btn-mint mt-3"
          disabled={busyQueue === "timeouts"}
          onClick={saveTimeouts}
        >
          {busyQueue === "timeouts" ? "保存中…" : "保存"}
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink-900">场地</h2>
        {venues.map((venue) => {
          const draft = venueDrafts[venue.id];
          if (!draft) return null;
          return (
            <div key={venue.id} className="panel p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-ink-950">{venue.name}</div>
                </div>
                <button
                  className="btn-mint"
                  disabled={busyQueue === venue.id}
                  onClick={() => saveVenue(venue.id)}
                >
                  {busyQueue === venue.id ? "保存中…" : "保存"}
                </button>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label">区/县</label>
                  <input
                    className="field"
                    value={draft.regionName}
                    onChange={(e) =>
                      patchVenue(venue.id, { regionName: e.target.value })
                    }
                  />
                </div>
                <div>
                  <label className="label">类型</label>
                  <select
                    className="field"
                    value={draft.regionKind}
                    onChange={(e) =>
                      patchVenue(venue.id, {
                        regionKind: e.target.value as
                          | "district"
                          | "county"
                          | "",
                      })
                    }
                  >
                    <option value="">未设置</option>
                    <option value="district">区</option>
                    <option value="county">县</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="label">地址</label>
                  <input
                    className="field"
                    value={draft.address}
                    onChange={(e) =>
                      patchVenue(venue.id, { address: e.target.value })
                    }
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="label">群 UMO</label>
                  <input
                    className="field"
                    value={draft.groupUmo}
                    placeholder="aiocqhttp:GroupMessage:群号"
                    onChange={(e) =>
                      patchVenue(venue.id, { groupUmo: e.target.value })
                    }
                  />
                </div>
                <div>
                  <label className="label">机台数</label>
                  <input
                    className="field"
                    type="number"
                    min={0}
                    max={999}
                    value={draft.machineCount}
                    onChange={(e) =>
                      patchVenue(venue.id, {
                        machineCount: Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div>
                  <label className="label">开始</label>
                  <input
                    className="field"
                    type="time"
                    value={draft.openTime}
                    onChange={(e) =>
                      patchVenue(venue.id, { openTime: e.target.value })
                    }
                  />
                </div>
                <div>
                  <label className="label">结束</label>
                  <input
                    className="field"
                    type="time"
                    value={draft.closeTime}
                    onChange={(e) =>
                      patchVenue(venue.id, { closeTime: e.target.value })
                    }
                  />
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink-900">机台币</h2>
        <div className="panel overflow-hidden">
          <div className="divide-y divide-ink-100">
            {machines.map((machine) => (
              <div
                key={machine.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="font-medium text-ink-900">
                    {machine.venueName} / {machine.name}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    className="field !w-20"
                    type="number"
                    min={1}
                    max={99}
                    value={machineDrafts[machine.id] ?? machine.coinCost}
                    onChange={(e) =>
                      setMachineDrafts((prev) => ({
                        ...prev,
                        [machine.id]: Number(e.target.value),
                      }))
                    }
                  />
                  <span className="text-sm text-ink-500">币</span>
                  <button
                    className="btn-mint"
                    disabled={busyQueue === machine.id}
                    onClick={() => saveMachine(machine.id)}
                  >
                    {busyQueue === machine.id ? "…" : "保存"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        {queues.map((queue) => (
          <div key={queue.id} className="panel p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs text-ink-400">{queue.venueName}</div>
                <h2 className="mt-1 font-display text-lg font-semibold text-ink-950">
                  {queue.name}
                </h2>
              </div>
              <span className="chip bg-ink-50 text-ink-600">{queue.status}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["OPEN", "PAUSED", "CLOSED"] as const).map((status) => (
                <button
                  key={status}
                  className={
                    status === "OPEN"
                      ? "btn-mint"
                      : status === "CLOSED"
                        ? "btn-coral"
                        : "btn-ghost"
                  }
                  disabled={busyQueue === queue.id || queue.status === status}
                  onClick={() => updateStatus(queue.id, status)}
                >
                  {status === "OPEN" ? "开放" : status === "PAUSED" ? "暂停" : "关闭"}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="panel overflow-hidden">
        <div className="border-b border-ink-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-900">排队</h2>
        </div>
        <div className="divide-y divide-ink-100">
          {entries.length === 0 && (
            <p className="px-4 py-5 text-sm text-ink-500">暂无</p>
          )}
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="text-sm">
                <div className="font-medium text-ink-800">
                  {entry.nickname} · {entry.venueName} / {entry.queueName}
                </div>
                <div className="mt-1 text-xs text-ink-500">
                  {entry.status} · 版本 {entry.version}
                  {entry.isDuo ? " · 拼机" : ""}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {entry.status === "WAITING" && (
                  <button
                    className="btn-mint"
                    disabled={busyQueue === entry.id}
                    onClick={() => entryAction(entry, "START")}
                  >
                    开始游玩{entry.isDuo ? "整组" : ""}
                  </button>
                )}
                <button
                  className="btn-ghost"
                  disabled={busyQueue === entry.id}
                  onClick={() => entryAction(entry, "REQUEUE")}
                >
                  调至队尾{entry.isDuo ? "整组" : ""}
                </button>
                {entry.status !== "PLAYING" && (
                  <button
                    className="btn-coral"
                    disabled={busyQueue === entry.id}
                    onClick={() => entryAction(entry, "CANCEL")}
                  >
                    取消{entry.isDuo ? "整组" : ""}
                  </button>
                )}
                {entry.status === "PLAYING" && (
                  <button
                    className="btn-primary"
                    disabled={busyQueue === entry.id}
                    onClick={() => entryAction(entry, "FINISH")}
                  >
                    结束{entry.isDuo ? "整组" : ""}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel overflow-hidden">
        <div className="border-b border-ink-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-900">最近审计事件</h2>
        </div>
        <div className="divide-y divide-ink-100">
          {events.length === 0 && (
            <p className="px-4 py-5 text-sm text-ink-500">暂无事件。</p>
          )}
          {events.map((event) => (
            <div key={event.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2 text-ink-700">
                <span className="font-medium">{event.action}</span>
                <time className="text-ink-400">
                  {new Date(event.createdAt).toLocaleString("zh-CN")}
                </time>
              </div>
              <div className="mt-1 break-all text-xs text-ink-500">
                {event.resourceType} · {event.resourceId} ·{" "}
                {JSON.stringify(event.metadata)}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
