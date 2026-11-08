import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-checkin-"));
process.env.CHECKIN_WINDOW_SEC = "600";
process.env.CHECKIN_GRACE_WINDOWS = "1";

const WINDOW_MS = 600_000;

test("venue check-in codes rotate on a time window and accept one grace window", async () => {
  const { getDb } = await import("../db");
  const {
    checkinCodeForWindow,
    getVenueCheckinCode,
    rotateVenueCheckinSecret,
    verifyVenueCheckinCode,
  } = await import("./checkin");

  const db = getDb();
  const venue = db
    .prepare(`SELECT id, slug FROM venue ORDER BY slug LIMIT 1`)
    .get() as { id: string; slug: string };
  assert.ok(venue, "catalog venue must be seeded");

  const base = Date.now(); // inside the window the rotation below also uses
  const current = getVenueCheckinCode(venue.id, base);
  assert.ok(current);
  assert.match(current.code, /^\d{6}$/);
  assert.equal(current.windowSec, 600);
  assert.equal(current.venueSlug, venue.slug);

  // Stable inside the window, different in the next one.
  assert.equal(getVenueCheckinCode(venue.id, base + 1_000)?.code, current.code);
  const next = getVenueCheckinCode(venue.id, base + WINDOW_MS);
  assert.ok(next);
  assert.notEqual(next.code, current.code);

  // Current window and the immediately previous one are accepted.
  assert.equal(verifyVenueCheckinCode(venue.id, current.code, base), true);
  assert.equal(
    verifyVenueCheckinCode(venue.id, current.code, base + WINDOW_MS),
    true,
    "previous window stays valid inside the grace window",
  );
  assert.equal(
    verifyVenueCheckinCode(venue.id, current.code, base + 2 * WINDOW_MS),
    false,
    "codes older than the grace window must be rejected",
  );

  // Shape and content checks.
  assert.equal(verifyVenueCheckinCode(venue.id, "abcdef", base), false);
  assert.equal(verifyVenueCheckinCode(venue.id, "", base), false);
  assert.equal(verifyVenueCheckinCode("venue-does-not-exist", current.code, base), false);
  const other = db
    .prepare(`SELECT id FROM venue WHERE id != ? ORDER BY slug LIMIT 1`)
    .get(venue.id) as { id: string } | undefined;
  if (other) {
    assert.equal(
      verifyVenueCheckinCode(other.id, current.code, base),
      false,
      "a code must not be valid at another venue",
    );
  }

  // Rotation invalidates the previous code immediately.
  const rotated = rotateVenueCheckinSecret(venue.id);
  assert.ok(rotated);
  assert.notEqual(rotated.code, current.code);
  assert.equal(verifyVenueCheckinCode(venue.id, current.code, base), false);
  assert.equal(verifyVenueCheckinCode(venue.id, rotated.code, base), true);

  // The derivation is deterministic for a given secret + window.
  assert.equal(checkinCodeForWindow("secret", 42), checkinCodeForWindow("secret", 42));
  assert.notEqual(checkinCodeForWindow("secret", 42), checkinCodeForWindow("secret", 43));
});
