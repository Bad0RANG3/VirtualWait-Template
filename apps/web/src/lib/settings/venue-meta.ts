import { getDb, nowIso } from "../db";
import {
  venueBySlug,
  type RegionKind,
  type VenueHours,
} from "../constants/catalog";
import {
  coerceVenueHours,
  defaultVenueHours,
  isWithinHours,
  normalizeVenueHours,
} from "../time/hours";

export type VenueMeta = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  address: string;
  regionName: string;
  regionKind: RegionKind | "";
  machineCount: number;
  openMinute: number;
  closeMinute: number;
  hoursLabel: string;
  /** AstrBot UMO for queue-idle @ notifications; empty if unset. */
  groupUmo: string;
  isActive: boolean;
  updatedAt: string;
  machines: MachineMeta[];
};

export type MachineMeta = {
  id: string;
  venueId: string;
  venueName: string;
  venueSlug: string;
  name: string;
  slug: string;
  status: "OPEN" | "PAUSED" | "CLOSED";
  coinCost: number;
  updatedAt: string;
};

type MachineRow = {
  id: string;
  venue_id: string;
  name: string;
  slug: string;
  status: "OPEN" | "PAUSED" | "CLOSED";
  coin_cost: number | null;
  updated_at: string;
  venue_name: string;
  venue_slug: string;
};

function mapMachineRow(row: MachineRow): MachineMeta {
  return {
    id: row.id,
    venueId: row.venue_id,
    venueName: row.venue_name,
    venueSlug: row.venue_slug,
    name: row.name,
    slug: row.slug,
    status: row.status,
    coinCost:
      typeof row.coin_cost === "number" && Number.isFinite(row.coin_cost)
        ? row.coin_cost
        : 1,
    updatedAt: row.updated_at,
  };
}

function catalogHoursFallback(slug: string): VenueHours {
  return venueBySlug(slug)?.hours ?? defaultVenueHours();
}

export function listMachinesMeta(): MachineMeta[] {
  const rows = getDb()
    .prepare(
      `SELECT q.id, q.venue_id, q.name, q.slug, q.status, q.coin_cost, q.updated_at,
              v.name AS venue_name, v.slug AS venue_slug
       FROM queue q
       JOIN venue v ON v.id = q.venue_id
       ORDER BY v.name, q.name`,
    )
    .all() as Array<{
    id: string;
    venue_id: string;
    name: string;
    slug: string;
    status: "OPEN" | "PAUSED" | "CLOSED";
    coin_cost: number | null;
    updated_at: string;
    venue_name: string;
    venue_slug: string;
  }>;

  return rows.map(mapMachineRow);
}

export function getMachineCoinCost(queueId: string): number {
  const row = getDb()
    .prepare(`SELECT coin_cost FROM queue WHERE id = ?`)
    .get(queueId) as { coin_cost: number | null } | undefined;
  if (!row) return 1;
  return typeof row.coin_cost === "number" && row.coin_cost > 0 ? row.coin_cost : 1;
}

export function listVenueMeta(): VenueMeta[] {
  const machines = listMachinesMeta();
  const byVenue = new Map<string, MachineMeta[]>();
  for (const machine of machines) {
    const list = byVenue.get(machine.venueId) || [];
    list.push(machine);
    byVenue.set(machine.venueId, list);
  }

  const rows = getDb()
    .prepare(
      `SELECT id, name, slug, timezone, address, region_name, region_kind,
              machine_count, open_minute, close_minute, group_umo, is_active, updated_at
       FROM venue
       ORDER BY name`,
    )
    .all() as Array<{
    id: string;
    name: string;
    slug: string;
    timezone: string;
    address: string | null;
    region_name: string | null;
    region_kind: string | null;
    machine_count: number | null;
    open_minute: number | null;
    close_minute: number | null;
    group_umo: string | null;
    is_active: number;
    updated_at: string;
  }>;

  return rows.map((row) => {
    const venueMachines = byVenue.get(row.id) || [];
    const fallback = catalogHoursFallback(row.slug);
    const hours = coerceVenueHours({
      openMinute: row.open_minute,
      closeMinute: row.close_minute,
      fallback,
    });
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      timezone: row.timezone,
      address: row.address || "",
      regionName: row.region_name || "",
      regionKind:
        row.region_kind === "county" || row.region_kind === "district"
          ? row.region_kind
          : "",
      machineCount:
        typeof row.machine_count === "number" && Number.isFinite(row.machine_count)
          ? row.machine_count
          : venueMachines.length,
      openMinute: hours.openMinute,
      closeMinute: hours.closeMinute,
      hoursLabel: hours.label,
      groupUmo: row.group_umo || "",
      isActive: Boolean(row.is_active),
      updatedAt: row.updated_at,
      machines: venueMachines,
    };
  });
}

export function getVenueMetaBySlug(slug: string): VenueMeta | null {
  const row = getDb()
    .prepare(
      `SELECT id, name, slug, timezone, address, region_name, region_kind,
              machine_count, open_minute, close_minute, group_umo, is_active, updated_at
       FROM venue
       WHERE slug = ?`,
    )
    .get(slug) as
    | {
        id: string;
        name: string;
        slug: string;
        timezone: string;
        address: string | null;
        region_name: string | null;
        region_kind: string | null;
        machine_count: number | null;
        open_minute: number | null;
        close_minute: number | null;
        group_umo: string | null;
        is_active: number;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;

  const machineRows = getDb()
    .prepare(
      `SELECT q.id, q.venue_id, q.name, q.slug, q.status, q.coin_cost, q.updated_at,
              v.name AS venue_name, v.slug AS venue_slug
       FROM queue q
       JOIN venue v ON v.id = q.venue_id
       WHERE q.venue_id = ?
       ORDER BY q.name`,
    )
    .all(row.id) as Array<{
    id: string;
    venue_id: string;
    name: string;
    slug: string;
    status: "OPEN" | "PAUSED" | "CLOSED";
    coin_cost: number | null;
    updated_at: string;
    venue_name: string;
    venue_slug: string;
  }>;
  const machines = machineRows.map(mapMachineRow);
  const fallback = catalogHoursFallback(row.slug);
  const hours = coerceVenueHours({
    openMinute: row.open_minute,
    closeMinute: row.close_minute,
    fallback,
  });
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    address: row.address || "",
    regionName: row.region_name || "",
    regionKind:
      row.region_kind === "county" || row.region_kind === "district"
        ? row.region_kind
        : "",
    machineCount:
      typeof row.machine_count === "number" && Number.isFinite(row.machine_count)
        ? row.machine_count
        : machines.length,
    openMinute: hours.openMinute,
    closeMinute: hours.closeMinute,
    hoursLabel: hours.label,
    groupUmo: row.group_umo || "",
    isActive: Boolean(row.is_active),
    updatedAt: row.updated_at,
    machines,
  };
}

/** Live hours for a venue slug: DB override first, then catalog default. */
export function getVenueHoursBySlug(slug?: string | null): VenueHours {
  if (!slug) return defaultVenueHours();
  const row = getDb()
    .prepare(
      `SELECT open_minute, close_minute FROM venue WHERE slug = ?`,
    )
    .get(slug) as
    | { open_minute: number | null; close_minute: number | null }
    | undefined;
  if (!row) return catalogHoursFallback(slug);
  return coerceVenueHours({
    openMinute: row.open_minute,
    closeMinute: row.close_minute,
    fallback: catalogHoursFallback(slug),
  });
}

export function isVenueOpenNow(slug?: string | null, nowMs = Date.now()) {
  return isWithinHours(getVenueHoursBySlug(slug), nowMs);
}

export function updateVenueMeta(
  venueId: string,
  input: {
    address: string;
    regionName: string;
    regionKind: RegionKind | "";
    machineCount: number;
    openMinute: number;
    closeMinute: number;
    groupUmo?: string;
  },
) {
  const address = input.address.trim().slice(0, 200);
  const regionName = input.regionName.trim().slice(0, 40);
  const regionKind = input.regionKind;
  if (regionKind && regionKind !== "district" && regionKind !== "county") {
    throw new Error("INVALID_REGION_KIND");
  }
  const machineCount = Math.floor(input.machineCount);
  if (!Number.isFinite(machineCount) || machineCount < 0 || machineCount > 999) {
    throw new Error("INVALID_MACHINE_COUNT");
  }
  const hours = normalizeVenueHours(input.openMinute, input.closeMinute);
  const groupUmo = (input.groupUmo ?? "").trim().slice(0, 200);

  const db = getDb();
  const existing = db
    .prepare(`SELECT id, slug FROM venue WHERE id = ?`)
    .get(venueId) as { id: string; slug: string } | undefined;
  if (!existing) throw new Error("VENUE_NOT_FOUND");

  db.prepare(
    `UPDATE venue
     SET address = ?,
         region_name = ?,
         region_kind = ?,
         machine_count = ?,
         open_minute = ?,
         close_minute = ?,
         group_umo = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    address || null,
    regionName || null,
    regionKind || null,
    machineCount,
    hours.openMinute,
    hours.closeMinute,
    groupUmo || null,
    nowIso(),
    venueId,
  );

  const venue = getVenueMetaBySlug(existing.slug);
  if (!venue) throw new Error("VENUE_NOT_FOUND");
  return venue;
}

export function updateMachineMeta(
  machineId: string,
  input: {
    coinCost: number;
  },
) {
  const coinCost = Math.floor(input.coinCost);
  if (!Number.isFinite(coinCost) || coinCost < 1 || coinCost > 99) {
    throw new Error("INVALID_COIN_COST");
  }
  const db = getDb();
  const existing = db
    .prepare(`SELECT id FROM queue WHERE id = ?`)
    .get(machineId) as { id: string } | undefined;
  if (!existing) throw new Error("QUEUE_NOT_FOUND");

  db.prepare(
    `UPDATE queue
     SET coin_cost = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(coinCost, nowIso(), machineId);

  const row = getDb()
    .prepare(
      `SELECT q.id, q.venue_id, q.name, q.slug, q.status, q.coin_cost, q.updated_at,
              v.name AS venue_name, v.slug AS venue_slug
       FROM queue q
       JOIN venue v ON v.id = q.venue_id
       WHERE q.id = ?`,
    )
    .get(machineId) as
    | {
        id: string;
        venue_id: string;
        name: string;
        slug: string;
        status: "OPEN" | "PAUSED" | "CLOSED";
        coin_cost: number | null;
        updated_at: string;
        venue_name: string;
        venue_slug: string;
      }
    | undefined;
  if (!row) throw new Error("QUEUE_NOT_FOUND");
  return mapMachineRow(row);
}
