"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Shared admin mutation hook — manages busy/error/ok lifecycle. */
export function useAdminMutation() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<Response>, okMsg?: string) {
    setBusy(key);
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
      setBusy(null);
    }
  }

  return { busy, error, ok, setError, setOk, run };
}
