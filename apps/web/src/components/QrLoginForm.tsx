"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQrVerificationFlow } from "./hooks/useQrVerificationFlow";

export function QrLoginForm({
  redirectTo = "/me",
}: {
  redirectTo?: string;
}) {
  const router = useRouter();
  const [qrCode, setQrCode] = useState("");
  const { busy, error, setError, submit } = useQrVerificationFlow();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      // 1. Submit QR code and poll until the Gateway resolves the attempt.
      const result = await submit({
        endpoint: "/api/auth/qr",
        body: { qrCode },
      });

      // 2. Complete login with the one-time capability token.
      if (!result.completionToken) {
        throw new Error("登录失败：缺少完成凭据");
      }
      const complete = await fetch("/api/auth/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attemptId: result.attemptId,
          completionToken: result.completionToken,
        }),
      });
      const completeData = await complete.json().catch(() => ({}));
      if (!complete.ok) {
        throw new Error(completeData?.error?.message || "登录完成失败");
      }

      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
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
