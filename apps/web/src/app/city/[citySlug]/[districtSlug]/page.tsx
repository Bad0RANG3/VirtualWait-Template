import Link from "next/link";
import { notFound } from "next/navigation";
import {
  cityPath,
  districtBySlug,
  districtKindLabel,
  queuePath,
} from "@/lib/constants/catalog";
import { countActiveEntriesByMachine } from "@/lib/queue/service";
import { getVenueMetaBySlug, isVenueOpenNow } from "@/lib/settings";
import { ArrowRight } from "lucide-react";

export default async function DistrictPage({
  params,
}: {
  params: Promise<{ citySlug: string; districtSlug: string }>;
}) {
  const { citySlug, districtSlug } = await params;
  const match = districtBySlug(citySlug, districtSlug);
  if (!match) notFound();
  const { city, district } = match;
  const activeByMachine = countActiveEntriesByMachine();

  return (
    <div className="space-y-4">
      <section className="panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs text-ink-500">
              {city.name} · {districtKindLabel(district.kind)}
            </div>
            <h1 className="mt-0.5 font-display text-2xl font-semibold text-ink-950">
              {district.name}
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link className="btn-ghost" href={cityPath(city.slug)}>
              返回
            </Link>
            <Link className="btn-ghost" href="/">
              首页
            </Link>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        {district.venues.map((venue) => {
          const open = isVenueOpenNow(venue.slug);
          const meta = getVenueMetaBySlug(venue.slug);
          const address = meta?.address || venue.address || "";
          const machineCount =
            meta?.machineCount ?? venue.machineCount ?? venue.machines.length;
          const coinByMachineId = new Map(
            (meta?.machines || []).map((m) => [m.id, m.coinCost]),
          );
          return (
            <div key={venue.id} className="panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-display text-lg font-semibold text-ink-950">
                    {venue.name}
                  </h2>
                  <p className="mt-0.5 truncate text-xs text-ink-500">
                    {address || "—"} · {machineCount} 机 ·{" "}
                    {meta?.hoursLabel || "10:00-22:00"}
                  </p>
                </div>
                <span
                  className={`chip ${open ? "bg-mint-50 text-mint-700" : "bg-ink-50 text-ink-500"}`}
                >
                  {open ? "开放" : "关闭"}
                </span>
              </div>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {venue.machines.map((machine) => {
                  const count =
                    activeByMachine.get(`${venue.slug}/${machine.slug}`) ?? 0;
                  const coinCost =
                    coinByMachineId.get(machine.id) ??
                    machine.coinCost ??
                    1;
                  return (
                    <Link
                      key={machine.id}
                      href={queuePath(venue.slug, machine.slug)}
                      className="group flex items-center justify-between gap-3 rounded-md border border-ink-200 bg-ink-50/50 px-3 py-3 transition hover:border-ink-300 hover:bg-white"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-ink-950">
                          {machine.name}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-ink-500">
                          {coinCost} 币 · {count} 人
                        </div>
                      </div>
                      <ArrowRight className="h-4 w-4 text-ink-400 group-hover:text-ink-700" />
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
