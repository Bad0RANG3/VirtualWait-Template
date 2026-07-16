"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isVenueOpenAt, VENUE_HOURS } from "@/lib/constants/venue";
import type {
  PublicQueueSnapshot,
  QueueSlotView,
  SessionUser,
} from "@/lib/types";
import {
  Gamepad2,
  LogOut,
  Sparkles,
  UserPlus,
  Users,
} from "lucide-react";

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
  accent: "coral" | "mint";
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
  const withinHours = nowMs ? isVenueOpenAt(nowMs) : true;
  const queueStatusLabel = withinHours ? "开放排队" : "未到开放时间";
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

  const isCoral = accent === "coral";
  const accentBar = isCoral
    ? "from-coral-400 to-sun-300"
    : "from-mint-400 to-sky-400";
  const accentBtn = isCoral ? "btn-coral" : "btn-mint";
  const accentSoft = isCoral ? "bg-coral-50 text-coral-600" : "bg-mint-50 text-mint-700";

  function renderSlotBadge(slot: QueueSlotView) {
    if (slot.status === "PLAYING") return "P";
    return slot.position ?? "·";
  }

  return (
    <div className="space-y-5">
      <section className="panel overflow-hidden">
        <div className={`h-1.5 bg-gradient-to-r ${accentBar}`} />
        <div className="flex flex-wrap items-start justify-between gap-5 p-5 sm:p-7">
          <div className="min-w-0 flex-1">
            <div className="text-sm text-ink-500">{data.venue.name}</div>
            <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-ink-900 sm:text-4xl">
              {machineName}
            </h1>
            <div className="mt-4 flex flex-wrap gap-2 text-sm">
              <span className="chip bg-ink-50 text-ink-700">
                <Users className="mr-1 h-3.5 w-3.5" />
                {data.slots.length} 组在列
              </span>
              <span className="chip bg-ink-50 text-ink-700">
                游玩 {Math.round(data.queue.playingTimeoutSec / 60)} 分钟后自动回队尾
              </span>
              <span className={`chip ${accentSoft}`}>
                {data.queue.status === "OPEN" ? queueStatusLabel : data.queue.status}
              </span>
            </div>
          </div>

          <div className="flex w-full max-w-md flex-col gap-3 sm:w-auto">
            {user ? (
              !myEntry ? (
                <>
                  <div className="flex rounded-xl border border-ink-200 bg-white p-1">
                    <button
                      type="button"
                      className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                        joinMode === "SOLO"
                          ? "bg-ink-900 text-white"
                          : "text-ink-600 hover:bg-ink-50"
                      }`}
                      onClick={() => setJoinMode("SOLO")}
                    >
                      单刷
                    </button>
                    <button
                      type="button"
                      className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                        joinMode === "DUO"
                          ? "bg-ink-900 text-white"
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
                      ? `开放时间 ${VENUE_HOURS.label}`
                      : busy === "join"
                      ? "排卡中…"
                      : joinMode === "SOLO"
                        ? "单刷排卡"
                        : "发起拼机"}
                  </button>
                  {!withinHours && (
                    <p className="text-xs leading-relaxed text-ink-400">
                      当前仅可查看队列，开放时间 {VENUE_HOURS.label}。
                    </p>
                  )}
                  {joinMode === "DUO" && (
                    <p className="text-xs leading-relaxed text-ink-400">
                      发起后等待另一位加入，双方确认后才会作为一组游玩。
                    </p>
                  )}
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
                扫码登录后排卡
              </a>
            )}
          </div>
        </div>

        {mySlot && (
          <div className="border-t border-ink-100 bg-ink-50/50 px-5 py-4 sm:px-7">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className={`grid h-11 w-11 place-items-center rounded-2xl ${accentSoft}`}>
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-sm text-ink-500">你的位置</div>
                  <div className="font-display text-lg font-semibold text-ink-900">
                    {mySlot.playMode === "DUO" ? "拼机 · " : "单刷 · "}
                    {statusLabel(mySlot.status)}
                    {mySlot.position != null ? ` · 第 ${mySlot.position} 组` : ""}
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
                  {myEntry?.status === "PLAYING" && myEntry.playingAt && (
                    <div className="mt-1 text-sm text-ink-500">
                      剩余游玩时间{" "}
                      {formatRemain(
                        new Date(
                          new Date(myEntry.playingAt).getTime() +
                            data.queue.playingTimeoutSec * 1000
                        ).toISOString(),
                        nowMs
                      )}
                      ，超时后自动调到队尾
                    </div>
                  )}
                </div>
              </div>
              <span className={`chip ${statusClass(mySlot.status)}`}>
                {statusLabel(mySlot.status)}
              </span>
            </div>
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-2xl border border-coral-200 bg-coral-50 px-4 py-3 text-sm text-coral-600">
          {error}
        </div>
      )}

      {user && !myEntry && seekingDuos.length > 0 && (
        <section className="panel p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold text-ink-900">
            可加入的拼机
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            加入后双方都需确认，确认后才按一组游玩。
          </p>
          <ul className="mt-4 space-y-3">
            {seekingDuos.map((slot) => {
              const host = slot.party?.members.find((m) => m.isHost);
              return (
                <li
                  key={slot.key}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink-100 bg-ink-50/40 px-4 py-3"
                >
                  <div>
                    <div className="font-medium text-ink-900">
                      {host?.displayName || "发起人"} 的拼机
                    </div>
                    <div className="mt-1 text-sm text-ink-500">
                      {host?.bound
                        ? host.ratingVisible && typeof host.rating === "number"
                          ? `Rating ${host.rating}`
                          : "Rating 已隐藏"
                        : "未绑定舞萌"}
                      {host?.title ? ` · ${host.title}` : ""}
                    </div>
                  </div>
                  <button
                    className="btn-mint !py-2"
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
                    {canJoinNow ? "加入拼机" : `开放时间 ${VENUE_HOURS.label}`}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="font-display text-lg font-semibold text-ink-900">队列</h2>
          <span className="text-sm text-ink-400">{data.slots.length} 组</span>
        </div>

        {data.slots.length === 0 ? (
          <div className="panel p-10 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-mint-50 text-mint-600">
              <Users className="h-6 w-6" />
            </div>
            <p className="mt-4 text-ink-500">当前无人排队，登录后可直接排第一组。</p>
          </div>
        ) : (
          data.slots.map((slot) => (
            <article
              key={slot.key}
              className={`panel p-4 transition ${
                slot.isMine ? "ring-2 ring-mint-300" : "hover:border-ink-200"
              }`}
            >
              <div className="flex items-start gap-4">
                <div
                  className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl font-display text-lg font-semibold ${
                    slot.status === "PLAYING"
                      ? "bg-mint-500 text-white"
                      : "bg-ink-900 text-white"
                  }`}
                >
                  {renderSlotBadge(slot)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
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

                  <div className="mt-3 space-y-2">
                    {slot.entries.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-ink-50/60 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-semibold text-ink-900">
                            {entry.profile.displayName}
                            {entry.isMine ? "（我）" : ""}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-ink-500">
                            {entry.profile.bound &&
                            entry.profile.ratingVisible &&
                            typeof entry.profile.rating === "number" ? (
                              <span>Rating {entry.profile.rating}</span>
                            ) : !entry.profile.bound ? (
                              <span className="text-ink-400">未绑定舞萌</span>
                            ) : (
                              <span className="text-ink-400">Rating 已隐藏</span>
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
