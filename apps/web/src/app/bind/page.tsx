import { redirect } from "next/navigation";
import { QrBindForm } from "@/components/QrBindForm";
import { getSessionUser } from "@/lib/auth/session";

export default async function BindPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (
    <div className="mx-auto max-w-xl">
      <QrBindForm
        purpose="LOGIN_BIND"
        redirectTo="/me"
        title="扫码刷新资料"
      />
    </div>
  );
}
