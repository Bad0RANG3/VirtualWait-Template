import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-rate-limit-"));

test("cleanup only removes buckets whose own window has already ended", async () => {
  const { cleanupExpiredRateLimitBuckets } = await import("./rate-limit");
  const { getDb } = await import("../db");
  const db = getDb();
  const now = Date.now();

  db.prepare(
    `INSERT INTO rate_limit_bucket (key, window_start, window_sec, count, updated_at)
     VALUES ('long-active', ?, 3600, 5, 'x'), ('short-expired', ?, 60, 9, 'x')`,
  ).run(now - 1_800_000, now - 7_200_000);

  cleanupExpiredRateLimitBuckets(now);

  const remaining = db
    .prepare(`SELECT key FROM rate_limit_bucket ORDER BY key`)
    .all() as Array<{ key: string }>;
  assert.deepEqual(
    remaining.map((row) => row.key),
    ["long-active"],
    "an active one-hour bucket must survive a cleanup driven by shorter windows",
  );
});

test("a limited long-window bucket keeps blocking after short-window traffic", async () => {
  const { consumeRateLimit } = await import("./rate-limit");

  assert.deepEqual(
    consumeRateLimit({ key: "account-register:ip:abc", limit: 1, windowSec: 3600 }),
    { ok: true },
  );
  // Traffic from short-window callers (Bot API polls every few seconds) must not
  // reset the long-window counter.
  for (let i = 0; i < 5; i += 1) {
    consumeRateLimit({ key: `bot:catalog:${i}`, limit: 100, windowSec: 60 });
  }
  const second = consumeRateLimit({
    key: "account-register:ip:abc",
    limit: 1,
    windowSec: 3600,
  });
  assert.equal(second.ok, false, "the registration limit must still apply");
});

test("rolled-over windows restart their counter instead of inheriting the old one", async () => {
  const { consumeRateLimit } = await import("./rate-limit");
  const db = await import("../db").then((mod) => mod.getDb());

  // A bucket left over from the previous window: its count must not carry over.
  const windowMs = 60_000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  db.prepare(
    `INSERT INTO rate_limit_bucket (key, window_start, window_sec, count, updated_at)
     VALUES ('rolling', ?, 60, 99, 'x')`,
  ).run(windowStart - windowMs);

  assert.equal(consumeRateLimit({ key: "rolling", limit: 1, windowSec: 60 }).ok, true);
  const row = db
    .prepare(`SELECT window_sec, count FROM rate_limit_bucket WHERE key = 'rolling'`)
    .get() as { window_sec: number; count: number };
  assert.equal(row.count, 1);
  assert.equal(row.window_sec, 60);
});
