/**
 * 超时处理：游玩超时重排队尾；队头确认窗口组级打点（duo 取最早戳）——
 * 独组 strike 后重打、二次超时整组 CANCELLED + party DISBANDED。
 */
import { addSeconds, getDb, nowIso } from "../db";
import { getHeadConfirmTimeoutSec, getPlayingTimeoutSec } from "../settings";
import type { PlayMode } from "../types";
import { audit, requeueToEnd } from "./core";

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

/** Group waiting entries by solo key or duo party in O(n) — single scan
 *  with a Map, then sort groups by their minimum sequence number. */
export function waitingGroups(queueId: string): WaitingGroup[] {
  const rows = getDb()
    .prepare(
      `SELECT id, party_id, play_mode, sequence_number, head_eligible_at, head_miss_count, user_id
       FROM queue_entry
       WHERE queue_id = ? AND status = 'WAITING'
       ORDER BY sequence_number ASC`,
    )
    .all(queueId) as WaitingMember[];

  const groupMap = new Map<string, WaitingMember[]>();
  for (const row of rows) {
    const key =
      row.party_id && row.play_mode === "DUO"
        ? `party:${row.party_id}`
        : `solo:${row.id}`;
    const members = groupMap.get(key);
    if (members) {
      members.push(row);
    } else {
      groupMap.set(key, [row]);
    }
  }

  return Array.from(groupMap.entries())
    .map(([key, members]) => ({
      key,
      members,
      sequenceNumber: Math.min(...members.map((m) => m.sequence_number)),
    }))
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
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

  // 队头确认超时：整组自动排到队尾（不后移一组、不卸卡）。
  // 下一组队首随后获得新的确认窗口，由通知插件 @ 提醒。
  const headEntryId = head.members[0]!.id;
  if (requeueToEnd(queueId, headEntryId, ["WAITING"])) {
    audit("ENTRY_HEAD_TIMEOUT_REQUEUE_END", "queue_entry", headEntryId, "SYSTEM", null, {
      partyId: head.members[0]!.party_id,
    });
  }
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
