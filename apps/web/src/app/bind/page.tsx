import { redirect } from "next/navigation";
import { QrBindForm } from "@/components/QrBindForm";
import { getSessionUser } from "@/lib/auth/session";
import Link from "next/link";

export default async function BindPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
      <div className="panel p-6 sm:p-7">
        <div className="section-label">REFRESH</div>
        <h1 className="mt-3 font-display text-3xl font-semibold text-ink-900">
          刷新舞萌资料
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-500">
          当前账号：
          <span className="font-medium text-ink-800">{user.nickname}</span>
        </p>
        <div className="mt-5 space-y-3 text-sm leading-relaxed text-ink-500">
          <p>登录时已通过二维码识别 userid。此处可再次扫码刷新 Rating / 称号。</p>
          <p>系统不会保存原始二维码，也不会把明文 SDGB userID 返回给浏览器。</p>
          <p>刷新时的二维码必须属于当前账号，否则会失败。</p>
        </div>
        <Link className="btn-ghost mt-6" href="/">
          返回首页
        </Link>
      </div>
      <QrBindForm
        purpose="LOGIN_BIND"
        redirectTo="/me"
        title="扫码刷新资料"
      />
    </div>
  );
}
