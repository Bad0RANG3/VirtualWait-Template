import { AuthPanel } from "@/components/AuthPanel";
import { getSessionUser } from "@/lib/auth/session";
import { ALL_VENUES } from "@/lib/constants/catalog";
import { env } from "@/lib/env";
import { redirect } from "next/navigation";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/");

  const venues = ALL_VENUES.map((venue) => ({
    slug: venue.slug,
    label: venue.regionName ? `${venue.regionName} · ${venue.name}` : venue.name,
  }));

  return (
    <div className="mx-auto max-w-xl">
      <AuthPanel
        venues={venues}
        registrationEnabled={env.registrationEnabled}
        checkinRequired={env.checkinRequired}
      />
    </div>
  );
}
