/**
 * Venue open-hours helpers.
 * Asia/Shanghai is treated as fixed UTC+8 (no DST), matching auth day-key logic.
 */

import type { VenueHours } from "../constants/catalog";

export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const DEFAULT_HOURS: VenueHours = {
  openMinute: 10 * 60,
  closeMinute: 22 * 60,
  label: "10:00-22:00",
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/** Format HH:MM from minutes since midnight. */
export function formatMinutesAsTime(totalMinutes: number): string {
  const mins = Math.floor(totalMinutes);
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

/** Format for HTML time inputs (allows 24:00 via clamp in callers). */
export function minutesToTimeInput(totalMinutes: number): string {
  const mins = Math.max(0, Math.min(24 * 60, Math.floor(totalMinutes || 0)));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

export function hoursLabelFromMinutes(openMinute: number, closeMinute: number): string {
  return `${formatMinutesAsTime(openMinute)}-${formatMinutesAsTime(closeMinute)}`;
}

/** Parse "HH:MM" or "H:MM" into minutes since midnight. */
export function parseTimeToMinutes(value: string): number | null {
  const text = value.trim();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function normalizeVenueHours(
  openMinute: number,
  closeMinute: number,
): VenueHours {
  const open = Math.floor(openMinute);
  const close = Math.floor(closeMinute);
  if (!Number.isFinite(open) || !Number.isFinite(close)) {
    throw new Error("INVALID_VENUE_HOURS");
  }
  if (open < 0 || open > 23 * 60 + 59 || close < 0 || close > 24 * 60) {
    throw new Error("INVALID_VENUE_HOURS");
  }
  if (close <= open) {
    throw new Error("INVALID_VENUE_HOURS");
  }
  return {
    openMinute: open,
    closeMinute: close,
    label: hoursLabelFromMinutes(open, close),
  };
}

export function defaultVenueHours(): VenueHours {
  return { ...DEFAULT_HOURS };
}

/** Minutes since midnight in Asia/Shanghai for the given epoch ms. */
export function shanghaiMinutesOfDay(nowMs = Date.now()): number {
  // Deterministic E2E: pin "now" without changing production hours.
  if (process.env.NODE_ENV !== "production" && process.env.VIRTUALWAIT_TEST_NOW) {
    const configured = Date.parse(process.env.VIRTUALWAIT_TEST_NOW);
    if (Number.isFinite(configured)) nowMs = configured;
  }
  const shanghaiNow = new Date(nowMs + SHANGHAI_OFFSET_MS);
  return shanghaiNow.getUTCHours() * 60 + shanghaiNow.getUTCMinutes();
}

export function isWithinHours(hours: VenueHours, nowMs = Date.now()): boolean {
  const minutes = shanghaiMinutesOfDay(nowMs);
  return minutes >= hours.openMinute && minutes < hours.closeMinute;
}

export function coerceVenueHours(input: {
  openMinute?: number | null;
  closeMinute?: number | null;
  label?: string | null;
  fallback?: VenueHours;
}): VenueHours {
  const fallback = input.fallback ?? DEFAULT_HOURS;
  const open =
    typeof input.openMinute === "number" && Number.isFinite(input.openMinute)
      ? input.openMinute
      : fallback.openMinute;
  const close =
    typeof input.closeMinute === "number" && Number.isFinite(input.closeMinute)
      ? input.closeMinute
      : fallback.closeMinute;
  try {
    return normalizeVenueHours(open, close);
  } catch {
    return { ...fallback };
  }
}
