"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MachineAccent } from "@/lib/constants/catalog";
import type {
  PublicQueueSnapshot,
  QueueSlotView,
  SessionUser,
} from "@/lib/types";
import {
  coerceVenueHours,
  isWithinHours,
} from "@/lib/time/hours";
import {
  Gamepad2,
  LogOut,
  UserPlus,
  Users,
} from "lucide-react";

function liveVenueHours(data: PublicQueueSnapshot) {
  return coerceVenueHours({
    openMinute: data.venue.openMinute,
    closeMinute: data.venue.closeMinute,
    label: data.venue.hoursLabel,
  });
}

function isOpenAt(data: PublicQueueSnapshot, nowMs: number) {
  return isWithinHours(liveVenueHours(data), nowMs);
}

function statusLabel(status: string) {
  switch (status) {
    case "PLAYING":
      return "游玩中";
    case "WAITING":
      return "等待中";
    default:
      return status;
  }
}

function statusClass(status: string) {
  switch (status) {
    case "PLAYING":
      return "bg-mint-50 text-mint-700";
    default:
      return "bg-ink-50 text-ink-600";
  }
}

function partyStatusLabel(status: string) {
  switch (status) {
    case "SEEKING":
      return "招募拼机";
    case "PENDING":
      return "待双方确认";
    case "CONFIRMED":
      return "拼机已确认";
    default:
      return status;
  }
}

function formatRemain(expiresAt: string, nowMs: number) {
  if (!nowMs) return "--";
  const ms = new Date(expiresAt).getTime() - nowMs;
  if (ms <= 0) return "结算中";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
}

export function QueueBoard({
  venueSlug,
  machineSlug,
  machineName,
  accent,
  initial,
  user,
}: {
  venueSlug: string;
  machineSlug: string;
  machineName: string;
  accent: MachineAccent;
  initial: PublicQueueSnapshot;
  user: SessionUser | null;
}) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [joinMode, setJoinMode] = useState<"SOLO" | "DUO">("SOLO");

  const refresh = useCallback(async () => {
    const res = await fetch(
      `/api/queues/${venueSlug}/${machineSlug}/public`,
      { cache: "no-store" }
    );
    if (!res.ok) return;
    const json = (await res.json()) as PublicQueueSnapshot;
    setData(json);
  }, [venueSlug, machineSlug]);

  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3500);
    const clock = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(clock);
    };
  }, [refresh]);

  const myEntry = useMemo(
    () => data.entries.find((e) => e.isMine) || null,
    [data.entries]
  );
  const mySlot = useMemo(
    () => data.slots.find((s) => s.isMine) || null,
    [data.slots]
  );

  const seekingDuos = useMemo(
    () =>
      data.slots.filter(
        (s) =>
          s.playMode === "DUO" &&
          s.party?.status === "SEEKING" &&
          !s.isMine
      ),
    [data.slots]
  );
  const hours = liveVenueHours(data);
  const withinHours = nowMs ? isOpenAt(data, nowMs) : true;
  const queueStatusLabel = withinHours ? "开放" : "未开放";
  const canJoinNow = data.queue.status === "OPEN" && withinHours;

  async function act(path: string, body?: unknown, key?: string) {
    setBusy(key || path);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message || "操作失败");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  const accentBtn =
    accent === "coral" || accent === "sun" ? "btn-coral" : "btn-mint";

  function renderSlotBadge(slot: QueueSlotView) {
    if (slot.status === "PLAYING") return "P";
    return slot.position ?? "·";
  }

  return (
    <div className="space-y-4">
      <section className="panel p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-ink-500">
              {data.venue.name}
              {data.venue.regionName
                ? ` · ${data.venue.regionName}${
                    data.venue.regionKind === "county"
                      ? "县"
                      : data.venue.regionKind === "district"
                        ? "区"
                        : ""
                  }`
                : ""}
              {data.venue.address ? ` · ${data.venue.address}` : ""}
            </div>
            <h1 className="mt-0.5 font-display text-2xl font-semibold tracking-tight text-ink-950 sm:text-3xl">
              {machineName}
            </h1>
            <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
              <span className="chip bg-ink-50 text-ink-700">
                <Users className="mr-1 h-3.5 w-3.5" />
                {data.slots.length} 组
              </span>
              <span className="chip bg-ink-50 text-ink-700">
                机台 {data.venue.machineCount ?? "—"}
              </span>
              <span className="chip bg-ink-50 text-ink-700">
                {data.queue.coinCost ?? 1} 币
              </span>
              <span className="chip bg-ink-50 text-ink-700">
                游玩 {Math.round(data.queue.playingTimeoutSec / 60)} 分
              </span>
              <span className="chip bg-ink-50 text-ink-700">
                确认 {Math.round(data.queue.headConfirmTimeoutSec / 60)} 分
              </span>
              <span className="chip bg-ink-50 text-ink-700">
                {data.queue.status === "OPEN" ? queueStatusLabel : data.queue.status}
              </span>
            </div>
          </div>

          <div className="flex w-full max-w-sm flex-col gap-2 sm:w-auto">
            {user ? (
              !myEntry ? (
                <>
                  <div className="flex rounded-md border border-ink-200 bg-white p-0.5">
                    <button
                      type="button"
                      className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition ${
                        joinMode === "SOLO"
                          ? "bg-ink-950 text-white"
                          : "text-ink-600 hover:bg-ink-50"
                      }`}
                      onClick={() => setJoinMode("SOLO")}
                    >
                      单刷
                    </button>
                    <button
                      type="button"
                      className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition ${
                        joinMode === "DUO"
                          ? "bg-ink-950 text-white"
                          : "text-ink-600 hover:bg-ink-50"
                      }`}
                      onClick={() => setJoinMode("DUO")}
                    >
                      拼机
                    </button>
                  </div>
                  <button
                    className={accentBtn}
                    disabled={busy === "join" || !canJoinNow}
                    onClick={() =>
                      act(
                        `/api/queues/${venueSlug}/${machineSlug}/join`,
                        { playMode: joinMode },
                        "join"
                      )
                    }
                  >
                    <Gamepad2 className="h-4 w-4" />
                    {!canJoinNow
                      ? `开放 ${hours.label}`
                      : busy === "join"
                      ? "排卡中…"
                      : joinMode === "SOLO"
                        ? "单刷"
                        : "拼机"}
                  </button>
                </>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {myEntry.status === "PLAYING" && (
                    <button
                      className="btn-primary"
                      disabled={busy === "finish"}
                      onClick={() =>
                        act(`/api/entries/${myEntry.id}/finish`, undefined, "finish")
                      }
                    >
                      结束游玩
                    </button>
                  )}
                  {myEntry.status === "WAITING" && myEntry.canConfirmStart && (
                    <button
                      className={accentBtn}
                      disabled={busy === "start"}
                      onClick={() =>
                        act(`/api/entries/${myEntry.id}/confirm`, undefined, "start")
                      }
                    >
                      <Gamepad2 className="h-4 w-4" />
                      {busy === "start" ? "确认中…" : "确认上机"}
                    </button>
                  )}
                  {myEntry.status === "WAITING" && (
                    <button
                      className="btn-ghost"
                      disabled={busy === "cancel"}
                      onClick={() =>
                        act(`/api/entries/${myEntry.id}/cancel`, undefined, "cancel")
                      }
                    >
                      <LogOut className="h-4 w-4" />
                      卸卡
                    </button>
                  )}
                  {myEntry.party?.canConfirmPair && (
                    <button
                      className="btn-mint"
                      disabled={busy === "pair"}
                      onClick={() =>
                        act(
                          `/api/parties/${myEntry.party!.id}/confirm`,
                          undefined,
                          "pair"
                        )
                      }
                    >
                      <UserPlus className="h-4 w-4" />
                      确认拼机
                    </button>
                  )}
                </div>
              )
            ) : (
              <a className="btn-primary" href="/login">
                扫码登录
              </a>
            )}
          </div>
        </div>

        {mySlot && (
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
                    {mySlot.party.members.length === 2 &&
                      ` · ${mySlot.party.members
                        .map((m) => m.displayName)
                        .join(" + ")}`}
                  </div>
                )}
                {myEntry?.status === "WAITING" && myEntry.canConfirmStart && (
                  <div className="mt-1 text-sm font-medium text-mint-700">
                    请确认上机
                    {myEntry.headConfirmDeadlineAt && (
                      <>
                        {" "}· {formatRemain(myEntry.headConfirmDeadlineAt, nowMs)}
                        {myEntry.headMissCount >= 1 ? " · 超时卸卡" : " · 超时后移"}
                      </>
                    )}
                  </div>
                )}
                {myEntry?.status === "WAITING" &&
                  mySlot.position === 1 &&
                  !myEntry.canConfirmStart &&
                  mySlot.playMode === "DUO" &&
                  mySlot.party?.status !== "CONFIRMED" && (
                  <div className="mt-1 text-sm text-ink-500">
                    先完成拼机
                  </div>
                )}
                {myEntry?.status === "WAITING" &&
                  mySlot.position === 1 &&
                  !myEntry.canConfirmStart &&
                  data.slots.some((s) => s.status === "PLAYING") && (
                  <div className="mt-1 text-sm text-ink-500">
                    有人在玩
                  </div>
                )}
                {myEntry?.status === "PLAYING" && myEntry.playingAt && (
                  <div className="mt-1 text-sm text-ink-500">
                    剩余{" "}
                    {formatRemain(
                      new Date(
                        new Date(myEntry.playingAt).getTime() +
                          data.queue.playingTimeoutSec * 1000
                      ).toISOString(),
                      nowMs
                    )}
                    · 超时回尾
                  </div>
                )}
              </div>
              <span className={`chip ${statusClass(mySlot.status)}`}>
                {statusLabel(mySlot.status)}
              </span>
            </div>
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-md border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-600">
          {error}
        </div>
      )}

      {user && !myEntry && seekingDuos.length > 0 && (
        <section className="panel overflow-hidden">
          <div className="border-b border-ink-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink-900">拼机</h2>
          </div>
          <ul>
            {seekingDuos.map((slot) => {
              const host = slot.party?.members.find((m) => m.isHost);
              return (
                <li key={slot.key} className="list-row">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-ink-900">
                      {host?.displayName || "发起人"} 的拼机
                    </div>
                    <div className="mt-0.5 text-sm text-ink-500">
                      {host?.bound
                        ? host.ratingVisible && typeof host.rating === "number"
                          ? `R${host.rating}`
                          : "R 隐藏"
                        : "未绑定"}
                      {host?.title ? ` · ${host.title}` : ""}
                    </div>
                  </div>
                  <button
                    className="btn-mint !py-1.5"
                    disabled={busy === `join-${slot.party?.id}` || !canJoinNow}
                    onClick={() =>
                      act(
                        `/api/queues/${venueSlug}/${machineSlug}/join`,
                        { playMode: "DUO", partyId: slot.party?.id },
                        `join-${slot.party?.id}`
                      )
                    }
                  >
                    <UserPlus className="h-4 w-4" />
                    {canJoinNow ? "加入" : `开放 ${hours.label}`}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between px-0.5">
          <h2 className="text-sm font-semibold text-ink-900">队列</h2>
          <span className="text-xs text-ink-400">{data.slots.length} 组</span>
        </div>

        {data.slots.length === 0 ? (
          <div className="panel px-4 py-10 text-center text-sm text-ink-400">
            暂无
          </div>
        ) : (
          data.slots.map((slot) => (
            <article
              key={slot.key}
              className={`panel p-3 ${slot.isMine ? "border-mint-400" : ""}`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`grid h-10 w-10 shrink-0 place-items-center rounded-md text-sm font-semibold ${
                    slot.status === "PLAYING"
                      ? "bg-mint-600 text-white"
                      : "bg-ink-950 text-white"
                  }`}
                >
                  {renderSlotBadge(slot)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`chip ${
                        slot.playMode === "DUO"
                          ? "bg-sky-50 text-sky-500"
                          : "bg-ink-50 text-ink-600"
                      }`}
                    >
                      {slot.playMode === "DUO" ? "拼机" : "单刷"}
                    </span>
                    <span className={`chip ${statusClass(slot.status)}`}>
                      {statusLabel(slot.status)}
                    </span>
                    {slot.party && (
                      <span className="chip bg-sun-50 text-sun-500">
                        {partyStatusLabel(slot.party.status)}
                      </span>
                    )}
                    {slot.isMine && (
                      <span className="chip bg-mint-50 text-mint-700">我</span>
                    )}
                  </div>

                  <div className="mt-2 space-y-1.5">
                    {slot.entries.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-ink-50/80 px-2.5 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-ink-900">
                            {entry.profile.displayName}
                            {entry.isMine ? "（我）" : ""}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ink-500">
                            {entry.profile.bound &&
                            entry.profile.ratingVisible &&
                            typeof entry.profile.rating === "number" ? (
                              <span>R{entry.profile.rating}</span>
                            ) : !entry.profile.bound ? (
                              <span className="text-ink-400">未绑定</span>
                            ) : (
                              <span className="text-ink-400">Rating 隐藏</span>
                            )}
                            {entry.profile.bound && entry.profile.title && (
                              <span>{entry.profile.title}</span>
                            )}
                            <span>#{entry.sequenceNumber}</span>
                          </div>
                        </div>
                        <span className={`chip ${statusClass(entry.status)}`}>
                          {statusLabel(entry.status)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
