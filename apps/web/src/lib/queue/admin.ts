import { getDb, nowIso } from "../db";
import type { EntryStatus, PlayMode } from "../types";
import {
  activeMembers,
  audit,
  finishOrExpireEntry,
  getParty,
  requeueToEnd,
  startEntries,
} from "./core";
import { processTimeouts } from "./timeouts";

export function setQueueStatus(
  queueId: string,
  status: "OPEN" | "PAUSED" | "CLOSED",
  adminId: string,
) {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM queue WHERE id = ?`).get(queueId) as
    | { id: string }
    | undefined;
  if (!existing) throw new Error("QUEUE_NOT_FOUND");
  db.prepare(`UPDATE queue SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    nowIso(),
    queueId,
  );
  audit("QUEUE_STATUS_CHANGED", "queue", queueId, "ADMIN", adminId, { status });
}

export function listAuditEvents(limit = 100) {
  const capped = Math.max(1, Math.min(limit, 200));
  return getDb()
    .prepare(
      `SELECT id, actor_type, action, resource_type, resource_id, metadata, request_id, created_at
       FROM audit_event ORDER BY created_at DESC LIMIT ?`,
    )
    .all(capped) as Array<{
    id: string;
    actor_type: string;
    action: string;
    resource_type: string;
    resource_id: string;
    metadata: string;
    request_id: string;
    created_at: string;
  }>;
}

export function listAdminActiveEntries() {
  return getDb()
    .prepare(
      `SELECT e.id, q.name AS queue_name, v.name AS venue_name, u.nickname,
              e.status, e.version, e.play_mode, e.party_id
       FROM queue_entry e
       JOIN queue q ON q.id = e.queue_id
       JOIN venue v ON v.id = q.venue_id
       JOIN app_user u ON u.id = e.user_id
       WHERE e.status IN ('WAITING','PLAYING')
       ORDER BY v.name, q.name, e.sequence_number`,
    )
    .all() as Array<{
    id: string;
    queue_name: string;
    venue_name: string;
    nickname: string;
    status: "WAITING" | "PLAYING";
    version: number;
    play_mode: PlayMode;
    party_id: string | null;
  }>;
}

export type AdminEntryAction = "START" | "REQUEUE" | "CANCEL" | "FINISH";

/** Manual queue operation without a call/confirmation stage. */
export function adminEntryAction(
  entryId: string,
  expectedVersion: number,
  action: AdminEntryAction,
  adminId: string,
) {
  const db = getDb();
  const entry = db
    .prepare(
      `SELECT id, queue_id, party_id, play_mode, status, version
       FROM queue_entry WHERE id = ?`,
    )
    .get(entryId) as
    | {
        id: string;
        queue_id: string;
        party_id: string | null;
        play_mode: PlayMode;
        status: EntryStatus;
        version: number;
      }
    | undefined;
  if (!entry) throw new Error("ENTRY_NOT_FOUND");
  if (entry.version !== expectedVersion) throw new Error("ENTRY_VERSION_CONFLICT");

  const members = activeMembers(entry);
  const isDuo = entry.play_mode === "DUO" && Boolean(entry.party_id);
  if (isDuo && members.length !== 2) throw new Error("ADMIN_ACTION_NOT_ALLOWED");
  const allStatus = (status: EntryStatus) => members.every((member) => member.status === status);

  if (action === "START") {
    if (!allStatus("WAITING")) throw new Error("ADMIN_ACTION_NOT_ALLOWED");
    if (isDuo && getParty(entry.party_id)?.status !== "CONFIRMED") {
      throw new Error("ADMIN_ACTION_NOT_ALLOWED");
    }
    const busy = db
      .prepare(`SELECT id FROM queue_entry WHERE queue_id = ? AND status = 'PLAYING' LIMIT 1`)
      .get(entry.queue_id) as { id: string } | undefined;
    if (busy) throw new Error("ADMIN_ACTION_NOT_ALLOWED");
  } else if (action === "REQUEUE") {
    if (!allStatus(entry.status) || !["WAITING", "PLAYING"].includes(entry.status)) {
      throw new Error("ADMIN_ACTION_NOT_ALLOWED");
    }
  } else if (action === "CANCEL") {
    if (!allStatus("WAITING")) throw new Error("ADMIN_ACTION_NOT_ALLOWED");
  } else if (!allStatus("PLAYING")) {
    throw new Error("ADMIN_ACTION_NOT_ALLOWED");
  }

  const claim = db
    .prepare(
      `UPDATE queue_entry SET version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(nowIso(), entry.id, expectedVersion) as { changes?: number };
  if (claim.changes !== 1) throw new Error("ENTRY_VERSION_CONFLICT");

  if (action === "START") {
    startEntries(
      entry.queue_id,
      members.map((member) => member.id),
      "ADMIN",
      adminId,
      "admin_start",
    );
  } else if (action === "REQUEUE") {
    if (!requeueToEnd(entry.queue_id, entry.id, [entry.status])) {
      throw new Error("ADMIN_ACTION_NOT_ALLOWED");
    }
  } else if (action === "CANCEL") {
    for (const member of members) {
      finishOrExpireEntry(member.id, "CANCELLED", "ADMIN", adminId, "admin_cancel");
    }
    if (isDuo) {
      db.prepare(`UPDATE queue_party SET status = 'DISBANDED', updated_at = ? WHERE id = ?`).run(
        nowIso(),
        entry.party_id,
      );
    }
  } else {
    for (const member of members) {
      finishOrExpireEntry(member.id, "DONE", "ADMIN", adminId, "admin_finish");
    }
  }

  audit("ENTRY_ADMIN_ACTION", "queue_entry", entry.id, "ADMIN", adminId, {
    action,
    expectedVersion,
    partyId: entry.party_id,
  });
  processTimeouts(entry.queue_id);
}
