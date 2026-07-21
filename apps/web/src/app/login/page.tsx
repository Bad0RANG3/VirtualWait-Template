import { QrLoginForm } from "@/components/QrLoginForm";
import { getSessionUser } from "@/lib/auth/session";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/");

  return (
    <div className="mx-auto max-w-xl">
      <QrLoginForm />
    </div>
  );
}
