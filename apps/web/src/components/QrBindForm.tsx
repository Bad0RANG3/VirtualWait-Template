"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export function QrBindForm({
  purpose,
  redirectTo = "/",
  title = "刷新舞萌资料",
}: {
  purpose: "REGISTER_BIND" | "LOGIN_BIND";
  redirectTo?: string;
  title?: string;
}) {
  const router = useRouter();
  const [qrCode, setQrCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const hint = useMemo(
    () =>
      "开发模式可用 mock:用户ID:昵称:Rating:称号，例如 mock:demo-user:示例玩家:12000:示例称号",
    []
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch("/api/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qrCode, purpose }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message || "刷新失败");
      }
      setOk(
        `已更新：${data.profile?.displayName || "OK"}${
          typeof data.profile?.rating === "number"
            ? ` · Rating ${data.profile.rating}`
            : ""
        }`
      );
      setTimeout(() => {
        router.push(redirectTo);
        router.refresh();
      }, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="panel space-y-5 p-6 sm:p-7">
      <div>
        <div className="section-label">QR REFRESH</div>
        <h2 className="mt-3 font-display text-2xl font-semibold text-ink-900">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">
          使用舞萌二维码刷新公开资料。系统只保存公开快照，不保存原始二维码。
        </p>
      </div>

      <div>
        <label className="label" htmlFor="qr">
          二维码内容
        </label>
        <textarea
          id="qr"
          className="field min-h-32 font-mono text-sm"
          placeholder="粘贴二维码解析结果…"
          value={qrCode}
          onChange={(e) => setQrCode(e.target.value)}
          required
        />
        <p className="mt-2 text-xs leading-relaxed text-ink-400">{hint}</p>
      </div>

      {error && (
        <div className="rounded-xl border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-600">
          {error}
        </div>
      )}
      {ok && (
        <div className="rounded-xl border border-mint-200 bg-mint-50 px-3 py-2 text-sm text-mint-700">
          {ok}
        </div>
      )}

      <button className="btn-mint w-full" disabled={busy || !qrCode.trim()}>
        {busy ? "验证中…" : "确认刷新"}
      </button>
    </form>
  );
}
