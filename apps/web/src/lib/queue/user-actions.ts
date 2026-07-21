import { randomUUID } from "crypto";
import { getDb, nowIso } from "../db";
import { isVenueOpenNow } from "../settings";
import type { EntryStatus, PlayMode } from "../types";
import {
  activeMembers,
  audit,
  finishOrExpireEntry,
  getParty,
  startEntries,
} from "./core";
import { processTimeouts } from "./timeouts";

function assertNoActiveEntry(userId: string) {
  const active = getDb()
    .prepare(
      `SELECT id FROM queue_entry WHERE user_id = ? AND status IN ('WAITING','PLAYING')`,
    )
    .get(userId) as { id: string } | undefined;
  if (active) throw new Error("ALREADY_IN_ANOTHER_QUEUE");
}

export function joinQueue(
  queueId: string,
  userId: string,
  playMode: PlayMode = "SOLO",
  targetPartyId?: string | null,
) {
  const db = getDb();
  const queue = db.prepare(`SELECT * FROM queue WHERE id = ?`).get(queueId) as
    | { id: string; status: string; next_sequence: number }
    | undefined;
  if (!queue) throw new Error("QUEUE_NOT_FOUND");
  if (queue.status !== "OPEN") throw new Error("QUEUE_NOT_OPEN");
  const venueRow = db
    .prepare(
      `SELECT v.slug as venue_slug FROM queue q JOIN venue v ON v.id = q.venue_id WHERE q.id = ?`,
    )
    .get(queueId) as { venue_slug: string } | undefined;
  if (!isVenueOpenNow(venueRow?.venue_slug)) throw new Error("QUEUE_OUTSIDE_HOURS");
  assertNoActiveEntry(userId);
  if (playMode === "DUO" && targetPartyId) return joinExistingDuo(queueId, userId, targetPartyId);

  const now = nowIso();
  const entryId = randomUUID();
  const partyId = playMode === "DUO" ? randomUUID() : null;
  db.transaction(() => {
    if (partyId) {
      db.prepare(
        `INSERT INTO queue_party
         (id, queue_id, play_mode, status, host_user_id, guest_user_id, host_confirmed, guest_confirmed, created_at, updated_at)
         VALUES (?, ?, 'DUO', 'SEEKING', ?, NULL, 1, 0, ?, ?)`,
      ).run(partyId, queueId, userId, now, now);
    }
    db.prepare(`UPDATE queue SET next_sequence = next_sequence + 1, updated_at = ? WHERE id = ?`).run(
      now,
      queueId,
    );
    db.prepare(
      `INSERT INTO queue_entry
       (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'WAITING', 1, ?, ?, ?)`,
    ).run(entryId, queueId, userId, partyId, playMode, queue.next_sequence, now, now, now);
  })();
  audit("ENTRY_JOINED", "queue_entry", entryId, "USER", userId, {
    queueId,
    playMode,
    partyId,
  });
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
    .prepare(
      `SELECT id FROM queue_entry WHERE party_id = ? AND user_id = ? AND status = 'WAITING'`,
    )
    .get(partyId, party.host_user_id) as { id: string } | undefined;
  if (!host) throw new Error("PARTY_HOST_MISSING");
  const queue = db.prepare(`SELECT next_sequence FROM queue WHERE id = ?`).get(queueId) as {
    next_sequence: number;
  };
  const now = nowIso();
  const entryId = randomUUID();
  db.transaction(() => {
    db.prepare(`UPDATE queue SET next_sequence = next_sequence + 1, updated_at = ? WHERE id = ?`).run(
      now,
      queueId,
    );
    db.prepare(
      `INSERT INTO queue_entry
       (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'DUO', ?, 'WAITING', 1, ?, ?, ?)`,
    ).run(entryId, queueId, userId, partyId, queue.next_sequence, now, now, now);
    db.prepare(
      `UPDATE queue_party
       SET guest_user_id = ?, status = 'PENDING', host_confirmed = 0, guest_confirmed = 0, updated_at = ?
       WHERE id = ? AND status = 'SEEKING'`,
    ).run(userId, now, partyId);
  })();
  audit("PARTY_JOINED", "queue_party", partyId, "USER", userId, {
    entryId,
    hostEntryId: host.id,
  });
  return { entryId, partyId };
}

export function confirmPair(partyId: string, userId: string) {
  const db = getDb();
  const party = getParty(partyId);
  if (!party) throw new Error("PARTY_NOT_FOUND");
  if (party.play_mode !== "DUO") throw new Error("NOT_DUO");
  if (party.status !== "PENDING" && party.status !== "CONFIRMED") {
    throw new Error("INVALID_PARTY_STATUS");
  }
  if (party.host_user_id !== userId && party.guest_user_id !== userId) {
    throw new Error("FORBIDDEN");
  }
  const now = nowIso();
  if (party.host_user_id === userId) {
    db.prepare(`UPDATE queue_party SET host_confirmed = 1, updated_at = ? WHERE id = ?`).run(
      now,
      partyId,
    );
  } else {
    db.prepare(`UPDATE queue_party SET guest_confirmed = 1, updated_at = ? WHERE id = ?`).run(
      now,
      partyId,
    );
  }
  const refreshed = getParty(partyId)!;
  if (refreshed.host_confirmed && refreshed.guest_confirmed) {
    db.prepare(`UPDATE queue_party SET status = 'CONFIRMED', updated_at = ? WHERE id = ?`).run(
      now,
      partyId,
    );
    audit("PARTY_CONFIRMED", "queue_party", partyId, "USER", userId);
  } else {
    audit("PARTY_CONFIRM_PARTIAL", "queue_party", partyId, "USER", userId, {
      isHost: party.host_user_id === userId,
    });
  }
}

export function cancelEntry(entryId: string, userId: string) {
  const db = getDb();
  const entry = db.prepare(`SELECT * FROM queue_entry WHERE id = ?`).get(entryId) as
    | {
        id: string;
        queue_id: string;
        user_id: string;
        party_id: string | null;
        play_mode: PlayMode;
        status: EntryStatus;
      }
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
        db.prepare(`UPDATE queue_party SET status = 'DISBANDED', updated_at = ? WHERE id = ?`).run(
          now,
          party.id,
        );
        if (party.guest_user_id) {
          db.prepare(
            `UPDATE queue_entry
             SET party_id = NULL, play_mode = 'SOLO', updated_at = ?, version = version + 1
             WHERE party_id = ? AND user_id = ? AND status = 'WAITING'`,
          ).run(now, party.id, party.guest_user_id);
        }
      } else {
        db.prepare(
          `UPDATE queue_party
           SET guest_user_id = NULL, status = 'SEEKING', host_confirmed = 1, guest_confirmed = 0, updated_at = ?
           WHERE id = ?`,
        ).run(now, party.id);
      }
    }
  }
}

/** User at the head of a free machine confirms and starts play. */
export function confirmStartPlay(entryId: string, userId: string) {
  const db = getDb();
  const entry = db
    .prepare(
      `SELECT id, queue_id, user_id, party_id, play_mode, status
       FROM queue_entry WHERE id = ?`,
    )
    .get(entryId) as
    | {
        id: string;
        queue_id: string;
        user_id: string;
        party_id: string | null;
        play_mode: PlayMode;
        status: EntryStatus;
      }
    | undefined;
  if (!entry) throw new Error("ENTRY_NOT_FOUND");
  if (entry.user_id !== userId) throw new Error("FORBIDDEN");
  if (entry.status !== "WAITING") throw new Error("INVALID_STATUS");

  const queue = db.prepare(`SELECT id, status FROM queue WHERE id = ?`).get(entry.queue_id) as
    | { id: string; status: string }
    | undefined;
  if (!queue) throw new Error("QUEUE_NOT_FOUND");
  if (queue.status !== "OPEN") throw new Error("QUEUE_NOT_OPEN");

  const members = activeMembers(entry);
  const isDuo = entry.play_mode === "DUO" && Boolean(entry.party_id);
  if (isDuo) {
    if (members.length !== 2) throw new Error("NOT_HEAD_OF_QUEUE");
    if (getParty(entry.party_id)?.status !== "CONFIRMED") {
      throw new Error("PAIR_NOT_CONFIRMED");
    }
  } else if (members.length !== 1 || members[0].id !== entry.id) {
    throw new Error("INVALID_STATUS");
  }

  const busy = db
    .prepare(`SELECT id FROM queue_entry WHERE queue_id = ? AND status = 'PLAYING' LIMIT 1`)
    .get(entry.queue_id) as { id: string } | undefined;
  if (busy) throw new Error("MACHINE_BUSY");

  // First waiting slot only (PLAYING rows sort first and do not count).
  const waiting = db
    .prepare(
      `SELECT id, party_id, play_mode, sequence_number
       FROM queue_entry
       WHERE queue_id = ? AND status = 'WAITING'
       ORDER BY sequence_number ASC`,
    )
    .all(entry.queue_id) as Array<{
    id: string;
    party_id: string | null;
    play_mode: PlayMode;
    sequence_number: number;
  }>;
  if (waiting.length === 0) throw new Error("NOT_HEAD_OF_QUEUE");
  const head = waiting[0]!;
  const headKey =
    head.party_id && head.play_mode === "DUO" ? `party:${head.party_id}` : `solo:${head.id}`;
  const myKey =
    entry.party_id && entry.play_mode === "DUO"
      ? `party:${entry.party_id}`
      : `solo:${entry.id}`;
  if (headKey !== myKey) throw new Error("NOT_HEAD_OF_QUEUE");

  startEntries(
    entry.queue_id,
    members.map((member) => member.id),
    "USER",
    userId,
    "user_confirm_start",
  );
  processTimeouts(entry.queue_id);
}

export function finishPlay(entryId: string, userId: string) {
  const entry = getDb()
    .prepare(`SELECT id, queue_id, user_id, status FROM queue_entry WHERE id = ?`)
    .get(entryId) as
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
