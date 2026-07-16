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
      if (!response.ok) throw new Error(data?.error?.message || "管理员认证失败");
      setToken("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "管理员认证失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel mx-auto max-w-md space-y-5 p-6 sm:p-7">
      <div>
        <div className="section-label">OPERATIONS</div>
        <h1 className="mt-3 font-display text-3xl font-semibold text-ink-900">管理员登录</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">
          仅限受控运维人员。令牌提交后仅保存为短期 HttpOnly 会话。
        </p>
      </div>
      <div>
        <label className="label" htmlFor="admin-token">管理员令牌</label>
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
      {error && <div className="rounded-xl border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-600">{error}</div>}
      <button className="btn-primary w-full" disabled={busy || !token}>{busy ? "验证中…" : "进入运维台"}</button>
    </form>
  );
}
