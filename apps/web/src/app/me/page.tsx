import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { getUserActiveEntries } from "@/lib/queue/service";
import { queuePath } from "@/lib/constants/catalog";
import { LogoutButton } from "@/components/LogoutButton";
import { ProfileSettingsForm } from "@/components/ProfileSettingsForm";
import { Gamepad2, QrCode, UserRound } from "lucide-react";

export default async function MePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const entries = getUserActiveEntries(user.id);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <section className="panel p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="grid h-12 w-12 place-items-center overflow-hidden rounded-md border border-ink-200 bg-ink-50 text-ink-600">
              {user.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <UserRound className="h-6 w-6" />
              )}
            </div>
            <div>
              <h1 className="font-display text-2xl font-semibold text-ink-950">
                {user.displayName}
              </h1>
              <div className="mt-2 flex flex-wrap gap-1.5 text-sm">
                {user.bound ? (
                  <span className="chip bg-mint-50 text-mint-700">已绑定</span>
                ) : (
                  <span className="chip bg-sun-50 text-sun-500">未绑定</span>
                )}
                {user.bound &&
                  user.showRatingPublic &&
                  typeof user.rating === "number" && (
                    <span className="chip bg-ink-50 text-ink-700">
                      R{user.rating}
                    </span>
                  )}
                {user.bound && !user.showRatingPublic && (
                  <span className="chip bg-ink-50 text-ink-500">R 隐藏</span>
                )}
                {user.bound && user.title && (
                  <span className="chip bg-ink-50 text-ink-700">{user.title}</span>
                )}
              </div>
            </div>
          </div>
          <LogoutButton />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link className="btn-ghost" href="/bind">
            <QrCode className="h-4 w-4" />
            刷新
          </Link>
          <Link className="btn-primary" href="/">
            <Gamepad2 className="h-4 w-4" />
            排队
          </Link>
        </div>
      </section>

      <ProfileSettingsForm user={user} />

      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-900">排队</h2>
          <span className="text-xs text-ink-400">{entries.length}</span>
        </div>
        {entries.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-ink-400">
            暂无
          </div>
        ) : (
          <ul>
            {entries.map((e) => (
              <li key={e.id} className="list-row">
                <div className="min-w-0">
                  <div className="truncate font-medium text-ink-900">
                    {e.queue_name} · #{e.sequence_number}
                    {e.play_mode === "DUO" ? " · 拼机" : " · 单刷"}
                  </div>
                  <div className="mt-0.5 text-sm text-ink-500">{e.status}</div>
                </div>
                <Link className="btn-ghost !py-1.5" href={queuePath(e.venue_slug, e.queue_slug)}>
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
