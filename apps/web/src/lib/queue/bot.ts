import { getDb, nowIso } from "../db";
import { CITIES, venueBySlug } from "../constants/catalog";
import { getVenueMetaBySlug, isVenueOpenNow } from "../settings";
import {
  getQueueBySlug,
  listActiveEntries,
  type EntryRow,
  type PartyRow,
} from "./core";
import { processTimeouts } from "./timeouts";
import { buildSlots } from "./views";

export type BotCatalogMachine = {
  citySlug: string;
  cityName: string;
  districtSlug: string;
  districtName: string;
  venueSlug: string;
  venueName: string;
  machineSlug: string;
  machineName: string;
  queueId: string;
  queueStatus: "OPEN" | "PAUSED" | "CLOSED";
  activeCount: number;
  hasPlaying: boolean;
  isOpenHours: boolean;
  groupUmo: string | null;
};

export type BotHeadPlayer = {
  entryId: string;
  displayName: string;
  qq: string | null;
};

export type BotQueueDetail = {
  venueSlug: string;
  venueName: string;
  machineSlug: string;
  machineName: string;
  districtName: string;
  queueStatus: "OPEN" | "PAUSED" | "CLOSED";
  machineIdle: boolean;
  groupUmo: string | null;
  head: {
    playMode: "SOLO" | "DUO";
    players: BotHeadPlayer[];
  } | null;
  now: string;
};

function districtForVenue(venueSlug: string): {
  citySlug: string;
  cityName: string;
  districtSlug: string;
  districtName: string;
} {
  for (const city of CITIES) {
    for (const district of city.districts) {
      if (district.venues.some((v) => v.slug === venueSlug)) {
        return {
          citySlug: city.slug,
          cityName: city.name,
          districtSlug: district.slug,
          districtName: district.name,
        };
      }
    }
  }
  const meta = venueBySlug(venueSlug);
  return {
    citySlug: "",
    cityName: "",
    districtSlug: "",
    districtName: meta?.regionName || "",
  };
}

function groupUmoForVenue(venueSlug: string): string | null {
  const meta = getVenueMetaBySlug(venueSlug);
  const value = meta?.groupUmo?.trim();
  return value || null;
}

function qqByUserId(userIds: string[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  if (userIds.length === 0) return map;
  const placeholders = userIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT id, qq FROM app_user WHERE id IN (${placeholders})`,
    )
    .all(...userIds) as Array<{ id: string; qq: string | null }>;
  for (const row of rows) {
    map.set(row.id, row.qq || null);
  }
  return map;
}

/** City-wide machine catalog for bot hot-set selection. */
export function getBotCatalog(): { machines: BotCatalogMachine[]; now: string } {
  const rows = getDb()
    .prepare(
      `SELECT q.id AS queue_id, q.name AS machine_name, q.slug AS machine_slug,
              q.status AS queue_status, v.name AS venue_name, v.slug AS venue_slug,
              v.group_umo AS group_umo,
              COALESCE(active.c, 0) AS active_count,
              COALESCE(playing.c, 0) AS playing_count
       FROM queue q
       JOIN venue v ON v.id = q.venue_id
       LEFT JOIN (
         SELECT queue_id, COUNT(*) AS c FROM queue_entry
         WHERE status IN ('WAITING','PLAYING') GROUP BY queue_id
       ) active ON active.queue_id = q.id
       LEFT JOIN (
         SELECT queue_id, COUNT(*) AS c FROM queue_entry
         WHERE status = 'PLAYING' GROUP BY queue_id
       ) playing ON playing.queue_id = q.id
       WHERE v.is_active = 1
       ORDER BY v.name, q.name`,
    )
    .all() as Array<{
    queue_id: string;
    machine_name: string;
    machine_slug: string;
    queue_status: "OPEN" | "PAUSED" | "CLOSED";
    venue_name: string;
    venue_slug: string;
    group_umo: string | null;
    active_count: number;
    playing_count: number;
  }>;

  const machines: BotCatalogMachine[] = rows.map((row) => {
    const place = districtForVenue(row.venue_slug);
    return {
      citySlug: place.citySlug,
      cityName: place.cityName,
      districtSlug: place.districtSlug,
      districtName: place.districtName || "",
      venueSlug: row.venue_slug,
      venueName: row.venue_name,
      machineSlug: row.machine_slug,
      machineName: row.machine_name,
      queueId: row.queue_id,
      queueStatus: row.queue_status,
      activeCount: Number(row.active_count || 0),
      hasPlaying: Number(row.playing_count || 0) > 0,
      isOpenHours: isVenueOpenNow(row.venue_slug),
      groupUmo: (row.group_umo || "").trim() || null,
    };
  });

  return { machines, now: nowIso() };
}

function headPlayersFromEntries(entries: EntryRow[]): BotHeadPlayer[] {
  const qqMap = qqByUserId(entries.map((entry) => entry.user_id));
  return entries.map((entry) => ({
    entryId: entry.id,
    displayName: entry.nickname,
    qq: qqMap.get(entry.user_id) ?? null,
  }));
}

/** Single-machine detail including optional head QQ numbers for @. */
export function getBotQueueDetail(
  venueSlug: string,
  machineSlug: string,
): BotQueueDetail | null {
  const queue = getQueueBySlug(venueSlug, machineSlug);
  if (!queue) return null;
  processTimeouts(queue.id);

  const active = listActiveEntries(queue.id);
  const parties = new Map<string, PartyRow>();
  const partyRows = getDb()
    .prepare(
      `SELECT * FROM queue_party WHERE queue_id = ? AND status IN ('SEEKING','PENDING','CONFIRMED')`,
    )
    .all(queue.id) as PartyRow[];
  for (const party of partyRows) parties.set(party.id, party);

  const built = buildSlots(active, parties, null);
  const machineIdle = !built.slots.some((slot) => slot.status === "PLAYING");
  const headSlot = built.slots.find(
    (slot) => slot.status === "WAITING" && slot.position === 1,
  );

  let head: BotQueueDetail["head"] = null;
  if (machineIdle && headSlot) {
    const headEntries = headSlot.entries
      .map((view) => active.find((row) => row.id === view.id))
      .filter((row): row is EntryRow => Boolean(row));
    head = {
      playMode: headSlot.playMode,
      players:
        headEntries.length > 0
          ? headPlayersFromEntries(headEntries)
          : headSlot.entries.map((entry) => ({
              entryId: entry.id,
              displayName: entry.profile.displayName,
              qq: null,
            })),
    };
  }

  const place = districtForVenue(queue.venue_slug);
  return {
    venueSlug: queue.venue_slug,
    venueName: queue.venue_name,
    machineSlug: queue.slug,
    machineName: queue.name,
    districtName: place.districtName || "",
    queueStatus: queue.status,
    machineIdle,
    groupUmo: groupUmoForVenue(queue.venue_slug),
    head,
    now: nowIso(),
  };
}

/** Cooldown / head key helper (shared with tests and docs). */
export function botHeadCooldownKey(
  machineSlug: string,
  players: Array<{ qq?: string | null }>,
): string {
  const qqs = players
    .map((player) => (player.qq || "").trim())
    .filter(Boolean)
    .sort();
  return `${machineSlug}_${qqs.join("_")}`;
}
