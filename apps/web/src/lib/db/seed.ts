import type { Db } from "./sqlite";
import { ALL_VENUES } from "../constants/catalog";

/** Insert or update catalog venue/machine defaults without overwriting admin
 *  edits.  Called once per process lifetime on first ``getDb()``. */
export function seed(db: Db) {
  const now = new Date().toISOString();
  for (const venue of ALL_VENUES) {
    db.prepare(
      `INSERT OR IGNORE INTO venue
       (id, name, slug, timezone, is_active, address, region_name, region_kind,
        machine_count, open_minute, close_minute, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      venue.id, venue.name, venue.slug, venue.timezone,
      venue.address ?? null, venue.regionName ?? null, venue.regionKind ?? null,
      venue.machineCount ?? venue.machines.length,
      venue.hours.openMinute, venue.hours.closeMinute, now, now,
    );

    db.prepare(
      `UPDATE venue
       SET address = COALESCE(NULLIF(address, ''), ?),
           region_name = COALESCE(NULLIF(region_name, ''), ?),
           region_kind = COALESCE(NULLIF(region_kind, ''), ?),
           machine_count = COALESCE(machine_count, ?),
           open_minute = COALESCE(open_minute, ?),
           close_minute = COALESCE(close_minute, ?),
           updated_at = CASE
             WHEN (address IS NULL OR address = '')
               OR (region_name IS NULL OR region_name = '')
               OR (region_kind IS NULL OR region_kind = '')
               OR machine_count IS NULL
               OR open_minute IS NULL
               OR close_minute IS NULL
             THEN ? ELSE updated_at
           END
       WHERE id = ?`
    ).run(
      venue.address ?? null, venue.regionName ?? null, venue.regionKind ?? null,
      venue.machineCount ?? venue.machines.length,
      venue.hours.openMinute, venue.hours.closeMinute, now, venue.id,
    );

    for (const machine of venue.machines) {
      const coinCost = machine.coinCost ?? 1;
      db.prepare(
        `INSERT OR IGNORE INTO queue
         (id, venue_id, name, slug, status, next_sequence, coin_cost, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'OPEN', 1, ?, ?, ?)`
      ).run(machine.id, venue.id, machine.name, machine.slug, coinCost, now, now);

      db.prepare(
        `UPDATE queue
         SET coin_cost = COALESCE(NULLIF(coin_cost, 0), ?),
             updated_at = CASE
               WHEN coin_cost IS NULL OR coin_cost = 0 THEN ? ELSE updated_at
             END
         WHERE id = ?`
      ).run(coinCost, now, machine.id);
    }
  }
}
