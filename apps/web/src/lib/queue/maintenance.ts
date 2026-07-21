import { getDb, nowIso, addSeconds } from "../db";
import { cleanupOldRateLimitBuckets } from "../auth/rate-limit";
import { shanghaiDayKey } from "../auth/time";
import { env } from "../env";
import { processTimeouts } from "./service";

export type MaintenanceResult = {
  queuesProcessed: number;
  expiredAttemptsDeleted: number;
  expiredRateLimitBucketsDeleted: number;
  staleSlotsDeleted: number;
  expiredIpDayBindingsDeleted: number;
  staleProfilesScrubbed: number;
  terminalQueueEntriesDeleted: number;
  queuePartiesDeleted: number;
  auditEventsDeleted: number;
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

function scrubStaleProfiles(cutoff: string, now: string) {
  const db = getDb();
  return (
    (
      db
        .prepare(
          `UPDATE app_user
         SET sdgb_user_id_cipher = NULL,
             display_name = NULL,
             rating = NULL,
             title = NULL,
             icon_url = NULL,
             avatar_url = NULL,
             profile_snapshot = NULL,
             last_login_ip_hash = NULL,
             last_login_day = NULL,
             updated_at = ?
         WHERE updated_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM queue_entry
             WHERE queue_entry.user_id = app_user.id
               AND queue_entry.status IN ('WAITING','PLAYING')
           )
           AND (
             sdgb_user_id_cipher IS NOT NULL OR display_name IS NOT NULL OR
             rating IS NOT NULL OR title IS NOT NULL OR icon_url IS NOT NULL OR
             avatar_url IS NOT NULL OR profile_snapshot IS NOT NULL OR
             last_login_ip_hash IS NOT NULL OR last_login_day IS NOT NULL
           )`,
        )
        .run(now, cutoff) as SqlRunResult
    ).changes ?? 0
  );
}

/**
 * Run independently of public queue reads so playing timeouts still
 * progress during quiet periods. It removes transient verification data and
 * applies the configured privacy retention policy for stale profile metadata,
 * terminal queue history and audit events.
 */
export function runMaintenance(now = nowIso()): MaintenanceResult {
  const db = getDb();
  const queues = db.prepare(`SELECT id FROM queue`).all() as { id: string }[];
  for (const queue of queues) processTimeouts(queue.id);

  const nowMs = new Date(now).getTime();
  const transientCutoff = addSeconds(now, -env.transientDataRetentionSec);
  const attempts = db
    .prepare(
      `DELETE FROM join_attempt
       WHERE expires_at < ? AND status IN ('SUCCEEDED', 'FAILED', 'EXPIRED')`,
    )
    .run(transientCutoff) as SqlRunResult;
  // Legacy local mock-job rows may still exist from older Web builds that
  // short-circuited verification in-process. Drop them when present.
  try {
    db.prepare(`DELETE FROM gateway_job_mock WHERE expires_at < ?`).run(
      transientCutoff,
    );
  } catch {
    // Table absent on fresh installs that never used the in-process mock.
  }
  const rateLimitBuckets = cleanupOldRateLimitBuckets(
    nowMs - env.rateLimitBucketRetentionSec * 1000,
  );
  const slots = db
    .prepare(`DELETE FROM qr_concurrency_slot WHERE created_at_ms < ?`)
    .run(nowMs - 120_000) as SqlRunResult;

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
  const staleProfilesScrubbed = scrubStaleProfiles(
    daysBefore(now, env.profileDataRetentionDays),
    now,
  );

  return {
    queuesProcessed: queues.length,
    expiredAttemptsDeleted: attempts.changes ?? 0,
    expiredRateLimitBucketsDeleted: rateLimitBuckets,
    staleSlotsDeleted: slots.changes ?? 0,
    expiredIpDayBindingsDeleted: ipDayBindings.changes ?? 0,
    staleProfilesScrubbed,
    terminalQueueEntriesDeleted: history.terminalQueueEntriesDeleted,
    queuePartiesDeleted: history.queuePartiesDeleted,
    auditEventsDeleted: auditEvents.changes ?? 0,
  };
}
