"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function QrLoginForm({
  redirectTo = "/me",
}: {
  redirectTo?: string;
}) {
  const router = useRouter();
  const [qrCode, setQrCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/qr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qrCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message || "登录失败");
      }
      let current = data;
      for (let i = 0; current.status === "PROCESSING" && i < 30; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        const poll = await fetch(`/api/auth/attempts/${encodeURIComponent(current.attemptId)}`, {
          cache: "no-store",
        });
        current = await poll.json();
        if (!poll.ok) {
          throw new Error(current?.error?.message || "验证状态查询失败");
        }
      }
      if (current.status === "PROCESSING") {
        throw new Error("验证仍在处理中，请稍后重试");
      }
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="panel space-y-4 p-4 sm:p-5">
      <h1 className="font-display text-2xl font-semibold text-ink-950">
        扫码登录
      </h1>

      <div>
        <label className="label" htmlFor="qr-login">
          二维码
        </label>
        <textarea
          id="qr-login"
          className="field min-h-28 font-mono text-sm"
          placeholder="粘贴二维码…"
          value={qrCode}
          onChange={(e) => setQrCode(e.target.value)}
          required
        />
      </div>

      {error && (
        <div className="rounded-md border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-600">
          {error}
        </div>
      )}

      <button className="btn-mint w-full" disabled={busy || !qrCode.trim()}>
        {busy ? "验证中…" : "扫码登录"}
      </button>
    </form>
  );
}
