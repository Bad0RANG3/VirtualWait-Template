/**
 * 公开队列快照（只读无副作用）：WAITING 截断至 200 防超大响应，totalWaiting 如实；
 * 含 countActiveEntries* 计数。
 */
import { getDb, nowIso } from "../db";
import { venueBySlug } from "../constants/catalog";
import {
  getHeadConfirmTimeoutSec,
  getPlayingTimeoutSec,
  getVenueHoursBySlug,
} from "../settings";
import type { PublicQueueSnapshot } from "../types";
import { getQueueBySlug, listActiveEntries, type PartyRow } from "./core";
import { buildSlots } from "./views";

type VenueLiveRow = {
  address: string | null;
  region_name: string | null;
  region_kind: string | null;
  machine_count: number | null;
};

/**
 * Cap the serialized public snapshot so an extremely long queue cannot turn
 * the 3.5s board poll into a multi-megabyte response. The countdown/positions
 * of the shown slots stay correct; the client shows an overflow hint using
 * `totalWaiting`.
 */
const PUBLIC_SNAPSHOT_MAX_WAITING_ENTRIES = 200;

function getVenueLiveFields(slug: string): VenueLiveRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT address, region_name, region_kind, machine_count
         FROM venue WHERE slug = ?`,
      )
      .get(slug) as VenueLiveRow | undefined) || null
  );
}

export function getPublicQueue(
  venueSlug: string,
  machineSlug: string,
  currentUserId?: string | null,
): PublicQueueSnapshot | null {
  const queue = getQueueBySlug(venueSlug, machineSlug);
  if (!queue) return null;
  // Timeout processing is handled by write operations and the maintenance
  // loop — GET must remain side-effect-free for safe caching/prefetching.
  const active = listActiveEntries(queue.id);
  // Bound the payload: keep every PLAYING row, then the earliest waiting
  // entries up to the cap. A truncated duo pair degrades to a display-only
  // artifact of the overflow hint, never to a correctness issue.
  const waitingCount = active.filter((row) => row.status === "WAITING").length;
  const playing = active.filter((row) => row.status === "PLAYING");
  const waiting = active
    .filter((row) => row.status === "WAITING")
    .slice(0, Math.max(PUBLIC_SNAPSHOT_MAX_WAITING_ENTRIES - playing.length, 0));
  const parties = new Map<string, PartyRow>();
  const partyRows = getDb()
    .prepare(
      `SELECT * FROM queue_party WHERE queue_id = ? AND status IN ('SEEKING','PENDING','CONFIRMED')`,
    )
    .all(queue.id) as PartyRow[];
  for (const party of partyRows) parties.set(party.id, party);
  const built = buildSlots([...playing, ...waiting], parties, currentUserId);
  const venueMeta = venueBySlug(queue.venue_slug);
  const live = getVenueLiveFields(queue.venue_slug);
  const hours = getVenueHoursBySlug(queue.venue_slug);
  return {
    venue: {
      id: venueMeta?.id ?? queue.venue_slug,
      name: queue.venue_name,
      slug: queue.venue_slug,
      address: live?.address || venueMeta?.address || "",
      regionName: live?.region_name || venueMeta?.regionName || "",
      regionKind: live?.region_kind || venueMeta?.regionKind || "",
      machineCount:
        (typeof live?.machine_count === "number" && Number.isFinite(live.machine_count)
          ? live.machine_count
          : null) ??
        venueMeta?.machineCount ??
        venueMeta?.machines.length ??
        0,
      openMinute: hours.openMinute,
      closeMinute: hours.closeMinute,
      hoursLabel: hours.label,
    },
    queue: {
      id: queue.id,
      name: queue.name,
      slug: queue.slug,
      status: queue.status,
      playingTimeoutSec: getPlayingTimeoutSec(),
      headConfirmTimeoutSec: getHeadConfirmTimeoutSec(),
      coinCost:
        typeof queue.coin_cost === "number" && queue.coin_cost > 0 ? queue.coin_cost : 1,
      updatedAt: queue.updated_at,
    },
    now: nowIso(),
    entries: built.entries,
    slots: built.slots,
    totalWaiting: waitingCount,
  };
}

/** Lightweight active-count for listing pages (no timeout side effects). */
export function countActiveEntries(queueId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM queue_entry
       WHERE queue_id = ? AND status IN ('WAITING','PLAYING')`,
    )
    .get(queueId) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

/** Active counts keyed by venueSlug/machineSlug for home/district listings. */
export function countActiveEntriesByMachine(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT v.slug AS venue_slug, q.slug AS machine_slug, COUNT(e.id) AS c
       FROM queue q
       JOIN venue v ON v.id = q.venue_id
       LEFT JOIN queue_entry e
         ON e.queue_id = q.id AND e.status IN ('WAITING','PLAYING')
       GROUP BY q.id`,
    )
    .all() as Array<{ venue_slug: string; machine_slug: string; c: number }>;
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(`${row.venue_slug}/${row.machine_slug}`, Number(row.c ?? 0));
  }
  return map;
}
