"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQrVerificationFlow } from "./hooks/useQrVerificationFlow";

export function QrBindForm({
  purpose,
  redirectTo = "/",
  title = "刷新资料",
}: {
  purpose: "REGISTER_BIND" | "LOGIN_BIND";
  redirectTo?: string;
  title?: string;
}) {
  const router = useRouter();
  const [qrCode, setQrCode] = useState("");
  const [ok, setOk] = useState<string | null>(null);
  const { busy, error, setError, submit } = useQrVerificationFlow();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setOk(null);
    try {
      // Submit the QR and poll until the Gateway resolves the attempt,
      // so a PROCESSING response is never mistaken for success.
      const result = await submit({
        endpoint: "/api/bind",
        body: { qrCode, purpose },
      });
      const profile = result.profile;
      setOk(
        `已更新：${profile?.displayName || "OK"}${
          typeof profile?.rating === "number" ? ` · Rating ${profile.rating}` : ""
        }`,
      );
      window.setTimeout(() => {
        router.push(redirectTo);
        router.refresh();
      }, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "刷新失败");
    }
  }

  return (
    <form onSubmit={onSubmit} className="panel space-y-4 p-4 sm:p-5">
      <h2 className="font-display text-2xl font-semibold text-ink-950">{title}</h2>

      <div>
        <label className="label" htmlFor="qr">
          二维码
        </label>
        <textarea
          id="qr"
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
      {ok && (
        <div className="rounded-md border border-mint-200 bg-mint-50 px-3 py-2 text-sm text-mint-700">
          {ok}
        </div>
      )}

      <button className="btn-mint w-full" disabled={busy || !qrCode.trim()}>
        {busy ? "验证中…" : "刷新"}
      </button>
    </form>
  );
}
