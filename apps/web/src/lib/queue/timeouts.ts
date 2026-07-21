import { addSeconds, getDb, nowIso } from "../db";
import { getHeadConfirmTimeoutSec, getPlayingTimeoutSec } from "../settings";
import type { PlayMode } from "../types";
import { audit, finishOrExpireEntry, requeueToEnd } from "./core";

export type WaitingMember = {
  id: string;
  party_id: string | null;
  play_mode: PlayMode;
  sequence_number: number;
  head_eligible_at: string | null;
  head_miss_count: number;
  user_id: string;
};

export type WaitingGroup = {
  key: string;
  members: WaitingMember[];
  sequenceNumber: number;
};

export function waitingGroups(queueId: string): WaitingGroup[] {
  const rows = getDb()
    .prepare(
      `SELECT id, party_id, play_mode, sequence_number, head_eligible_at, head_miss_count, user_id
       FROM queue_entry
       WHERE queue_id = ? AND status = 'WAITING'
       ORDER BY sequence_number ASC`,
    )
    .all(queueId) as WaitingMember[];
  const groups: WaitingGroup[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key =
      row.party_id && row.play_mode === "DUO"
        ? `party:${row.party_id}`
        : `solo:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const members =
      row.party_id && row.play_mode === "DUO"
        ? rows.filter(
            (item) => item.party_id === row.party_id && item.play_mode === "DUO",
          )
        : [row];
    groups.push({
      key,
      members,
      sequenceNumber: Math.min(...members.map((member) => member.sequence_number)),
    });
  }
  groups.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return groups;
}

function clearHeadEligibility(queueId: string, exceptIds: string[] = []) {
  const db = getDb();
  if (exceptIds.length === 0) {
    db.prepare(
      `UPDATE queue_entry SET head_eligible_at = NULL, updated_at = ?
       WHERE queue_id = ? AND status = 'WAITING' AND head_eligible_at IS NOT NULL`,
    ).run(nowIso(), queueId);
    return;
  }
  const placeholders = exceptIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE queue_entry SET head_eligible_at = NULL, updated_at = ?
     WHERE queue_id = ? AND status = 'WAITING' AND head_eligible_at IS NOT NULL
       AND id NOT IN (${placeholders})`,
  ).run(nowIso(), queueId, ...exceptIds);
}

function markHeadEligibility(queueId: string) {
  const db = getDb();
  const busy = db
    .prepare(`SELECT id FROM queue_entry WHERE queue_id = ? AND status = 'PLAYING' LIMIT 1`)
    .get(queueId) as { id: string } | undefined;
  if (busy) {
    clearHeadEligibility(queueId);
    return;
  }
  const groups = waitingGroups(queueId);
  if (groups.length === 0) return;
  const head = groups[0]!;
  const memberIds = head.members.map((member) => member.id);
  clearHeadEligibility(queueId, memberIds);
  const now = nowIso();
  const needsStamp = head.members.some((member) => !member.head_eligible_at);
  if (needsStamp) {
    for (const member of head.members) {
      if (!member.head_eligible_at) {
        db.prepare(
          `UPDATE queue_entry SET head_eligible_at = ?, updated_at = ?
           WHERE id = ? AND status = 'WAITING'`,
        ).run(now, now, member.id);
      }
    }
  }
}

function moveGroupBackOne(queueId: string, head: WaitingGroup, next: WaitingGroup) {
  const db = getDb();
  const now = nowIso();
  const ordered = waitingGroups(queueId);
  // Keep full waiting order, swap the timed-out head with the next group only.
  const swapped = ordered.map((group) => {
    if (group.key === head.key) return next;
    if (group.key === next.key) return head;
    return group;
  });

  // Park every waiting entry on temporary sequence numbers first (unique constraint).
  let temp = -1;
  for (const group of ordered) {
    for (const member of group.members) {
      db.prepare(
        `UPDATE queue_entry SET sequence_number = ?, updated_at = ?, version = version + 1
         WHERE id = ?`,
      ).run(temp--, now, member.id);
    }
  }

  const queue = db
    .prepare(`SELECT next_sequence FROM queue WHERE id = ?`)
    .get(queueId) as { next_sequence: number };
  let sequence = queue.next_sequence;
  for (const group of swapped) {
    const isFormerHead = group.key === head.key;
    for (const member of group.members) {
      db.prepare(
        `UPDATE queue_entry
         SET sequence_number = ?,
             head_eligible_at = NULL,
             head_miss_count = ?,
             updated_at = ?,
             version = version + 1
         WHERE id = ?`,
      ).run(sequence++, isFormerHead ? 1 : member.head_miss_count || 0, now, member.id);
    }
  }
  db.prepare(`UPDATE queue SET next_sequence = ?, updated_at = ? WHERE id = ?`).run(
    sequence,
    now,
    queueId,
  );
}

function cancelWaitingGroup(
  members: Array<{ id: string; party_id: string | null; play_mode: PlayMode }>,
  reason: string,
) {
  const db = getDb();
  const now = nowIso();
  for (const member of members) {
    finishOrExpireEntry(member.id, "CANCELLED", "SYSTEM", null, reason);
  }
  const partyId = members[0]?.party_id;
  const playMode = members[0]?.play_mode;
  if (partyId && playMode === "DUO") {
    db.prepare(
      `UPDATE queue_party SET status = 'DISBANDED', updated_at = ?
       WHERE id = ? AND status != 'DISBANDED'`,
    ).run(now, partyId);
  }
}

function processHeadConfirmTimeouts(queueId: string) {
  const db = getDb();
  const busy = db
    .prepare(`SELECT id FROM queue_entry WHERE queue_id = ? AND status = 'PLAYING' LIMIT 1`)
    .get(queueId) as { id: string } | undefined;
  if (busy) return;

  const groups = waitingGroups(queueId);
  if (groups.length === 0) return;
  const head = groups[0]!;
  const eligibleAt = head.members
    .map((member) => member.head_eligible_at)
    .find((value) => Boolean(value));
  if (!eligibleAt) return;
  const deadline = addSeconds(eligibleAt, getHeadConfirmTimeoutSec());
  if (deadline > nowIso()) return;

  const missCount = Math.max(...head.members.map((member) => member.head_miss_count || 0));
  if (missCount >= 1) {
    cancelWaitingGroup(head.members, "head_confirm_timeout_second");
    audit("ENTRY_HEAD_TIMEOUT_CANCEL", "queue_entry", head.members[0]!.id, "SYSTEM", null, {
      partyId: head.members[0]!.party_id,
      missCount: missCount + 1,
    });
    return;
  }

  const next = groups[1];
  if (next) {
    moveGroupBackOne(queueId, head, next);
    audit("ENTRY_HEAD_TIMEOUT_REQUEUE", "queue_entry", head.members[0]!.id, "SYSTEM", null, {
      partyId: head.members[0]!.party_id,
      nextKey: next.key,
      missCount: 1,
    });
    return;
  }

  // Alone at head: first miss only arms the second-strike counter.
  const now = nowIso();
  for (const member of head.members) {
    db.prepare(
      `UPDATE queue_entry
       SET head_miss_count = 1, head_eligible_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND status = 'WAITING'`,
    ).run(now, now, member.id);
  }
  audit("ENTRY_HEAD_TIMEOUT_STRIKE", "queue_entry", head.members[0]!.id, "SYSTEM", null, {
    partyId: head.members[0]!.party_id,
    missCount: 1,
    alone: true,
  });
}

/** Requeue play timeouts and enforce head-of-queue confirm window. */
export function processTimeouts(queueId: string) {
  const db = getDb();
  const cutoff = addSeconds(nowIso(), -getPlayingTimeoutSec());
  const rows = db
    .prepare(
      `SELECT id, party_id, play_mode FROM queue_entry
       WHERE queue_id = ? AND status = 'PLAYING' AND playing_at IS NOT NULL AND playing_at < ?`,
    )
    .all(queueId, cutoff) as Array<{
    id: string;
    party_id: string | null;
    play_mode: PlayMode;
  }>;
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
  processHeadConfirmTimeouts(queueId);
  markHeadEligibility(queueId);
}
