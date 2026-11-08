import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { insertTestUsers } from "../testing/users";

test("per-IP per-day registration quota", async () => {
  process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-ipbind-"));
  process.env.IP_ACCOUNT_QUOTA_PER_DAY = "3";

  const { getDb } = await import("../db");
  const { bindIpToUser } = await import("./ip-binding");
  const { hashIp } = await import("./ip");
  const db = getDb();
  const now = new Date().toISOString();

  insertTestUsers(
    db,
    [
      { id: "u1", nickname: "One" },
      { id: "u2", nickname: "Two" },
      { id: "u3", nickname: "Three" },
      { id: "u4", nickname: "Four" },
    ],
    now,
  );

  const ip = hashIp("203.0.113.7");
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

  // Clients whose address cannot be determined all hash the same literal, so
  // they deliberately share one conservative bucket instead of being exempt
  // (an exemption would hand out unlimited accounts behind a broken proxy).
  const undetermined = hashIp("unknown");
  bindIpToUser(undetermined, "u1");
  bindIpToUser(undetermined, "u2");
  bindIpToUser(undetermined, "u3");
  assert.throws(() => bindIpToUser(undetermined, "u4"), /IP_ACCOUNT_BOUND/);
});
