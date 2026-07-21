import Link from "next/link";
import { notFound } from "next/navigation";
import {
  cityBySlug,
  districtPath,
  type DistrictDef,
} from "@/lib/constants/catalog";
import { isVenueOpenNow } from "@/lib/settings";
import { ArrowRight } from "lucide-react";

function RegionSection({
  citySlug,
  title,
  items,
}: {
  citySlug: string;
  title: string;
  items: readonly DistrictDef[];
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-ink-700">{title}</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((district) => {
          const openCount = district.venues.filter((venue) =>
            isVenueOpenNow(venue.slug),
          ).length;
          return (
            <Link
              key={district.id}
              href={districtPath(citySlug, district.slug)}
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
              <ArrowRight className="h-4 w-4 text-ink-400 group-hover:text-ink-700" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export default async function CityPage({
  params,
}: {
  params: Promise<{ citySlug: string }>;
}) {
  const { citySlug } = await params;
  const city = cityBySlug(citySlug);
  if (!city) notFound();

  const districts = city.districts.filter((d) => d.kind === "district");
  const counties = city.districts.filter((d) => d.kind === "county");

  return (
    <div className="space-y-4">
      <section className="panel p-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="font-display text-2xl font-semibold text-ink-950">
            {city.name}
          </h1>
          <Link className="btn-ghost" href="/">
            首页
          </Link>
        </div>
      </section>

      <RegionSection citySlug={city.slug} title="区" items={districts} />
      <RegionSection citySlug={city.slug} title="县" items={counties} />
    </div>
  );
}
