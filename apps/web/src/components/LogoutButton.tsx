"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
    setBusy(false);
  }

  return (
    <button className="btn-ghost !py-2" onClick={onClick} disabled={busy}>
      {busy ? "…" : "退出"}
    </button>
  );
}
