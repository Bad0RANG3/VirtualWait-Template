/**
 * 常驻维护：超时处理 + 清理限流桶 / IP 日配额 / 不活跃登录元数据 /
 * 终态队列(180d) / 审计(365d) / session(30d)。
 */
import { getDb, nowIso, addSeconds } from "../db";
import { cleanupExpiredRateLimitBuckets } from "../auth/rate-limit";
import { shanghaiDayKey } from "../auth/time";
import { env } from "../env";
import { processTimeouts } from "./service";

export type MaintenanceResult = {
  queuesProcessed: number;
  expiredRateLimitBucketsDeleted: number;
  expiredIpDayBindingsDeleted: number;
  staleLoginMetadataScrubbed: number;
  terminalQueueEntriesDeleted: number;
  queuePartiesDeleted: number;
  auditEventsDeleted: number;
  expiredSessionsDeleted: number;
};

type SqlRunResult = { changes?: number };

function daysBefore(iso: string, days: number) {
  return addSeconds(iso, -days * 86_400);
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(",");
}

function deleteQueueHistory(cutoff: string) {
  const db = getDb();
  return db.transaction(() => {
    const oldEntries = db
      .prepare(
        `SELECT id, party_id
       FROM queue_entry
       WHERE status IN ('DONE','CANCELLED','EXPIRED')
         AND COALESCE(finished_at, cancelled_at, updated_at, joined_at) < ?
       ORDER BY COALESCE(finished_at, cancelled_at, updated_at, joined_at)
       LIMIT 200`,
      )
      .all(cutoff) as Array<{ id: string; party_id: string | null }>;

    if (oldEntries.length === 0) {
      return {
        terminalQueueEntriesDeleted: 0,
        queuePartiesDeleted: 0,
      };
    }

    const entryIds = oldEntries.map((entry) => entry.id);
    const entryPlaceholders = placeholders(entryIds.length);
    const terminalQueueEntriesDeleted =
      (
        db
          .prepare(`DELETE FROM queue_entry WHERE id IN (${entryPlaceholders})`)
          .run(...entryIds) as SqlRunResult
      ).changes ?? 0;

    const candidatePartyIds = Array.from(
      new Set(
        oldEntries.map((entry) => entry.party_id).filter(Boolean) as string[],
      ),
    );
    let queuePartiesDeleted = 0;
    if (candidatePartyIds.length > 0) {
      const partyPlaceholders = placeholders(candidatePartyIds.length);
      queuePartiesDeleted =
        (
          db
            .prepare(
              `DELETE FROM queue_party
             WHERE id IN (${partyPlaceholders})
               AND status IN ('DISBANDED','CONFIRMED')
               AND NOT EXISTS (
                 SELECT 1 FROM queue_entry WHERE queue_entry.party_id = queue_party.id
               )`,
            )
            .run(...candidatePartyIds) as SqlRunResult
        ).changes ?? 0;
    }

    return {
      terminalQueueEntriesDeleted,
      queuePartiesDeleted,
    };
  })();
}

/**
 * Drop the last-login IP hash/day for accounts that have been inactive past
 * the retention window and are not currently queued. The account itself,
 * its nickname and password hash are kept — only the derived abuse-control
 * metadata is removed.
 */
function scrubStaleLoginMetadata(cutoff: string, now: string) {
  const db = getDb();
  return (
    (
      db
        .prepare(
          `UPDATE app_user
         SET last_login_ip_hash = NULL,
             last_login_day = NULL,
             updated_at = ?
         WHERE updated_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM queue_entry
             WHERE queue_entry.user_id = app_user.id
               AND queue_entry.status IN ('WAITING','PLAYING')
           )
           AND (last_login_ip_hash IS NOT NULL OR last_login_day IS NOT NULL)`,
        )
        .run(now, cutoff) as SqlRunResult
    ).changes ?? 0
  );
}

/**
 * Run independently of public queue reads so playing timeouts still progress
 * during quiet periods. It also applies the configured retention policy for
 * derived abuse-control data, terminal queue history, audit events and sessions.
 */
export function runMaintenance(now = nowIso()): MaintenanceResult {
  const db = getDb();
  const queues = db.prepare(`SELECT id FROM queue`).all() as { id: string }[];
  for (const queue of queues) processTimeouts(queue.id);

  const nowMs = new Date(now).getTime();
  const rateLimitBuckets = cleanupExpiredRateLimitBuckets(nowMs);

  const ipBindingCutoffDay = shanghaiDayKey(
    nowMs - env.ipBindingRetentionDays * 86_400_000,
  );
  const ipDayBindings = db
    .prepare(`DELETE FROM ip_day_binding WHERE day_key < ?`)
    .run(ipBindingCutoffDay) as SqlRunResult;

  const history = deleteQueueHistory(
    daysBefore(now, env.queueHistoryRetentionDays),
  );
  const auditEvents = db
    .prepare(`DELETE FROM audit_event WHERE created_at < ?`)
    .run(daysBefore(now, env.auditEventRetentionDays)) as SqlRunResult;
  const staleLoginMetadataScrubbed = scrubStaleLoginMetadata(
    daysBefore(now, env.loginMetadataRetentionDays),
    now,
  );
  // Revoked and expired sessions cannot be revoked again; drop them once the
  // matching cookie would have expired anyway.
  const expiredSessions = db
    .prepare(`DELETE FROM session WHERE issued_at_ms < ?`)
    .run(nowMs - env.sessionMaxAgeDays * 86_400_000) as SqlRunResult;

  return {
    queuesProcessed: queues.length,
    expiredRateLimitBucketsDeleted: rateLimitBuckets,
    expiredIpDayBindingsDeleted: ipDayBindings.changes ?? 0,
    staleLoginMetadataScrubbed,
    terminalQueueEntriesDeleted: history.terminalQueueEntriesDeleted,
    queuePartiesDeleted: history.queuePartiesDeleted,
    auditEventsDeleted: auditEvents.changes ?? 0,
    expiredSessionsDeleted: expiredSessions.changes ?? 0,
  };
}
