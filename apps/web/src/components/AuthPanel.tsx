"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, UserPlus } from "lucide-react";

type VenueOption = { slug: string; label: string };

type Mode = "login" | "register";

/**
 * 唯一的身份入口：用户名 + 口令登录，或凭场地签到码注册一个新账号。
 * 注册会把账号绑定到签到码所属的场地，作为「本人在现场」的证明。
 */
export function AuthPanel({
  venues,
  registrationEnabled,
  checkinRequired,
  redirectTo = "/me",
}: {
  venues: VenueOption[];
  registrationEnabled: boolean;
  checkinRequired: boolean;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [venueSlug, setVenueSlug] = useState(venues[0]?.slug ?? "");
  const [checkinCode, setCheckinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const endpoint =
        mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body =
        mode === "login"
          ? { username, password }
          : {
              username,
              password,
              nickname: nickname.trim() || username,
              venueSlug: venueSlug || undefined,
              checkinCode: checkinCode.trim() || undefined,
            };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "操作失败");
      router.push(redirectTo);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    username.trim().length >= 3 &&
    password.length >= (mode === "login" ? 1 : 8) &&
    (mode === "login" ||
      (!checkinRequired || checkinCode.trim().length === 6));

  return (
    <form onSubmit={submit} className="panel space-y-4 p-4 sm:p-5">
      <div className="flex rounded-md border border-ink-200 bg-white p-0.5">
        {(
          [
            ["login", "登录"],
            ["register", "注册"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`flex-1 rounded px-3 py-1.5 text-sm font-medium transition ${
              mode === value ? "bg-ink-950 text-white" : "text-ink-600 hover:bg-ink-50"
            }`}
            onClick={() => {
              setMode(value);
              setError(null);
            }}
            disabled={value === "register" && !registrationEnabled}
          >
            {label}
          </button>
        ))}
      </div>

      <h1 className="font-display text-2xl font-semibold text-ink-950">
        {mode === "login" ? "登录账号" : "注册账号"}
      </h1>
      <p className="text-sm text-ink-500">
        {mode === "login"
          ? "用你自己的账号登录，排队时以此确认身份。"
          : "每个玩家一个账号。注册时请输入场地当前的签到码，证明你本人在现场。"}
      </p>

      <div>
        <label className="label" htmlFor="auth-username">
          用户名
        </label>
        <input
          id="auth-username"
          className="field"
          value={username}
          autoComplete="username"
          maxLength={20}
          placeholder="3-20 位字母、数字、_ 或 -"
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>

      <div>
        <label className="label" htmlFor="auth-password">
          密码
        </label>
        <input
          id="auth-password"
          className="field"
          type="password"
          value={password}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          maxLength={128}
          placeholder={mode === "login" ? "密码" : "至少 8 位"}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {mode === "register" && (
        <>
          <div>
            <label className="label" htmlFor="auth-nickname">
              排队显示名
            </label>
            <input
              id="auth-nickname"
              className="field"
              value={nickname}
              maxLength={20}
              placeholder="留空则使用用户名"
              onChange={(e) => setNickname(e.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="auth-venue">
              场地
            </label>
            <select
              id="auth-venue"
              className="field"
              value={venueSlug}
              onChange={(e) => setVenueSlug(e.target.value)}
            >
              {venues.map((venue) => (
                <option key={venue.slug} value={venue.slug}>
                  {venue.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="auth-checkin">
              场地签到码
              {!checkinRequired && (
                <span className="ml-1 font-normal text-ink-400">（可留空）</span>
              )}
            </label>
            <input
              id="auth-checkin"
              className="field font-mono tracking-[0.3em]"
              value={checkinCode}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="6 位数字"
              onChange={(e) =>
                setCheckinCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))
              }
            />
            <p className="mt-1 text-xs text-ink-400">
              签到码展示在场地的排队处或群公告，每几分钟自动更换。
            </p>
          </div>
        </>
      )}

      {error && (
        <div className="rounded-md border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-600">
          {error}
        </div>
      )}

      <button className="btn-mint w-full" type="submit" disabled={busy || !canSubmit}>
        {mode === "login" ? (
          <KeyRound className="h-4 w-4" />
        ) : (
          <UserPlus className="h-4 w-4" />
        )}
        {busy ? "处理中…" : mode === "login" ? "登录" : "注册并登录"}
      </button>

      {!registrationEnabled && (
        <p className="text-center text-xs text-ink-400">
          当前未开放自助注册，请联系现场管理员。
        </p>
      )}
    </form>
  );
}
