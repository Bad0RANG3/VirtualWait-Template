import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { getUserActiveEntries } from "@/lib/queue/service";
import { queuePath } from "@/lib/constants/venue";
import { LogoutButton } from "@/components/LogoutButton";
import { ProfileSettingsForm } from "@/components/ProfileSettingsForm";
import { Gamepad2, QrCode, UserRound } from "lucide-react";

export default async function MePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const entries = getUserActiveEntries(user.id);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <section className="panel p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="grid h-14 w-14 place-items-center overflow-hidden rounded-2xl bg-mint-50 text-mint-600">
              {user.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <UserRound className="h-7 w-7" />
              )}
            </div>
            <div>
              <div className="section-label">MAIMAI</div>
              <h1 className="mt-2 font-display text-3xl font-semibold text-ink-900">
                {user.displayName}
              </h1>
              <p className="mt-1 text-sm text-ink-400">
                舞萌二维码登录 · 会话当日有效
              </p>
              <div className="mt-4 flex flex-wrap gap-2 text-sm">
                {user.bound ? (
                  <span className="chip bg-mint-50 text-mint-700">舞萌已识别</span>
                ) : (
                  <span className="chip bg-sun-50 text-sun-500">资料未刷新</span>
                )}
                {user.bound &&
                  user.showRatingPublic &&
                  typeof user.rating === "number" && (
                    <span className="chip bg-ink-50 text-ink-700">
                      Rating {user.rating}
                    </span>
                  )}
                {user.bound && !user.showRatingPublic && (
                  <span className="chip bg-ink-50 text-ink-500">
                    Rating 已隐藏
                  </span>
                )}
                {user.bound && user.title && (
                  <span className="chip bg-ink-50 text-ink-700">{user.title}</span>
                )}
              </div>
            </div>
          </div>
          <LogoutButton />
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link className="btn-ghost" href="/bind">
            <QrCode className="h-4 w-4" />
            刷新舞萌资料
          </Link>
          <Link className="btn-primary" href="/">
            <Gamepad2 className="h-4 w-4" />
            去选机排队
          </Link>
        </div>
      </section>

      <ProfileSettingsForm user={user} />

      <section className="panel p-6 sm:p-7">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold text-ink-900">当前排队</h2>
          <span className="text-sm text-ink-400">{entries.length} 条</span>
        </div>
        {entries.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-ink-200 bg-ink-50/50 px-4 py-8 text-center text-sm text-ink-400">
            你当前没有活动中的排队记录。
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {entries.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between gap-3 rounded-2xl border border-ink-100 bg-ink-50/40 px-4 py-3.5"
              >
                <div>
                  <div className="font-medium text-ink-900">
                    {e.queue_name} · #{e.sequence_number}
                    {e.play_mode === "DUO" ? " · 拼机" : " · 单刷"}
                  </div>
                  <div className="mt-1 text-sm text-ink-500">{e.status}</div>
                </div>
                <Link className="btn-ghost !py-2" href={queuePath(e.queue_slug)}>
                  打开
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
