export const VENUE = {
  id: "venue-heyuan-jianji-anime",
  name: "河源坚基动漫E族",
  slug: "heyuan-jianji-anime",
  timezone: "Asia/Shanghai",
} as const;

export const VENUE_HOURS = {
  openMinute: 10 * 60,
  closeMinute: 22 * 60,
  label: "10:00-22:00",
} as const;

export const MACHINES = [
  {
    id: "queue-old",
    venueId: VENUE.id,
    name: "旧机",
    slug: "old",
    subtitle: "较早引进",
    accent: "coral" as const,
  },
  {
    id: "queue-new",
    venueId: VENUE.id,
    name: "新机",
    slug: "new",
    subtitle: "较晚引进",
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
