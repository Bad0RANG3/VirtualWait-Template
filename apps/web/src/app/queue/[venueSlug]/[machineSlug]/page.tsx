import { notFound } from "next/navigation";
import { QueueBoard } from "@/components/QueueBoard";
import { getSessionUser } from "@/lib/auth/session";
import { machineBySlug, VENUE } from "@/lib/constants/venue";
import { getPublicQueue } from "@/lib/queue/service";

export default async function QueuePage({
  params,
}: {
  params: Promise<{ venueSlug: string; machineSlug: string }>;
}) {
  const { venueSlug, machineSlug } = await params;
  if (venueSlug !== VENUE.slug) notFound();
  const machine = machineBySlug(machineSlug);
  if (!machine) notFound();

  const user = await getSessionUser();
  const snapshot = getPublicQueue(venueSlug, machineSlug, user?.id);
  if (!snapshot) notFound();

  return (
    <QueueBoard
      venueSlug={venueSlug}
      machineSlug={machineSlug}
      machineName={machine.name}
      accent={machine.accent}
      initial={snapshot}
      user={user}
    />
  );
}
