import Link from "next/link";
import type { SessionUser } from "@/lib/types";
import { VENUE } from "@/lib/constants/venue";

export function AppShell({
  user,
  children,
}: {
  user: SessionUser | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-ink-100/80 bg-white/80 backdrop-blur-xl">
        <div className="page-wrap flex items-center justify-between gap-3 py-3.5">
          <Link href="/" className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-2xl bg-mint-500 text-sm font-bold text-white shadow-soft">
              VW
            </div>
            <div>
              <div className="font-display text-base font-semibold tracking-tight text-ink-900">
                VirtualWait
              </div>
              <div className="text-xs text-ink-500">{VENUE.name}</div>
            </div>
          </Link>

          <nav className="flex items-center gap-2 text-sm">
            <Link className="btn-ghost !px-3 !py-2" href="/me">
              我的
            </Link>
            {user ? (
              <div className="hidden items-center gap-2 sm:flex">
                <span className="max-w-[10rem] truncate text-ink-600">
                  {user.displayName}
                </span>
                {user.bound ? (
                  <span className="chip bg-mint-50 text-mint-700">
                    {user.showRatingPublic && typeof user.rating === "number"
                      ? `R${user.rating}`
                      : "已登录"}
                  </span>
                ) : (
                  <span className="chip bg-ink-50 text-ink-500">已登录</span>
                )}
              </div>
            ) : (
              <Link className="btn-primary !px-3 !py-2" href="/login">
                扫码登录
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="page-wrap py-6 sm:py-8">{children}</main>

      <footer className="page-wrap pb-8 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-5 text-xs text-ink-400">
          <span>VirtualWait · 舞萌二维码登录 · 单刷/拼机</span>
          <span>会话至当日 0:00 · 单 IP 单账号</span>
        </div>
      </footer>
    </div>
  );
}
