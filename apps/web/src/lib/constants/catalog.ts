/**
 * Template catalog: city → district/county → venue → machine.
 * Replace sample values when deploying a real city deployment.
 */

export type MachineAccent = "coral" | "mint" | "sky" | "sun";
export type RegionKind = "district" | "county";

export type MachineDef = {
  id: string;
  name: string;
  slug: string;
  subtitle: string;
  accent: MachineAccent;
  /** 该机台一次游玩所需硬币数 */
  coinCost?: number;
};

export type VenueHours = {
  openMinute: number;
  closeMinute: number;
  label: string;
};

export type VenueDef = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  hours: VenueHours;
  /** 区/县名称，例如「示例区」 */
  regionName?: string;
  /** 区 / 县 */
  regionKind?: RegionKind;
  /** 场地地址 */
  address?: string;
  /** 该店机台数量（确切信息展示用） */
  machineCount?: number;
  machines: readonly MachineDef[];
};

export type DistrictDef = {
  id: string;
  name: string;
  slug: string;
  /** 区 / 县 / 县级市 */
  kind: RegionKind;
  venues: readonly VenueDef[];
};

export type CityDef = {
  id: string;
  name: string;
  slug: string;
  districts: readonly DistrictDef[];
};

const DEFAULT_HOURS: VenueHours = {
  openMinute: 10 * 60,
  closeMinute: 22 * 60,
  label: "10:00-22:00",
};

/**
 * Sample multi-venue catalog for the template.
 * Keep slugs stable once published; they appear in queue URLs.
 */
export const CITIES: readonly CityDef[] = [
  {
    id: "city-sample",
    name: "示例市",
    slug: "sample-city",
    districts: [
      {
        id: "district-sample-central",
        name: "示例区",
        slug: "sample-district",
        kind: "district",
        venues: [
          {
            id: "venue-sample-central",
            name: "示例中心店",
            slug: "sample-venue",
            timezone: "Asia/Shanghai",
            hours: DEFAULT_HOURS,
            regionName: "示例区",
            regionKind: "district",
            address: "示例市示例区示例路 1 号",
            machineCount: 2,
            machines: [
              {
                id: "queue-a",
                name: "机台 A",
                slug: "machine-a",
                subtitle: "示例机台 A",
                accent: "coral",
                coinCost: 1,
              },
              {
                id: "queue-b",
                name: "机台 B",
                slug: "machine-b",
                subtitle: "示例机台 B",
                accent: "mint",
                coinCost: 1,
              },
            ],
          },
        ],
      },
      {
        id: "county-sample-east",
        name: "示例县",
        slug: "sample-county",
        kind: "county",
        venues: [
          {
            id: "venue-sample-east",
            name: "示例东城店",
            slug: "sample-east-venue",
            timezone: "Asia/Shanghai",
            hours: DEFAULT_HOURS,
            regionName: "示例县",
            regionKind: "county",
            address: "示例市示例县东城路 8 号",
            machineCount: 1,
            machines: [
              {
                id: "queue-east-a",
                name: "机台 1",
                slug: "machine-1",
                subtitle: "示例东城机台",
                accent: "sky",
                coinCost: 2,
              },
            ],
          },
        ],
      },
    ],
  },
] as const;

export const ALL_VENUES: readonly VenueDef[] = CITIES.flatMap((city) =>
  city.districts.flatMap((district) => district.venues),
);

export const ALL_MACHINES = ALL_VENUES.flatMap((venue) =>
  venue.machines.map((machine) => ({
    ...machine,
    venueId: venue.id,
    venueSlug: venue.slug,
    venueName: venue.name,
  })),
);

export function cityBySlug(slug: string): CityDef | null {
  return CITIES.find((city) => city.slug === slug) ?? null;
}

export function districtBySlug(
  citySlug: string,
  districtSlug: string,
): { city: CityDef; district: DistrictDef } | null {
  const city = cityBySlug(citySlug);
  if (!city) return null;
  const district = city.districts.find((item) => item.slug === districtSlug);
  if (!district) return null;
  return { city, district };
}

export function venueBySlug(slug: string): VenueDef | null {
  return ALL_VENUES.find((venue) => venue.slug === slug) ?? null;
}

export function machineBySlug(
  venueSlug: string,
  machineSlug: string,
): (MachineDef & { venueId: string; venueSlug: string; venueName: string }) | null {
  return (
    ALL_MACHINES.find(
      (machine) =>
        machine.venueSlug === venueSlug && machine.slug === machineSlug,
    ) ?? null
  );
}

export function queuePath(venueSlug: string, machineSlug: string) {
  return `/queue/${venueSlug}/${machineSlug}`;
}

export function cityPath(citySlug: string) {
  return `/city/${citySlug}`;
}

export function districtPath(citySlug: string, districtSlug: string) {
  return `/city/${citySlug}/${districtSlug}`;
}

export function districtKindLabel(kind: DistrictDef["kind"]) {
  return kind === "county" ? "县" : "区";
}

/** Catalog-only open hours (ignores DB admin overrides). Prefer settings.isVenueOpenNow for live checks. */
export function venueHours(venueSlug?: string | null): VenueHours {
  if (!venueSlug) return DEFAULT_HOURS;
  return venueBySlug(venueSlug)?.hours ?? DEFAULT_HOURS;
}

/** Prefer ALL_VENUES / venueBySlug for multi-venue installs. */
export const VENUE = ALL_VENUES[0]!;
/** Prefer venueHours(venueSlug). */
export const VENUE_HOURS = DEFAULT_HOURS;
/** Prefer ALL_MACHINES filtered by venue. */
export const MACHINES = VENUE.machines;
