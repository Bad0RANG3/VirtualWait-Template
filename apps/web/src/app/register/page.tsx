import Link from "next/link";

export default function RegisterPage() {
  return (
    <div className="mx-auto max-w-md panel p-4 sm:p-5">
      <h1 className="font-display text-2xl font-semibold text-ink-950">
        扫码登录
      </h1>
      <Link className="btn-mint mt-4 inline-flex" href="/login">
        去登录
      </Link>
    </div>
  );
}
