"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MachineAccent } from "@/lib/constants/catalog";
import type { PublicQueueSnapshot, SessionUser } from "@/lib/types";
import { coerceVenueHours, isWithinHours } from "@/lib/time/hours";
import { Gamepad2, LogOut, UserPlus } from "lucide-react";

import { statusLabel, statusClass, partyStatusLabel, formatRemain } from "./queue/queue-formatters";
import { QueueStatusHeader } from "./queue/QueueStatusHeader";
import { DuoDiscoveryList } from "./queue/DuoDiscoveryList";
import { QueueSlotList } from "./queue/QueueSlotList";

export function QueueBoard({
  venueSlug, machineSlug, machineName, accent, initial, user,
}: {
  venueSlug: string; machineSlug: string; machineName: string;
  accent: MachineAccent; initial: PublicQueueSnapshot; user: SessionUser | null;
}) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [joinMode, setJoinMode] = useState<"SOLO" | "DUO">("SOLO");

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/queues/${venueSlug}/${machineSlug}/public`, { cache: "no-store" });
    if (!res.ok) return;
    setData(await res.json() as PublicQueueSnapshot);
  }, [venueSlug, machineSlug]);

  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3500);
    const clock = setInterval(() => setNowMs(Date.now()), 1000);
    return () => { clearInterval(t); clearInterval(clock); };
  }, [refresh]);

  const myEntry = useMemo(() => data.entries.find((e) => e.isMine) || null, [data.entries]);
  const mySlot = useMemo(() => data.slots.find((s) => s.isMine) || null, [data.slots]);
  const seekingDuos = useMemo(() =>
    data.slots.filter((s) => s.playMode === "DUO" && s.party?.status === "SEEKING" && !s.isMine),
  [data.slots]);

  const hours = coerceVenueHours({ openMinute: data.venue.openMinute, closeMinute: data.venue.closeMinute, label: data.venue.hoursLabel });
  const withinHours = nowMs ? isWithinHours(hours, nowMs) : true;
  const hasQq = Boolean(user?.qq);
  const canJoinNow = data.queue.status === "OPEN" && withinHours && hasQq;
  const accentBtn = accent === "coral" || accent === "sun" ? "btn-coral" : "btn-mint";

  async function act(path: string, body?: unknown, key?: string) {
    setBusy(key || path); setError(null);
    try {
      const res = await fetch(path, { method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message || "操作失败");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally { setBusy(null); }
  }

  const joinPath = `/api/queues/${venueSlug}/${machineSlug}/join`;

  return (
    <div className="space-y-4">
      <section className="panel p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <QueueStatusHeader data={data} machineName={machineName}
            hoursLabel={data.queue.status === "OPEN" ? (withinHours ? "开放" : "未开放") : data.queue.status} />

          <div className="flex w-full max-w-sm flex-col gap-2 sm:w-auto">
            {user ? (
              !myEntry ? (
                <>
                  {!hasQq && (
                    <p className="text-xs text-coral-600">
                      排队需绑定 QQ，用于机台空闲时群内提醒。
                      <a className="ml-1 underline" href="/me">去完善</a>
                    </p>
                  )}
                  <div className="flex rounded-md border border-ink-200 bg-white p-0.5">
                    {(["SOLO", "DUO"] as const).map((mode) => (
                      <button key={mode} type="button"
                        className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition ${
                          joinMode === mode ? "bg-ink-950 text-white" : "text-ink-600 hover:bg-ink-50"}`}
                        onClick={() => setJoinMode(mode)}>
                        {mode === "SOLO" ? "单刷" : "拼机"}
                      </button>
                    ))}
                  </div>
                  {!hasQq ? (
                    <a className="btn-primary" href="/me">完善 QQ 后才能排队</a>
                  ) : (
                    <button className={accentBtn} disabled={busy === "join" || !canJoinNow}
                      onClick={() => act(joinPath, { playMode: joinMode }, "join")}>
                      <Gamepad2 className="h-4 w-4" />
                      {!withinHours || data.queue.status !== "OPEN" ? `开放 ${hours.label}`
                        : busy === "join" ? "排卡中…" : joinMode === "SOLO" ? "单刷" : "拼机"}
                    </button>
                  )}
                </>
              ) : (
                <MySlotActions myEntry={myEntry} busy={busy} accentBtn={accentBtn} act={act} />
              )
            ) : (
              <a className="btn-primary" href="/login">扫码登录</a>
            )}
          </div>
        </div>

        {mySlot && <MySlotCard mySlot={mySlot} myEntry={myEntry} data={data} nowMs={nowMs} />}
      </section>

      {error && <div className="rounded-md border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-600">{error}</div>}

      {user && !myEntry && seekingDuos.length > 0 && (
        <DuoDiscoveryList slots={seekingDuos} busy={busy} canJoin={canJoinNow} openLabel={hours.label}
          onJoin={(partyId) => act(joinPath, { playMode: "DUO", partyId }, `join-${partyId}`)} />
      )}

      <QueueSlotList slots={data.slots} />
    </div>
  );
}

// ---- internal helpers (moved out for readability) ----

function MySlotActions({ myEntry, busy, accentBtn, act }: {
  myEntry: NonNullable<ReturnType<typeof useMemo<unknown>>>, busy: string | null, accentBtn: string,
  act: (path: string, body?: unknown, key?: string) => Promise<void>,
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {myEntry.status === "PLAYING" && (
        <button className="btn-primary" disabled={busy === "finish"}
          onClick={() => act(`/api/entries/${myEntry.id}/finish`, undefined, "finish")}>结束游玩</button>
      )}
      {myEntry.status === "WAITING" && myEntry.canConfirmStart && (
        <button className={accentBtn} disabled={busy === "start"}
          onClick={() => act(`/api/entries/${myEntry.id}/confirm`, undefined, "start")}>
          <Gamepad2 className="h-4 w-4" />{busy === "start" ? "确认中…" : "确认上机"}
        </button>
      )}
      {myEntry.status === "WAITING" && (
        <button className="btn-ghost" disabled={busy === "cancel"}
          onClick={() => act(`/api/entries/${myEntry.id}/cancel`, undefined, "cancel")}>
          <LogOut className="h-4 w-4" />卸卡
        </button>
      )}
      {myEntry.party?.canConfirmPair && (
        <button className="btn-mint" disabled={busy === "pair"}
          onClick={() => act(`/api/parties/${myEntry.party!.id}/confirm`, undefined, "pair")}>
          <UserPlus className="h-4 w-4" />确认拼机
        </button>
      )}
    </div>
  );
}

function MySlotCard({ mySlot, myEntry, data, nowMs }: {
  mySlot: NonNullable<ReturnType<typeof useMemo<unknown>>>,
  myEntry: NonNullable<ReturnType<typeof useMemo<unknown>>>,
  data: PublicQueueSnapshot, nowMs: number,
}) {
  const deadline = myEntry?.headConfirmDeadlineAt;
  return (
    <div className="mt-4 rounded-md border border-ink-200 bg-ink-50/70 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs text-ink-500">我的</div>
          <div className="mt-0.5 text-sm font-semibold text-ink-950">
            {mySlot.playMode === "DUO" ? "拼机 · " : "单刷 · "}
            {statusLabel(mySlot.status)}
            {mySlot.position != null ? ` · #${mySlot.position}` : ""}
          </div>
          {mySlot.party && (
            <div className="mt-1 text-sm text-ink-500">
              {partyStatusLabel(mySlot.party.status)}
              {mySlot.party.members.length === 2 && ` · ${mySlot.party.members.map((m: { displayName: string }) => m.displayName).join(" + ")}`}
            </div>
          )}
          {myEntry?.status === "WAITING" && myEntry.canConfirmStart && (
            <div className="mt-1 text-sm font-medium text-mint-700">
              请确认上机{deadline && <> · {formatRemain(deadline, nowMs)}{myEntry.headMissCount >= 1 ? " · 超时卸卡" : " · 超时后移"}</>}
            </div>
          )}
          {myEntry?.status === "WAITING" && mySlot.position === 1 && !myEntry.canConfirmStart &&
            mySlot.playMode === "DUO" && mySlot.party?.status !== "CONFIRMED" && (
              <div className="mt-1 text-sm text-ink-500">先完成拼机</div>
          )}
          {myEntry?.status === "WAITING" && mySlot.position === 1 && !myEntry.canConfirmStart &&
            data.slots.some((s: { status: string }) => s.status === "PLAYING") && (
              <div className="mt-1 text-sm text-ink-500">有人在玩</div>
          )}
          {myEntry?.status === "PLAYING" && myEntry.playingAt && (
            <div className="mt-1 text-sm text-ink-500">
              剩余 {formatRemain(new Date(new Date(myEntry.playingAt).getTime() + data.queue.playingTimeoutSec * 1000).toISOString(), nowMs)} · 超时回尾
            </div>
          )}
        </div>
        <span className={`chip ${statusClass(mySlot.status)}`}>{statusLabel(mySlot.status)}</span>
      </div>
    </div>
  );
}
