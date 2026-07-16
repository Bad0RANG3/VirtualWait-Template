import Link from "next/link";
import {
  isVenueOpenAt,
  MACHINES,
  VENUE,
  VENUE_HOURS,
  queuePath,
} from "@/lib/constants/venue";
import { getSessionUser } from "@/lib/auth/session";
import { getPublicQueue } from "@/lib/queue/service";
import {
  ArrowRight,
  Gamepad2,
  QrCode,
  ShieldCheck,
  Users,
  Vote,
} from "lucide-react";

export default async function HomePage() {
  const user = await getSessionUser();
  const boards = MACHINES.map((m) => {
    const snap = getPublicQueue(VENUE.slug, m.slug, user?.id);
    return { machine: m, count: snap?.entries.length ?? 0, status: snap?.queue.status };
  });
  const total = boards.reduce((sum, b) => sum + b.count, 0);
  const withinHours = isVenueOpenAt();
  const queueStatusLabel = withinHours ? "开放中" : "未到开放时间";

  return (
    <div className="space-y-8">
      <section className="panel overflow-hidden">
        <div className="relative px-6 py-8 sm:px-8 sm:py-10 lg:px-10 lg:py-12">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 top-0 h-56 w-56 rounded-full bg-mint-200/50 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-10 bottom-0 h-40 w-40 rounded-full bg-sky-200/40 blur-3xl"
          />

          <div className="relative grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
            <div className="max-w-2xl">
              <div className="section-label">
                <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-mint-500" />
                {VENUE.name}
              </div>
              <h1 className="mt-4 font-display text-4xl font-semibold leading-tight tracking-tight text-ink-900 sm:text-5xl">
                舞萌二维码登录
                <span className="block text-mint-600">单刷 / 拼机排卡</span>
              </h1>
              <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-500 sm:text-lg">
                扫码登录后即可在多个机台排卡，并按需展示公开资料。排卡前选择单刷或拼机；拼机需双方确认。会话仅本机保存，过 0:00 自动失效。
              </p>

              <div className="mt-6 flex flex-wrap gap-2.5">
                {!user && (
                  <>
                    <Link className="btn-mint" href="/login">
                      扫码登录
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                    <Link className="btn-ghost" href={queuePath("new")}>
                      先看新机队列
                    </Link>
                  </>
                )}
                {user && (
                  <>
                    <Link className="btn-mint" href={queuePath("new")}>
                      <Gamepad2 className="h-4 w-4" />
                      去新机排卡
                    </Link>
                    <Link className="btn-ghost" href={queuePath("old")}>
                      去旧机
                    </Link>
                    {user.bound && (
                      <Link className="btn-ghost" href="/bind">
                        <QrCode className="h-4 w-4" />
                        刷新资料
                      </Link>
                    )}
                    <Link className="btn-ghost" href="/me">
                      我的
                    </Link>
                  </>
                )}
              </div>

              <div className="mt-8 grid grid-cols-3 gap-3 sm:max-w-md">
                <div className="stat-tile">
                  <div className="text-xs text-ink-400">在列</div>
                  <div className="mt-1 font-display text-2xl font-semibold text-ink-900">
                    {total}
                  </div>
                </div>
                <div className="stat-tile">
                  <div className="text-xs text-ink-400">机台</div>
                  <div className="mt-1 font-display text-2xl font-semibold text-ink-900">
                    {MACHINES.length}
                  </div>
                </div>
                <div className="stat-tile">
                  <div className="text-xs text-ink-400">
                    {VENUE_HOURS.label}
                  </div>
                  <div className="mt-1 font-display text-lg font-semibold text-mint-600">
                    {queueStatusLabel}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-3">
              {boards.map(({ machine, count, status }) => {
                const isCoral = machine.accent === "coral";
                return (
                  <Link
                    key={machine.id}
                    href={queuePath(machine.slug)}
                    className="group rounded-2xl border border-ink-100 bg-ink-50/70 p-4 transition hover:border-mint-200 hover:bg-white hover:shadow-soft"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-display text-xl font-semibold text-ink-900">
                          {machine.name}
                        </div>
                        <div className="mt-0.5 text-sm text-ink-500">
                          {machine.subtitle}
                        </div>
                      </div>
                      <div
                        className={`grid h-12 w-12 place-items-center rounded-2xl text-sm font-bold ${
                          isCoral
                            ? "bg-coral-50 text-coral-600"
                            : "bg-mint-50 text-mint-600"
                        }`}
                      >
                        {count}
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-xs text-ink-400">
                      <span>
                        {status === "OPEN" ? queueStatusLabel : status || "—"}
                      </span>
                      <span className="font-medium text-ink-600 group-hover:text-mint-600">
                        进入队列 →
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {boards.map(({ machine, count, status }) => {
          const isCoral = machine.accent === "coral";
          return (
            <Link
              key={machine.id}
              href={queuePath(machine.slug)}
              className="panel group p-6 transition hover:-translate-y-0.5 hover:shadow-lift"
            >
              <div
                className={`mb-5 h-1.5 w-20 rounded-full bg-gradient-to-r ${
                  isCoral
                    ? "from-coral-400 to-sun-300"
                    : "from-mint-400 to-sky-400"
                }`}
              />
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="section-label">{machine.subtitle}</div>
                  <h2 className="mt-3 font-display text-3xl font-semibold text-ink-900">
                    {machine.name}
                  </h2>
                  <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-500">
                    {isCoral
                      ? "可按场地规则调整队列模式、超时与取消策略。"
                      : "可按场地规则调整队列模式、超时与取消策略。"}
                  </p>
                </div>
                <div
                  className={`rounded-2xl px-3 py-2 text-right ${
                    isCoral ? "bg-coral-50" : "bg-mint-50"
                  }`}
                >
                  <div className="text-xs text-ink-400">在列</div>
                  <div
                    className={`font-display text-2xl font-semibold ${
                      isCoral ? "text-coral-600" : "text-mint-600"
                    }`}
                  >
                    {count}
                  </div>
                </div>
              </div>
              <div className="mt-8 flex items-center justify-between text-sm">
                <span className="inline-flex items-center gap-2 text-ink-500">
                  <Users className="h-4 w-4" />
                  {status === "OPEN" ? queueStatusLabel : status || "—"}
                </span>
                <span className="inline-flex items-center gap-1 font-semibold text-ink-800 group-hover:text-mint-600">
                  打开看板
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                </span>
              </div>
            </Link>
          );
        })}
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {[
          {
            icon: Users,
            title: "扫码登录",
            body: "使用一次性二维码进入场地；模板默认只展示经允许的公开资料。",
          },
          {
            icon: Gamepad2,
            title: "单刷 / 拼机",
            body: "排卡前选择模式。拼机需双方确认后才会作为一组开始游玩。",
          },
          {
            icon: Vote,
            title: "队列管理",
            body: "管理员可开始游玩、调整顺序、取消记录或结束游玩。",
          },
        ].map(({ icon: Icon, title, body }) => (
          <div key={title} className="panel p-5">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-mint-50 text-mint-600">
              <Icon className="h-5 w-5" />
            </div>
            <h3 className="mt-4 font-display text-lg font-semibold text-ink-900">
              {title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-500">{body}</p>
          </div>
        ))}
      </section>

      <section className="panel overflow-hidden">
        <div className="grid gap-0 md:grid-cols-[1.1fr_0.9fr]">
          <div className="p-6 sm:p-7">
            <div className="section-label">
              <ShieldCheck className="mr-1.5 h-3.5 w-3.5 text-mint-600" />
              现场规则摘要
            </div>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-ink-600">
              <li className="flex gap-3">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-mint-500" />
                扫码登录即可排卡；身份资料可按场地规则选择是否展示。
              </li>
              <li className="flex gap-3">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-coral-400" />
                排卡前选择单刷或拼机；拼机需双方确认后才可作为一组游玩。
              </li>
              <li className="flex gap-3">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sun-400" />
                游玩超时会自动回到队尾；结束后由管理员开始下一组游玩。
              </li>
              <li className="flex gap-3">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                同一用户同一时间只能在一台机上活动排队。
              </li>
            </ul>
          </div>
          <div className="border-t border-ink-100 bg-ink-50/60 p-6 sm:border-l sm:border-t-0 sm:p-7">
            <h3 className="font-display text-xl font-semibold text-ink-900">
              今天就这样上场
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-500">
              扫码登录后直接选机。看板实时刷新，单刷、拼机、确认与卸卡都在同一机台页完成。
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link
                className="btn-primary"
                href={user ? queuePath("old") : "/login"}
              >
                {user ? "去旧机排卡" : "扫码登录"}
              </Link>
              <Link className="btn-ghost" href={user ? "/bind" : queuePath("new")}>
                {user ? "刷新资料" : "先看队列"}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
