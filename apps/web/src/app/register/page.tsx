import Link from "next/link";

export default function RegisterPage() {
  return (
    <div className="mx-auto max-w-xl panel p-6 sm:p-7">
      <div className="section-label">LOGIN</div>
      <h1 className="mt-3 font-display text-3xl font-semibold text-ink-900">
        请使用舞萌二维码登录
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-ink-500">
        账号注册已关闭。每次使用均通过舞萌二维码登录，本机会话保存至当天 0:00。
      </p>
      <Link className="btn-mint mt-6 inline-flex" href="/login">
        去扫码登录
      </Link>
    </div>
  );
}
