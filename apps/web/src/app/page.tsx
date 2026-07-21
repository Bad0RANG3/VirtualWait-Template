import Link from "next/link";
import {
  ALL_MACHINES,
  ALL_VENUES,
  CITIES,
  cityPath,
  districtPath,
} from "@/lib/constants/catalog";
import { getSessionUser } from "@/lib/auth/session";
import { countActiveEntriesByMachine } from "@/lib/queue/service";
import { isVenueOpenNow } from "@/lib/settings";
import {
  LocationPicker,
  type PickerCity,
} from "@/components/LocationPicker";
import { ArrowRight, QrCode } from "lucide-react";

export default async function HomePage() {
  const user = await getSessionUser();
  const openVenues = ALL_VENUES.filter((venue) => isVenueOpenNow(venue.slug));
  const totalMachines = ALL_MACHINES.length;
  const activeByMachine = countActiveEntriesByMachine();
  const totalWaiting = ALL_MACHINES.reduce(
    (sum, machine) =>
      sum + (activeByMachine.get(`${machine.venueSlug}/${machine.slug}`) ?? 0),
    0,
  );

  const pickerCities: PickerCity[] = CITIES.map((city) => ({
    slug: city.slug,
    name: city.name,
    districts: city.districts.map((district) => ({
      slug: district.slug,
      name: district.name,
      kind: district.kind,
      venues: district.venues.map((venue) => ({
        slug: venue.slug,
        name: venue.name,
        machines: venue.machines.map((machine) => ({
          slug: machine.slug,
          name: machine.name,
        })),
      })),
    })),
  }));

  return (
    <div className="space-y-4">
      <section className="panel p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-semibold text-ink-950">
              VirtualWait
            </h1>
            <p className="mt-0.5 text-sm text-ink-500">
              {totalWaiting} 在列 · {ALL_VENUES.length} 店 · {totalMachines} 机 ·{" "}
              {openVenues.length} 开
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!user && (
              <Link className="btn-mint" href="/login">
                扫码登录
              </Link>
            )}
            {user && (
              <Link className="btn-ghost" href="/me">
                我的
              </Link>
            )}
            {user?.bound && (
              <Link className="btn-ghost" href="/bind">
                <QrCode className="h-4 w-4" />
                刷新
              </Link>
            )}
          </div>
        </div>
      </section>

      <LocationPicker cities={pickerCities} />

      <section className="space-y-2">
        {CITIES.map((city) => (
          <div key={city.id} className="space-y-2">
            <div className="flex items-center justify-between px-0.5">
              <h2 className="text-sm font-semibold text-ink-800">{city.name}</h2>
              {CITIES.length > 1 && (
                <Link
                  className="text-xs text-ink-500 hover:text-ink-800"
                  href={cityPath(city.slug)}
                >
                  全部
                </Link>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {city.districts.map((district) => {
                const openCount = district.venues.filter((venue) =>
                  isVenueOpenNow(venue.slug),
                ).length;
                return (
                  <Link
                    key={district.id}
                    href={districtPath(city.slug, district.slug)}
                    className="panel group flex items-center justify-between gap-3 p-3.5 transition hover:border-ink-300"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-ink-950">
                        {district.name}
                      </div>
                      <div className="mt-0.5 text-xs text-ink-500">
                        {district.venues.length} 店 · {openCount} 开
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-ink-400 group-hover:text-ink-700" />
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
