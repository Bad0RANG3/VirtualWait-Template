"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkinSecondsRemaining,
  formatCheckinCountdown,
  type VenueCheckinCode,
} from "@/lib/settings/checkin-shared";
import { useAdminMutation } from "./useAdminMutation";

const REFRESH_MS = 15_000;

function countdownText(expiresAt: string, nowMs: number) {
  return formatCheckinCountdown(checkinSecondsRemaining({ expiresAt }, nowMs));
}

/**
 * 场地签到码面板：注册账号时必须输入其中之一，用来证明玩家本人在现场。
 * 码随时间自动轮换；轮换按钮用于码外泄时立即作废。
 *
 * 轮询失败或码已过期时会显式提示——现场照着失效的码念会让所有注册失败，
 * 所以「码可能已过期」必须看得见，而不是静默停留在旧值。
 */
export function AdminCheckinCodes({
  initial,
  initialServerNowMs,
}: {
  initial: VenueCheckinCode[];
  /** Server clock at render time, so the countdown is immune to client skew. */
  initialServerNowMs?: number;
}) {
  const [codes, setCodes] = useState(initial);
  const [nowMs, setNowMs] = useState(0);
  const [staleError, setStaleError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // serverNowMs - clientNowMs, refreshed on every successful load.
  const clockOffsetRef = useRef(
    initialServerNowMs ? initialServerNowMs - Date.now() : 0,
  );
  const { busy, error, ok, run } = useAdminMutation();

  useEffect(() => {
    mountedRef.current = true;
    setNowMs(Date.now());
    const clock = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(clock);
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const results = await Promise.all(
        codes.map(async (code) => {
          const res = await fetch(
            `/api/admin/venues/${encodeURIComponent(code.venueId)}/checkin`,
            { cache: "no-store" },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as {
            checkin?: VenueCheckinCode;
            serverNowMs?: number;
          };
          if (typeof data?.serverNowMs === "number") {
            clockOffsetRef.current = data.serverNowMs - Date.now();
          }
          return data?.checkin || code;
        }),
      );
      if (mountedRef.current) {
        setCodes(results);
        setStaleError(null);
      }
    } catch {
      // Keep the last known codes but make the staleness explicit.
      if (mountedRef.current) {
        setStaleError("无法刷新签到码，下面显示的码可能已过期；请刷新页面或检查管理会话。");
      }
    }
  }, [codes]);

  useEffect(() => {
    const timer = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const rotate = (venueId: string) =>
    run(venueId, () =>
      fetch(`/api/admin/venues/${encodeURIComponent(venueId)}/checkin`, {
        method: "POST",
      }),
    ).then((data) => {
      if (data?.checkin) {
        if (typeof data.serverNowMs === "number") {
          clockOffsetRef.current = data.serverNowMs - Date.now();
        }
        setCodes((prev) =>
          prev.map((code) => (code.venueId === venueId ? data.checkin : code)),
        );
        setStaleError(null);
      }
    });

  return (
    <section className="panel p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-ink-900">场地签到码</h2>
      <p className="mt-1 text-xs text-ink-500">
        玩家注册账号时需输入现场公布的签到码，码每 {codes[0]?.windowSec ?? 600} 秒自动更换。
      </p>

      {error && (
        <div className="mt-3 rounded-md border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-600">
          {error}
        </div>
      )}
      {staleError && (
        <div className="mt-3 rounded-md border border-sun-200 bg-sun-50 px-3 py-2 text-sm text-sun-500">
          {staleError}
        </div>
      )}
      {ok && (
        <div className="mt-3 rounded-md border border-mint-200 bg-mint-50 px-3 py-2 text-sm text-mint-700">
          {ok}
        </div>
      )}

      <div className="mt-3 space-y-2">
        {codes.map((code) => {
          // Compare against the server clock: a skewed operator machine must not
          // make a live code look expired (or hide a rotation).
          const serverNowMs = nowMs > 0 ? nowMs + clockOffsetRef.current : 0;
          const left =
            serverNowMs > 0
              ? checkinSecondsRemaining(code, serverNowMs)
              : null;
          const expired = left === 0;
          return (
            <div
              key={code.venueId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-ink-200 bg-ink-50/60 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-ink-900">
                  {code.venueName}
                </div>
                <div className="mt-0.5 text-xs text-ink-500">
                  {left === null
                    ? "—"
                    : expired
                      ? "已过期，等待刷新"
                      : `${countdownText(code.expiresAt, serverNowMs)} 后更换`}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`font-mono text-2xl font-semibold tracking-[0.3em] ${
                    expired ? "text-ink-400 line-through" : "text-ink-950"
                  }`}
                >
                  {code.code}
                </span>
                <button
                  className="btn-ghost !py-1.5"
                  disabled={busy === code.venueId}
                  onClick={() => rotate(code.venueId)}
                >
                  {busy === code.venueId ? "轮换中…" : "立即轮换"}
                </button>
              </div>
            </div>
          );
        })}
        {codes.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-ink-400">
            暂无场地
          </div>
        )}
      </div>
    </section>
  );
}
