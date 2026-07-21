import Link from "next/link";
import type { SessionUser } from "@/lib/types";

export function AppShell({
  user,
  children,
}: {
  user: SessionUser | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-ink-200 bg-white">
        <div className="page-wrap flex h-14 items-center justify-between gap-3">
          <Link href="/" className="flex min-w-0 items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-ink-950 text-xs font-bold text-white">
              VW
            </div>
            <div className="truncate text-sm font-semibold text-ink-950">
              VirtualWait
            </div>
          </Link>

          <nav className="flex items-center gap-2 text-sm">
            {user ? (
              <Link className="btn-primary" href="/me">
                我的
              </Link>
            ) : (
              <Link className="btn-primary" href="/login">
                扫码登录
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="page-wrap py-5 sm:py-6">{children}</main>
    </div>
  );
}
