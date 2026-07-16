"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/types";
import { Eye, EyeOff, Save } from "lucide-react";

export function ProfileSettingsForm({ user }: { user: SessionUser }) {
  const router = useRouter();
  const [nickname, setNickname] = useState(user.nickname);
  const [showRatingPublic, setShowRatingPublic] = useState(
    user.showRatingPublic
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nickname,
          showRatingPublic,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "保存失败");
      setOk("已保存");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const nicknameChanged = nickname.trim() !== user.nickname;
  const ratingChanged = showRatingPublic !== user.showRatingPublic;
  const canSave = (nicknameChanged || ratingChanged) && nickname.trim().length >= 2;

  return (
    <form onSubmit={onSubmit} className="panel space-y-5 p-6 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="section-label">PROFILE</div>
          <h2 className="mt-3 font-display text-2xl font-semibold text-ink-900">
            公开资料
          </h2>
        </div>
        {user.bound && typeof user.rating === "number" && (
          <span className="chip bg-ink-50 text-ink-700">Rating {user.rating}</span>
        )}
      </div>

      <div>
        <label className="label" htmlFor="profile-nickname">
          用户名
        </label>
        <input
          id="profile-nickname"
          className="field"
          value={nickname}
          maxLength={20}
          onChange={(e) => setNickname(e.target.value)}
          required
        />
      </div>

      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-ink-100 bg-ink-50/60 px-4 py-3">
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-ink-700">
            {showRatingPublic ? (
              <Eye className="h-4 w-4" />
            ) : (
              <EyeOff className="h-4 w-4" />
            )}
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-ink-900">展示 Rating</span>
            <span className="block text-sm text-ink-500">
              {showRatingPublic ? "队列中可见" : "队列中隐藏"}
            </span>
          </span>
        </span>
        <input
          type="checkbox"
          className="h-5 w-5 rounded border-ink-300 text-mint-600 focus:ring-mint-300"
          checked={showRatingPublic}
          onChange={(e) => setShowRatingPublic(e.target.checked)}
        />
      </label>

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

      <button className="btn-mint w-full" disabled={busy || !canSave}>
        <Save className="h-4 w-4" />
        {busy ? "保存中…" : "保存"}
      </button>
    </form>
  );
}
