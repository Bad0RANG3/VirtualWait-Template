"use client";

import { useMemo, useState } from "react";
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

  const hint = useMemo(
    () =>
      "开发模式可用 mock:用户ID:昵称:Rating:称号，例如 mock:demo-user:示例玩家:12000:示例称号",
    []
  );

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
      // A remote Gateway may need to finish logout before reporting success.
      // Poll the opaque attempt id rather than ever submitting the QR again.
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
    <form onSubmit={onSubmit} className="panel space-y-5 p-6 sm:p-7">
      <div>
        <div className="section-label">MAIMAI QR</div>
        <h1 className="mt-3 font-display text-3xl font-semibold text-ink-900">
          舞萌二维码登录
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">
          使用机台/App 上的一次性二维码登录。系统用 userid 识别身份，本机会话保存至当天
          0:00（北京时间）自动失效。同一网络地址当天只能绑定一个账号。
        </p>
      </div>

      <div>
        <label className="label" htmlFor="qr-login">
          二维码内容
        </label>
        <textarea
          id="qr-login"
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

      <button className="btn-mint w-full" disabled={busy || !qrCode.trim()}>
        {busy ? "验证中…" : "扫码登录"}
      </button>
    </form>
  );
}
