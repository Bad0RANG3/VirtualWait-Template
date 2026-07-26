/** Lightweight DB-agnostic time helpers used across the application. */

export function nowIso() {
  return new Date().toISOString();
}

export function addSeconds(iso: string, seconds: number) {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}
