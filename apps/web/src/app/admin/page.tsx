import { AdminDashboard } from "@/components/AdminDashboard";
import { AdminLoginForm } from "@/components/AdminLoginForm";
import { hasAdminSession } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { listAdminActiveEntries, listAuditEvents } from "@/lib/queue/service";

export default async function AdminPage() {
  if (!(await hasAdminSession())) return <AdminLoginForm />;
  const queues = getDb().prepare(`SELECT id, name, slug, status FROM queue ORDER BY name`).all() as Array<{
    id: string;
    name: string;
    slug: string;
    status: "OPEN" | "PAUSED" | "CLOSED";
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
  return <AdminDashboard queues={queues.map((queue) => ({
    id: queue.id,
    name: queue.name,
    slug: queue.slug,
    status: queue.status,
  }))} events={events} entries={entries.map((entry) => ({
    id: entry.id,
    queueName: entry.queue_name,
    nickname: entry.nickname,
    status: entry.status,
    version: entry.version,
    isDuo: entry.play_mode === "DUO" || Boolean(entry.party_id),
  }))} />;
}
