import { QrLoginForm } from "@/components/QrLoginForm";
import { getSessionUser } from "@/lib/auth/session";
import Link from "next/link";
import { redirect } from "next/navigation";
import { QrCode, ShieldCheck } from "lucide-react";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/");

  return (
    <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-2">
      <QrLoginForm />
      <div className="panel p-6 sm:p-7">
        <div className="section-label">
          <QrCode className="mr-1.5 h-3.5 w-3.5 text-mint-600" />
          登录说明
        </div>
        <h2 className="mt-3 font-display text-2xl font-semibold text-ink-900">
          每次用舞萌二维码进入
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-500">
          扫码后拿到 userid，即可在本站排卡，并在“我的页面”选择是否展示 Rating。
          Cookie 仅本机保存，过了当天 0:00 自动失效，次日需重新扫码。
        </p>
        <div className="mt-5 space-y-3">
          <div className="flex items-start gap-3 rounded-2xl border border-ink-100 bg-ink-50/70 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-mint-600" />
            <p className="text-sm leading-relaxed text-ink-500">
              单个 IP 当天只能绑定一个舞萌账号，并限制并发与频率，降低恶意刷接口风险。
            </p>
          </div>
          <div className="rounded-2xl border border-ink-100 bg-ink-50/70 p-4 text-sm leading-relaxed text-ink-500">
            原始二维码不会落库；明文 userID 不会返回给浏览器。
          </div>
        </div>
        <p className="mt-4 text-sm text-ink-400">
          已登录可前往{" "}
          <Link className="text-mint-600 underline underline-offset-4" href="/">
            首页选机
          </Link>
        </p>
      </div>
    </div>
  );
}
