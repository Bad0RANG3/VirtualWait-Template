import { AdminDashboard } from "@/components/AdminDashboard";
import { AdminLoginForm } from "@/components/AdminLoginForm";
import { hasAdminSession } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { listAdminActiveEntries, listAuditEvents } from "@/lib/queue/service";
import { getQueueTimeouts, listMachinesMeta, listVenueMeta } from "@/lib/settings";

export default async function AdminPage() {
  if (!(await hasAdminSession())) return <AdminLoginForm />;
  const queues = getDb()
    .prepare(
      `SELECT q.id, q.name, q.slug, q.status, v.name AS venue_name
       FROM queue q
       JOIN venue v ON v.id = q.venue_id
       ORDER BY v.name, q.name`,
    )
    .all() as Array<{
    id: string;
    name: string;
    slug: string;
    status: "OPEN" | "PAUSED" | "CLOSED";
    venue_name: string;
  }>;
  const events = listAuditEvents(50).map((event) => ({
    id: event.id,
    action: event.action,
    resourceType: event.resource_type,
    resourceId: event.resource_id,
    metadata: JSON.parse(event.metadata) as unknown,
    createdAt: event.created_at,
  }));
  const entries = listAdminActiveEntries();
  const timeouts = getQueueTimeouts();
  const venues = listVenueMeta();
  const machines = listMachinesMeta();
  return (
    <AdminDashboard
      timeouts={timeouts}
      venues={venues}
      machines={machines}
      queues={queues.map((queue) => ({
        id: queue.id,
        name: queue.name,
        slug: queue.slug,
        status: queue.status,
        venueName: queue.venue_name,
      }))}
      events={events}
      entries={entries.map((entry) => ({
        id: entry.id,
        queueName: entry.queue_name,
        venueName: entry.venue_name,
        nickname: entry.nickname,
        status: entry.status,
        version: entry.version,
        isDuo: entry.play_mode === "DUO" || Boolean(entry.party_id),
      }))}
    />
  );
}
