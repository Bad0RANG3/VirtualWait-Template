"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AdminLoginForm() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || "认证失败");
      setToken("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "认证失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel mx-auto max-w-md space-y-4 p-4 sm:p-5">
      <h1 className="font-display text-2xl font-semibold text-ink-950">运维登录</h1>
      <div>
        <label className="label" htmlFor="admin-token">令牌</label>
        <input
          id="admin-token"
          className="field"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
        />
      </div>
      {error && (
        <div className="rounded-md border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-600">
          {error}
        </div>
      )}
      <button className="btn-primary w-full" disabled={busy || !token}>
        {busy ? "验证中…" : "进入"}
      </button>
    </form>
  );
}
