"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { districtPath, queuePath } from "@/lib/constants/catalog";

export type PickerMachine = {
  slug: string;
  name: string;
};

export type PickerVenue = {
  slug: string;
  name: string;
  machines: PickerMachine[];
};

export type PickerDistrict = {
  slug: string;
  name: string;
  kind: "district" | "county";
  venues: PickerVenue[];
};

export type PickerCity = {
  slug: string;
  name: string;
  districts: PickerDistrict[];
};

export function LocationPicker({ cities }: { cities: PickerCity[] }) {
  const router = useRouter();
  const [citySlug, setCitySlug] = useState(cities[0]?.slug || "");
  const city = useMemo(
    () => cities.find((item) => item.slug === citySlug) || cities[0] || null,
    [cities, citySlug],
  );

  const districts = useMemo(() => city?.districts || [], [city]);
  const [districtSlug, setDistrictSlug] = useState(districts[0]?.slug || "");
  const district = useMemo(
    () =>
      districts.find((item) => item.slug === districtSlug) ||
      districts[0] ||
      null,
    [districts, districtSlug],
  );

  const venues = useMemo(() => district?.venues || [], [district]);
  const [venueSlug, setVenueSlug] = useState(venues[0]?.slug || "");
  const venue = useMemo(
    () => venues.find((item) => item.slug === venueSlug) || venues[0] || null,
    [venues, venueSlug],
  );

  const machines = useMemo(() => venue?.machines || [], [venue]);
  const [machineSlug, setMachineSlug] = useState(machines[0]?.slug || "");
  const machine = useMemo(
    () =>
      machines.find((item) => item.slug === machineSlug) ||
      machines[0] ||
      null,
    [machines, machineSlug],
  );

  function onCityChange(next: string) {
    setCitySlug(next);
    const nextCity = cities.find((item) => item.slug === next);
    const nextDistrict = nextCity?.districts[0];
    setDistrictSlug(nextDistrict?.slug || "");
    const nextVenue = nextDistrict?.venues[0];
    setVenueSlug(nextVenue?.slug || "");
    setMachineSlug(nextVenue?.machines[0]?.slug || "");
  }

  function onDistrictChange(next: string) {
    setDistrictSlug(next);
    const nextDistrict = districts.find((item) => item.slug === next);
    const nextVenue = nextDistrict?.venues[0];
    setVenueSlug(nextVenue?.slug || "");
    setMachineSlug(nextVenue?.machines[0]?.slug || "");
  }

  function onVenueChange(next: string) {
    setVenueSlug(next);
    const nextVenue = venues.find((item) => item.slug === next);
    setMachineSlug(nextVenue?.machines[0]?.slug || "");
  }

  return (
    <section className="panel p-4 sm:p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {cities.length > 1 && (
          <div>
            <label className="label" htmlFor="pick-city">
              城市
            </label>
            <select
              id="pick-city"
              className="field"
              value={city?.slug || ""}
              onChange={(e) => onCityChange(e.target.value)}
            >
              {cities.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="label" htmlFor="pick-district">
            区 / 县
          </label>
          <select
            id="pick-district"
            className="field"
            value={district?.slug || ""}
            onChange={(e) => onDistrictChange(e.target.value)}
            disabled={!districts.length}
          >
            {districts.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="pick-venue">
            店铺
          </label>
          <select
            id="pick-venue"
            className="field"
            value={venue?.slug || ""}
            onChange={(e) => onVenueChange(e.target.value)}
            disabled={!venues.length}
          >
            {venues.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="pick-machine">
            机台
          </label>
          <select
            id="pick-machine"
            className="field"
            value={machine?.slug || ""}
            onChange={(e) => setMachineSlug(e.target.value)}
            disabled={!machines.length}
          >
            {machines.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={!venue || !machine}
          onClick={() => {
            if (!venue || !machine) return;
            router.push(queuePath(venue.slug, machine.slug));
          }}
        >
          进入
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!city || !district}
          onClick={() => {
            if (!city || !district) return;
            router.push(districtPath(city.slug, district.slug));
          }}
        >
          店铺列表
        </button>
      </div>
    </section>
  );
}
