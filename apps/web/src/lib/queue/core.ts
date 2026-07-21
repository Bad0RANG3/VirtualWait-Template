import { randomUUID } from "crypto";
import { getDb, nowIso } from "../db";
import type { EntryStatus, PartyStatus, PlayMode } from "../types";

export type EntryRow = {
  id: string;
  queue_id: string;
  user_id: string;
  party_id: string | null;
  play_mode: PlayMode;
  sequence_number: number;
  status: EntryStatus;
  version: number;
  joined_at: string;
  playing_at: string | null;
  head_eligible_at: string | null;
  head_miss_count: number;
  nickname: string;
  rating: number | null;
  show_rating_public: number;
  title: string | null;
  icon_url: string | null;
  sdgb_identity_hash: string | null;
};

export type PartyRow = {
  id: string;
  queue_id: string;
  play_mode: PlayMode;
  status: PartyStatus;
  host_user_id: string;
  guest_user_id: string | null;
  host_confirmed: number;
  guest_confirmed: number;
  created_at: string;
  updated_at: string;
};

export type QueueBySlug = {
  id: string;
  name: string;
  slug: string;
  status: "OPEN" | "PAUSED" | "CLOSED";
  coin_cost?: number | null;
  updated_at: string;
  venue_name: string;
  venue_slug: string;
};

export function audit(
  action: string,
  resourceType: string,
  resourceId: string,
  actorType: string,
  actorId: string | null,
  metadata: Record<string, unknown> = {},
) {
  getDb()
    .prepare(
      `INSERT INTO audit_event
       (id, actor_type, actor_id, action, resource_type, resource_id, metadata, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      actorType,
      actorId,
      action,
      resourceType,
      resourceId,
      JSON.stringify(metadata),
      randomUUID(),
      nowIso(),
    );
}

export function getParty(partyId: string | null): PartyRow | null {
  if (!partyId) return null;
  return (
    (getDb().prepare(`SELECT * FROM queue_party WHERE id = ?`).get(partyId) as
      | PartyRow
      | undefined) || null
  );
}

export function activeMembers(entry: {
  id: string;
  queue_id: string;
  party_id: string | null;
  play_mode: PlayMode;
  status: EntryStatus;
}) {
  const db = getDb();
  if (entry.play_mode !== "DUO" || !entry.party_id) {
    return [{ id: entry.id, status: entry.status }];
  }
  return db
    .prepare(
      `SELECT id, status FROM queue_entry
       WHERE queue_id = ? AND party_id = ? AND status IN ('WAITING','PLAYING')
       ORDER BY sequence_number ASC`,
    )
    .all(entry.queue_id, entry.party_id) as Array<{ id: string; status: EntryStatus }>;
}

export function startEntries(
  queueId: string,
  entryIds: string[],
  actorType: "ADMIN" | "USER",
  actorId: string,
  reason: string,
) {
  const db = getDb();
  const now = nowIso();
  for (const id of entryIds) {
    db.prepare(
      `UPDATE queue_entry
       SET status = 'PLAYING', playing_at = ?, head_eligible_at = NULL,
           updated_at = ?, version = version + 1
       WHERE id = ? AND status = 'WAITING'`,
    ).run(now, now, id);
    audit("ENTRY_STARTED", "queue_entry", id, actorType, actorId, { reason });
  }
  db.prepare(`UPDATE queue SET updated_at = ? WHERE id = ?`).run(now, queueId);
}

export function getQueueBySlug(venueSlug: string, machineSlug: string) {
  return getDb()
    .prepare(
      `SELECT q.*, v.name as venue_name, v.slug as venue_slug
       FROM queue q JOIN venue v ON v.id = q.venue_id
       WHERE v.slug = ? AND q.slug = ?`,
    )
    .get(venueSlug, machineSlug) as QueueBySlug | undefined;
}

export function listActiveEntries(queueId: string): EntryRow[] {
  return getDb()
    .prepare(
      `SELECT e.*, u.nickname, u.rating, u.show_rating_public, u.title, u.icon_url, u.sdgb_identity_hash
       FROM queue_entry e JOIN app_user u ON u.id = e.user_id
       WHERE e.queue_id = ? AND e.status IN ('WAITING','PLAYING')
       ORDER BY CASE e.status WHEN 'PLAYING' THEN 0 ELSE 1 END, e.sequence_number ASC`,
    )
    .all(queueId) as EntryRow[];
}

export function requeueToEnd(
  queueId: string,
  entryId: string,
  allowedStatuses: EntryStatus[],
) {
  const db = getDb();
  const placeholders = allowedStatuses.map(() => "?").join(",");
  const target = db
    .prepare(
      `SELECT id, party_id, play_mode FROM queue_entry
       WHERE id = ? AND queue_id = ? AND status IN (${placeholders})`,
    )
    .get(entryId, queueId, ...allowedStatuses) as
    | { id: string; party_id: string | null; play_mode: PlayMode }
    | undefined;
  if (!target) return false;
  const ids =
    target.party_id && target.play_mode === "DUO"
      ? (
          db
            .prepare(
              `SELECT id FROM queue_entry
               WHERE queue_id = ? AND party_id = ? AND status IN (${placeholders})`,
            )
            .all(queueId, target.party_id, ...allowedStatuses) as Array<{ id: string }>
        ).map((row) => row.id)
      : [target.id];
  const queue = db
    .prepare(`SELECT next_sequence FROM queue WHERE id = ?`)
    .get(queueId) as { next_sequence: number };
  const now = nowIso();
  let sequence = queue.next_sequence;
  for (const id of ids) {
    db.prepare(
      `UPDATE queue_entry
       SET sequence_number = ?, status = 'WAITING', playing_at = NULL,
           finished_at = NULL, cancelled_at = NULL,
           head_eligible_at = NULL, head_miss_count = 0,
           updated_at = ?, version = version + 1
       WHERE id = ?`,
    ).run(sequence++, now, id);
  }
  db.prepare(`UPDATE queue SET next_sequence = ?, updated_at = ? WHERE id = ?`).run(
    sequence,
    now,
    queueId,
  );
  return true;
}

export function finishOrExpireEntry(
  entryId: string,
  status: "DONE" | "EXPIRED" | "CANCELLED",
  actorType: string,
  actorId: string | null,
  reason?: string,
) {
  const now = nowIso();
  if (status === "CANCELLED") {
    getDb()
      .prepare(
        `UPDATE queue_entry
         SET status = 'CANCELLED', cancelled_at = ?, finished_at = ?, updated_at = ?,
             version = version + 1
         WHERE id = ?`,
      )
      .run(now, now, now, entryId);
  } else {
    getDb()
      .prepare(
        `UPDATE queue_entry
         SET status = ?, finished_at = ?, updated_at = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(status, now, now, entryId);
  }
  audit(
    status === "EXPIRED"
      ? "ENTRY_EXPIRED"
      : status === "CANCELLED"
        ? "ENTRY_CANCELLED"
        : "ENTRY_DONE",
    "queue_entry",
    entryId,
    actorType,
    actorId,
    reason ? { reason } : {},
  );
}
