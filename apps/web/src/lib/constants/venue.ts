export const VENUE = {
  id: "venue-template",
  name: "示例场地",
  slug: "sample-venue",
  timezone: "Asia/Shanghai",
} as const;

export const VENUE_HOURS = {
  openMinute: 10 * 60,
  closeMinute: 22 * 60,
  label: "10:00-22:00",
} as const;

export const MACHINES = [
  {
    id: "queue-a",
    venueId: VENUE.id,
    name: "机台 A",
    slug: "machine-a",
    subtitle: "示例机台 A",
    accent: "coral" as const,
  },
  {
    id: "queue-b",
    venueId: VENUE.id,
    name: "机台 B",
    slug: "machine-b",
    subtitle: "示例机台 B",
    accent: "mint" as const,
  },
] as const;

export type MachineSlug = (typeof MACHINES)[number]["slug"];

export function machineBySlug(slug: string) {
  return MACHINES.find((m) => m.slug === slug) ?? null;
}

export function queuePath(slug: MachineSlug | string) {
  return `/queue/${VENUE.slug}/${slug}`;
}

export function isVenueOpenAt(nowMs = Date.now()) {
  // Enables deterministic E2E queue tests without changing production hours.
  if (process.env.NODE_ENV !== "production" && process.env.VIRTUALWAIT_TEST_NOW) {
    const configured = Date.parse(process.env.VIRTUALWAIT_TEST_NOW);
    if (Number.isFinite(configured)) nowMs = configured;
  }
  const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
  const shanghaiNow = new Date(nowMs + shanghaiOffsetMs);
  const minutes =
    shanghaiNow.getUTCHours() * 60 + shanghaiNow.getUTCMinutes();
  return minutes >= VENUE_HOURS.openMinute && minutes < VENUE_HOURS.closeMinute;
}
