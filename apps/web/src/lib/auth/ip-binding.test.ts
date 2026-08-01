import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("per-IP per-day binding quota", async () => {
  process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-ipbind-"));
  process.env.IP_ACCOUNT_QUOTA_PER_DAY = "3";

  const { getDb } = await import("../db");
  const { bindIpToUser } = await import("./ip-binding");
  const db = getDb();
  const now = new Date().toISOString();

  for (const [id, nickname] of [
    ["u1", "One"],
    ["u2", "Two"],
    ["u3", "Three"],
    ["u4", "Four"],
  ] as const) {
    db.prepare(
      `INSERT INTO app_user (id, nickname, show_rating_public, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(id, nickname, now, now);
  }

  const ip = "a".repeat(64);
  bindIpToUser(ip, "u1");
  bindIpToUser(ip, "u2");
  bindIpToUser(ip, "u3");
  assert.throws(() => bindIpToUser(ip, "u4"), /IP_ACCOUNT_BOUND/);

  // Re-binding an already bound account stays allowed (quota unchanged).
  bindIpToUser(ip, "u1");
  const rows = db
    .prepare(`SELECT COUNT(*) AS c FROM ip_day_binding WHERE ip_hash = ?`)
    .get(ip) as { c: number };
  assert.equal(Number(rows.c), 3);

  // Unknown IPs (no proxy trust) are never enforced.
  assert.doesNotThrow(() => bindIpToUser("unknown", "u4"));
});
