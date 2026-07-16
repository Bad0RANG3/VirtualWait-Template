import assert from "node:assert/strict";
import test from "node:test";

import { clientIpFromHeaders } from "./ip";

function headers(values: Record<string, string>) {
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get(name: string) {
      return normalized.get(name.toLowerCase()) ?? null;
    },
  };
}

test("client IP ignores proxy headers unless the deployment explicitly trusts sanitized headers", () => {
  assert.equal(
    clientIpFromHeaders(
      headers({
        "x-forwarded-for": "203.0.113.10",
        "x-real-ip": "203.0.113.11",
        "cf-connecting-ip": "203.0.113.12",
      }),
      false,
    ),
    "unknown",
  );
});

test("client IP uses only the first sanitized X-Forwarded-For address", () => {
  assert.equal(
    clientIpFromHeaders(
      headers({ "x-forwarded-for": "203.0.113.10, 198.51.100.9" }),
      true,
    ),
    "203.0.113.10",
  );
});

test("client IP rejects malformed X-Forwarded-For before falling back to trusted headers", () => {
  assert.equal(
    clientIpFromHeaders(
      headers({
        "x-forwarded-for": "not-an-ip",
        "x-real-ip": "2001:db8::8",
      }),
      true,
    ),
    "2001:db8::8",
  );
});

test("client IP falls back to CF-Connecting-IP only when earlier trusted headers are absent", () => {
  assert.equal(
    clientIpFromHeaders(headers({ "cf-connecting-ip": "198.51.100.20" }), true),
    "198.51.100.20",
  );
});
