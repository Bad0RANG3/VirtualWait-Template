import { randomUUID } from "crypto";
import { addSeconds, getDb, nowIso } from "../db";
import { env } from "../env";
import { isVenueOpenAt, VENUE } from "../constants/venue";
import type {
  EntryStatus,
  PartyStatus,
  PartyView,
  PlayMode,
  PublicQueueSnapshot,
  QueueEntryView,
  QueueSlotView,
} from "../types";

type EntryRow = {
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
  nickname: string;
  rating: number | null;
  show_rating_public: number;
  title: string | null;
  icon_url: string | null;
  sdgb_identity_hash: string | null;
};

type PartyRow = {
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

function audit(
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
      `SELECT e.id, q.name AS queue_name, u.nickname, e.status, e.version,
              e.play_mode, e.party_id
       FROM queue_entry e
       JOIN queue q ON q.id = e.queue_id
       JOIN app_user u ON u.id = e.user_id
       WHERE e.status IN ('WAITING','PLAYING')
       ORDER BY q.name, e.sequence_number`,
    )
    .all() as Array<{
    id: string;
    queue_name: string;
    nickname: string;
    status: "WAITING" | "PLAYING";
    version: number;
    play_mode: PlayMode;
    party_id: string | null;
  }>;
}

export type AdminEntryAction = "START" | "REQUEUE" | "CANCEL" | "FINISH";

function getParty(partyId: string | null): PartyRow | null {
  if (!partyId) return null;
  return (getDb().prepare(`SELECT * FROM queue_party WHERE id = ?`).get(partyId) as PartyRow | undefined) || null;
}

function activeMembers(entry: {
  id: string;
  queue_id: string;
  party_id: string | null;
  play_mode: PlayMode;
  status: EntryStatus;
}) {
  const db = getDb();
  if (entry.play_mode !== "DUO" || !entry.party_id) return [{ id: entry.id, status: entry.status }];
  return db
    .prepare(
      `SELECT id, status FROM queue_entry
       WHERE queue_id = ? AND party_id = ? AND status IN ('WAITING','PLAYING')
       ORDER BY sequence_number ASC`,
    )
    .all(entry.queue_id, entry.party_id) as Array<{ id: string; status: EntryStatus }>;
}

function startEntries(queueId: string, entryIds: string[], adminId: string) {
  const db = getDb();
  const now = nowIso();
  for (const id of entryIds) {
    db.prepare(
      `UPDATE queue_entry
       SET status = 'PLAYING', playing_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND status = 'WAITING'`,
    ).run(now, now, id);
    audit("ENTRY_STARTED", "queue_entry", id, "ADMIN", adminId, { reason: "admin_start" });
  }
  db.prepare(`UPDATE queue SET updated_at = ? WHERE id = ?`).run(now, queueId);
}

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
    startEntries(entry.queue_id, members.map((member) => member.id), adminId);
  } else if (action === "REQUEUE") {
    if (!requeueToEnd(entry.queue_id, entry.id, [entry.status])) {
      throw new Error("ADMIN_ACTION_NOT_ALLOWED");
    }
  } else if (action === "CANCEL") {
    for (const member of members) finishOrExpireEntry(member.id, "CANCELLED", "ADMIN", adminId, "admin_cancel");
    if (isDuo) {
      db.prepare(`UPDATE queue_party SET status = 'DISBANDED', updated_at = ? WHERE id = ?`).run(nowIso(), entry.party_id);
    }
  } else {
    for (const member of members) finishOrExpireEntry(member.id, "DONE", "ADMIN", adminId, "admin_finish");
  }

  audit("ENTRY_ADMIN_ACTION", "queue_entry", entry.id, "ADMIN", adminId, {
    action,
    expectedVersion,
    partyId: entry.party_id,
  });
  processTimeouts(entry.queue_id);
}

function getQueueBySlug(venueSlug: string, machineSlug: string) {
  return getDb()
    .prepare(
      `SELECT q.*, v.name as venue_name, v.slug as venue_slug
       FROM queue q JOIN venue v ON v.id = q.venue_id
       WHERE v.slug = ? AND q.slug = ?`,
    )
    .get(venueSlug, machineSlug) as
    | {
        id: string;
        name: string;
        slug: string;
        status: "OPEN" | "PAUSED" | "CLOSED";
        updated_at: string;
        venue_name: string;
        venue_slug: string;
      }
    | undefined;
}

function listActiveEntries(queueId: string): EntryRow[] {
  return getDb()
    .prepare(
      `SELECT e.*, u.nickname, u.rating, u.show_rating_public, u.title, u.icon_url, u.sdgb_identity_hash
       FROM queue_entry e JOIN app_user u ON u.id = e.user_id
       WHERE e.queue_id = ? AND e.status IN ('WAITING','PLAYING')
       ORDER BY CASE e.status WHEN 'PLAYING' THEN 0 ELSE 1 END, e.sequence_number ASC`,
    )
    .all(queueId) as EntryRow[];
}

function toPartyView(party: PartyRow | null, members: EntryRow[], currentUserId?: string | null): PartyView | null {
  if (!party) return null;
  const memberViews = members.map((member) => ({
    entryId: member.id,
    userId: member.user_id,
    displayName: member.nickname,
    rating: member.sdgb_identity_hash && member.show_rating_public ? member.rating : null,
    ratingVisible: Boolean(member.sdgb_identity_hash && member.show_rating_public),
    title: member.sdgb_identity_hash ? member.title : null,
    bound: Boolean(member.sdgb_identity_hash),
    status: member.status,
    isHost: member.user_id === party.host_user_id,
    confirmed: member.user_id === party.host_user_id ? Boolean(party.host_confirmed) : Boolean(party.guest_confirmed),
    isMine: Boolean(currentUserId && member.user_id === currentUserId),
  }));
  const mine = memberViews.find((member) => member.isMine);
  return {
    id: party.id,
    playMode: party.play_mode,
    status: party.status,
    hostConfirmed: Boolean(party.host_confirmed),
    guestConfirmed: Boolean(party.guest_confirmed),
    members: memberViews,
    canConfirmPair: party.play_mode === "DUO" && party.status === "PENDING" && Boolean(mine) && !mine!.confirmed,
    canRequestPair: party.play_mode === "DUO" && party.status === "SEEKING" && !mine && Boolean(currentUserId),
    canCancelPair: Boolean(mine) && party.status !== "DISBANDED",
  };
}

function toEntryView(row: EntryRow, position: number | null, party: PartyView | null, currentUserId?: string | null): QueueEntryView {
  const bound = Boolean(row.sdgb_identity_hash);
  return {
    id: row.id,
    sequenceNumber: row.sequence_number,
    status: row.status,
    position,
    playMode: row.play_mode,
    joinedAt: row.joined_at,
    playingAt: row.playing_at,
    profile: {
      displayName: row.nickname,
      rating: bound && row.show_rating_public ? row.rating : null,
      ratingVisible: Boolean(bound && row.show_rating_public),
      title: bound ? row.title : null,
      iconUrl: bound ? row.icon_url : null,
      bound,
    },
    isMine: Boolean(currentUserId && row.user_id === currentUserId),
    party,
  };
}

function buildSlots(entries: EntryRow[], parties: Map<string, PartyRow>, currentUserId?: string | null) {
  const grouped = new Map<string, EntryRow[]>();
  for (const entry of entries) {
    const key = entry.party_id && entry.play_mode === "DUO" ? `party:${entry.party_id}` : `solo:${entry.id}`;
    const members = grouped.get(key) || [];
    members.push(entry);
    grouped.set(key, members);
  }
  const raw = [...grouped.entries()].map(([key, members]) => {
    const partyId = members[0].party_id;
    const status = members.some((member) => member.status === "PLAYING") ? "PLAYING" : "WAITING";
    return {
      key,
      members,
      status: status as EntryStatus,
      sequenceNumber: Math.min(...members.map((member) => member.sequence_number)),
      playMode: members[0].play_mode,
      party: partyId ? parties.get(partyId) || null : null,
    };
  });
  raw.sort((a, b) => (a.status === "PLAYING" ? -1 : b.status === "PLAYING" ? 1 : a.sequenceNumber - b.sequenceNumber));

  let waitingPosition = 0;
  const slots: QueueSlotView[] = [];
  const entryViews: QueueEntryView[] = [];
  for (const slot of raw) {
    const position = slot.status === "PLAYING" ? -1 : ++waitingPosition;
    const party = toPartyView(slot.party, slot.members, currentUserId);
    const views = slot.members.map((member) => toEntryView(member, position, party, currentUserId));
    entryViews.push(...views);
    slots.push({
      key: slot.key,
      sequenceNumber: slot.sequenceNumber,
      status: slot.status,
      position,
      playMode: slot.playMode,
      party,
      entries: views,
      isMine: views.some((view) => view.isMine),
    });
  }
  return { entries: entryViews, slots };
}

function requeueToEnd(queueId: string, entryId: string, allowedStatuses: EntryStatus[]) {
  const db = getDb();
  const placeholders = allowedStatuses.map(() => "?").join(",");
  const target = db
    .prepare(`SELECT id, party_id, play_mode FROM queue_entry WHERE id = ? AND queue_id = ? AND status IN (${placeholders})`)
    .get(entryId, queueId, ...allowedStatuses) as { id: string; party_id: string | null; play_mode: PlayMode } | undefined;
  if (!target) return false;
  const ids = target.party_id && target.play_mode === "DUO"
    ? (db.prepare(`SELECT id FROM queue_entry WHERE queue_id = ? AND party_id = ? AND status IN (${placeholders})`).all(queueId, target.party_id, ...allowedStatuses) as Array<{ id: string }>).map((row) => row.id)
    : [target.id];
  const queue = db.prepare(`SELECT next_sequence FROM queue WHERE id = ?`).get(queueId) as { next_sequence: number };
  const now = nowIso();
  let sequence = queue.next_sequence;
  for (const id of ids) {
    db.prepare(
      `UPDATE queue_entry
       SET sequence_number = ?, status = 'WAITING', playing_at = NULL,
           finished_at = NULL, cancelled_at = NULL, updated_at = ?, version = version + 1
       WHERE id = ?`,
    ).run(sequence++, now, id);
  }
  db.prepare(`UPDATE queue SET next_sequence = ?, updated_at = ? WHERE id = ?`).run(sequence, now, queueId);
  return true;
}

function finishOrExpireEntry(
  entryId: string,
  status: "DONE" | "EXPIRED" | "CANCELLED",
  actorType: string,
  actorId: string | null,
  reason?: string,
) {
  const now = nowIso();
  if (status === "CANCELLED") {
    getDb().prepare(
      `UPDATE queue_entry SET status = 'CANCELLED', cancelled_at = ?, finished_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(now, now, now, entryId);
  } else {
    getDb().prepare(
      `UPDATE queue_entry SET status = ?, finished_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
    ).run(status, now, now, entryId);
  }
  audit(status === "EXPIRED" ? "ENTRY_EXPIRED" : status === "CANCELLED" ? "ENTRY_CANCELLED" : "ENTRY_DONE", "queue_entry", entryId, actorType, actorId, reason ? { reason } : {});
}

/** Requeue sessions that exceed the configured play duration. */
export function processTimeouts(queueId: string) {
  const db = getDb();
  const cutoff = addSeconds(nowIso(), -env.playingTimeoutSec);
  const rows = db
    .prepare(`SELECT id, party_id, play_mode FROM queue_entry WHERE queue_id = ? AND status = 'PLAYING' AND playing_at IS NOT NULL AND playing_at < ?`)
    .all(queueId, cutoff) as Array<{ id: string; party_id: string | null; play_mode: PlayMode }>;
  const handled = new Set<string>();
  for (const row of rows) {
    const key = row.party_id && row.play_mode === "DUO" ? row.party_id : row.id;
    if (handled.has(key)) continue;
    handled.add(key);
    if (requeueToEnd(queueId, row.id, ["PLAYING"])) {
      audit("ENTRY_AUTO_REQUEUE", "queue_entry", row.id, "SYSTEM", null, {
        reason: "playing_timeout",
        partyId: row.party_id,
      });
    }
  }
}

export function getPublicQueue(venueSlug: string, machineSlug: string, currentUserId?: string | null): PublicQueueSnapshot | null {
  const queue = getQueueBySlug(venueSlug, machineSlug);
  if (!queue) return null;
  processTimeouts(queue.id);
  const active = listActiveEntries(queue.id);
  const parties = new Map<string, PartyRow>();
  const partyRows = getDb()
    .prepare(`SELECT * FROM queue_party WHERE queue_id = ? AND status IN ('SEEKING','PENDING','CONFIRMED')`)
    .all(queue.id) as PartyRow[];
  for (const party of partyRows) parties.set(party.id, party);
  const built = buildSlots(active, parties, currentUserId);
  return {
    venue: { id: VENUE.id, name: queue.venue_name, slug: queue.venue_slug },
    queue: {
      id: queue.id,
      name: queue.name,
      slug: queue.slug,
      status: queue.status,
      playingTimeoutSec: env.playingTimeoutSec,
      updatedAt: queue.updated_at,
    },
    now: nowIso(),
    entries: built.entries,
    slots: built.slots,
  };
}

function assertNoActiveEntry(userId: string) {
  const active = getDb()
    .prepare(`SELECT id FROM queue_entry WHERE user_id = ? AND status IN ('WAITING','PLAYING')`)
    .get(userId) as { id: string } | undefined;
  if (active) throw new Error("ALREADY_IN_ANOTHER_QUEUE");
}

export function joinQueue(queueId: string, userId: string, playMode: PlayMode = "SOLO", targetPartyId?: string | null) {
  const db = getDb();
  const queue = db.prepare(`SELECT * FROM queue WHERE id = ?`).get(queueId) as { id: string; status: string; next_sequence: number } | undefined;
  if (!queue) throw new Error("QUEUE_NOT_FOUND");
  if (queue.status !== "OPEN") throw new Error("QUEUE_NOT_OPEN");
  if (!isVenueOpenAt()) throw new Error("QUEUE_OUTSIDE_HOURS");
  assertNoActiveEntry(userId);
  if (playMode === "DUO" && targetPartyId) return joinExistingDuo(queueId, userId, targetPartyId);

  const now = nowIso();
  const entryId = randomUUID();
  const partyId = playMode === "DUO" ? randomUUID() : null;
  db.transaction(() => {
    if (partyId) {
      db.prepare(
        `INSERT INTO queue_party (id, queue_id, play_mode, status, host_user_id, guest_user_id, host_confirmed, guest_confirmed, created_at, updated_at)
         VALUES (?, ?, 'DUO', 'SEEKING', ?, NULL, 1, 0, ?, ?)`,
      ).run(partyId, queueId, userId, now, now);
    }
    db.prepare(`UPDATE queue SET next_sequence = next_sequence + 1, updated_at = ? WHERE id = ?`).run(now, queueId);
    db.prepare(
      `INSERT INTO queue_entry (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'WAITING', 1, ?, ?, ?)`,
    ).run(entryId, queueId, userId, partyId, playMode, queue.next_sequence, now, now, now);
  })();
  audit("ENTRY_JOINED", "queue_entry", entryId, "USER", userId, { queueId, playMode, partyId });
  return { entryId, partyId };
}

function joinExistingDuo(queueId: string, userId: string, partyId: string) {
  const db = getDb();
  const party = getParty(partyId);
  if (!party || party.queue_id !== queueId) throw new Error("PARTY_NOT_FOUND");
  if (party.status !== "SEEKING") throw new Error("PARTY_NOT_SEEKING");
  if (party.host_user_id === userId) throw new Error("CANNOT_JOIN_OWN_PARTY");
  if (party.guest_user_id) throw new Error("PARTY_FULL");
  const host = db
    .prepare(`SELECT id FROM queue_entry WHERE party_id = ? AND user_id = ? AND status = 'WAITING'`)
    .get(partyId, party.host_user_id) as { id: string } | undefined;
  if (!host) throw new Error("PARTY_HOST_MISSING");
  const queue = db.prepare(`SELECT next_sequence FROM queue WHERE id = ?`).get(queueId) as { next_sequence: number };
  const now = nowIso();
  const entryId = randomUUID();
  db.transaction(() => {
    db.prepare(`UPDATE queue SET next_sequence = next_sequence + 1, updated_at = ? WHERE id = ?`).run(now, queueId);
    db.prepare(
      `INSERT INTO queue_entry (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'DUO', ?, 'WAITING', 1, ?, ?, ?)`,
    ).run(entryId, queueId, userId, partyId, queue.next_sequence, now, now, now);
    db.prepare(
      `UPDATE queue_party SET guest_user_id = ?, status = 'PENDING', host_confirmed = 0, guest_confirmed = 0, updated_at = ?
       WHERE id = ? AND status = 'SEEKING'`,
    ).run(userId, now, partyId);
  })();
  audit("PARTY_JOINED", "queue_party", partyId, "USER", userId, { entryId, hostEntryId: host.id });
  return { entryId, partyId };
}

export function confirmPair(partyId: string, userId: string) {
  const db = getDb();
  const party = getParty(partyId);
  if (!party) throw new Error("PARTY_NOT_FOUND");
  if (party.play_mode !== "DUO") throw new Error("NOT_DUO");
  if (party.status !== "PENDING" && party.status !== "CONFIRMED") throw new Error("INVALID_PARTY_STATUS");
  if (party.host_user_id !== userId && party.guest_user_id !== userId) throw new Error("FORBIDDEN");
  const now = nowIso();
  if (party.host_user_id === userId) {
    db.prepare(`UPDATE queue_party SET host_confirmed = 1, updated_at = ? WHERE id = ?`).run(now, partyId);
  } else {
    db.prepare(`UPDATE queue_party SET guest_confirmed = 1, updated_at = ? WHERE id = ?`).run(now, partyId);
  }
  const refreshed = getParty(partyId)!;
  if (refreshed.host_confirmed && refreshed.guest_confirmed) {
    db.prepare(`UPDATE queue_party SET status = 'CONFIRMED', updated_at = ? WHERE id = ?`).run(now, partyId);
    audit("PARTY_CONFIRMED", "queue_party", partyId, "USER", userId);
  } else {
    audit("PARTY_CONFIRM_PARTIAL", "queue_party", partyId, "USER", userId, { isHost: party.host_user_id === userId });
  }
}

export function cancelEntry(entryId: string, userId: string) {
  const db = getDb();
  const entry = db.prepare(`SELECT * FROM queue_entry WHERE id = ?`).get(entryId) as
    | { id: string; queue_id: string; user_id: string; party_id: string | null; play_mode: PlayMode; status: EntryStatus }
    | undefined;
  if (!entry) throw new Error("ENTRY_NOT_FOUND");
  if (entry.user_id !== userId) throw new Error("FORBIDDEN");
  if (entry.status !== "WAITING") throw new Error("INVALID_STATUS");
  finishOrExpireEntry(entry.id, "CANCELLED", "USER", userId);
  if (entry.party_id && entry.play_mode === "DUO") {
    const party = getParty(entry.party_id);
    const now = nowIso();
    if (party && party.status !== "DISBANDED") {
      if (party.host_user_id === userId) {
        db.prepare(`UPDATE queue_party SET status = 'DISBANDED', updated_at = ? WHERE id = ?`).run(now, party.id);
        if (party.guest_user_id) {
          db.prepare(
            `UPDATE queue_entry SET party_id = NULL, play_mode = 'SOLO', updated_at = ?, version = version + 1
             WHERE party_id = ? AND user_id = ? AND status = 'WAITING'`,
          ).run(now, party.id, party.guest_user_id);
        }
      } else {
        db.prepare(
          `UPDATE queue_party SET guest_user_id = NULL, status = 'SEEKING', host_confirmed = 1, guest_confirmed = 0, updated_at = ? WHERE id = ?`,
        ).run(now, party.id);
      }
    }
  }
}

export function finishPlay(entryId: string, userId: string) {
  const entry = getDb().prepare(`SELECT id, queue_id, user_id, status FROM queue_entry WHERE id = ?`).get(entryId) as
    | { id: string; queue_id: string; user_id: string; status: EntryStatus }
    | undefined;
  if (!entry) throw new Error("ENTRY_NOT_FOUND");
  if (entry.user_id !== userId) throw new Error("FORBIDDEN");
  if (entry.status !== "PLAYING") throw new Error("INVALID_STATUS");
  finishOrExpireEntry(entry.id, "DONE", "USER", userId);
  processTimeouts(entry.queue_id);
}

export function getUserActiveEntries(userId: string) {
  return getDb()
    .prepare(
      `SELECT e.*, q.name as queue_name, q.slug as queue_slug, v.slug as venue_slug
       FROM queue_entry e JOIN queue q ON q.id = e.queue_id JOIN venue v ON v.id = q.venue_id
       WHERE e.user_id = ? AND e.status IN ('WAITING','PLAYING') ORDER BY e.joined_at DESC`,
    )
    .all(userId) as Array<{
    id: string;
    queue_id: string;
    status: EntryStatus;
    play_mode: PlayMode;
    sequence_number: number;
    joined_at: string;
    playing_at: string | null;
    queue_name: string;
    queue_slug: string;
    venue_slug: string;
  }>;
}
