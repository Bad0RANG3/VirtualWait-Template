"use client";

import { useCallback, useRef, useState } from "react";

export type QrVerificationResult = {
  attemptId: string;
  status: string;
  /** Present on the initial QR POST response; required for login completion. */
  completionToken?: string;
  /** Present when the verified profile was resolved (bind flow). */
  profile?: {
    displayName?: string;
    rating?: number | null;
    title?: string | null;
    iconUrl?: string | null;
    maimaiDisplayName?: string;
  };
};

type PollResponse = Partial<QrVerificationResult> & {
  error?: { message?: string };
};

type SubmitOptions = {
  endpoint: string;
  body: Record<string, unknown>;
  pollLimit?: number;
  pollIntervalMs?: number;
};

/**
 * Shared QR verification flow: submit the QR once, poll the gateway attempt
 * until it leaves PROCESSING, and hand back the result. Used by both login
 * (which then exchanges the completion token) and profile refresh/bind
 * (which just needs the resolved profile).
 */
export function useQrVerificationFlow() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const submit = useCallback(async (opts: SubmitOptions): Promise<QrVerificationResult> => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch(opts.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts.body),
        signal: abort.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "验证失败");

      // The completion token (login only) comes from the initial response.
      const completionToken =
        typeof data.completionToken === "string" ? data.completionToken : undefined;
      let current = data as PollResponse;

      const limit = opts.pollLimit ?? 30;
      const intervalMs = opts.pollIntervalMs ?? 2_000;
      for (let i = 0; current.status === "PROCESSING" && i < limit; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
        const poll = await fetch(
          `/api/auth/attempts/${encodeURIComponent(current.attemptId!)}`,
          { cache: "no-store", signal: abort.signal },
        );
        current = (await poll.json().catch(() => ({}))) as PollResponse;
        if (!poll.ok) throw new Error(current?.error?.message || "验证状态查询失败");
      }
      if (current.status === "PROCESSING") {
        throw new Error("验证仍在处理中，请稍后重试");
      }

      return { ...current, completionToken } as QrVerificationResult;
    } catch (err) {
      if (!abort.signal.aborted) {
        setError(err instanceof Error ? err.message : "验证失败");
      }
      throw err;
    } finally {
      setBusy(false);
      if (abortRef.current === abort) abortRef.current = null;
    }
  }, []);

  return { busy, error, setError, submit };
}
