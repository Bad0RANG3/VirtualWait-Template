import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_MACHINES,
  ALL_VENUES,
  CITIES,
  cityBySlug,
  districtBySlug,
  machineBySlug,
  queuePath,
  venueBySlug,
} from "./catalog";

test("template catalog exposes sample city/district/venue/machine slugs", () => {
  assert.ok(CITIES.length >= 1);
  assert.ok(ALL_VENUES.length >= 2);
  assert.ok(ALL_MACHINES.length >= 3);

  const city = cityBySlug("sample-city");
  assert.ok(city);
  assert.equal(city?.name, "示例市");

  const district = districtBySlug("sample-city", "sample-district");
  assert.ok(district);
  assert.equal(district?.district.name, "示例区");

  const venue = venueBySlug("sample-venue");
  assert.ok(venue);
  assert.equal(venue?.name, "示例中心店");

  const machine = machineBySlug("sample-venue", "machine-a");
  assert.ok(machine);
  assert.equal(machine?.id, "queue-a");
  assert.equal(queuePath("sample-venue", "machine-a"), "/queue/sample-venue/machine-a");
});
