import { notFound } from "next/navigation";
import { QueueBoard } from "@/components/QueueBoard";
import { getSessionUser } from "@/lib/auth/session";
import { machineBySlug, venueBySlug } from "@/lib/constants/catalog";
import { getPublicQueue } from "@/lib/queue/service";

export default async function QueuePage({
  params,
}: {
  params: Promise<{ venueSlug: string; machineSlug: string }>;
}) {
  const { venueSlug, machineSlug } = await params;
  const venue = venueBySlug(venueSlug);
  if (!venue) notFound();
  const machine = machineBySlug(venueSlug, machineSlug);
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
