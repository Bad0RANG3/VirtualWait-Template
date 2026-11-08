import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { insertTestUsers } from "../testing/users";

test("joinQueue requires bound QQ", async () => {
  process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-join-qq-"));
  process.env.PLAYING_TIMEOUT_SEC = "1500";
  process.env.HEAD_CONFIRM_TIMEOUT_SEC = "180";

  const { getDb } = await import("../db");
  const { joinQueue } = await import("./user-actions");
  const { updateVenueMeta } = await import("../settings/venue-meta");
  const db = getDb();
  const now = new Date().toISOString();

  // Keep sample venue open all day for this test.
  updateVenueMeta("venue-sample-central", {
    address: "addr",
    regionName: "示例区",
    regionKind: "district",
    machineCount: 2,
    openMinute: 0,
    closeMinute: 24 * 60 - 1,
  });

  insertTestUsers(
    db,
    [
      { id: "u-no-qq", nickname: "NoQq", qq: null },
      { id: "u-with-qq", nickname: "WithQq", qq: "12345678" },
    ],
    now,
  );

  assert.throws(() => joinQueue("queue-a", "u-no-qq", "SOLO"), /QQ_REQUIRED/);

  const result = joinQueue("queue-a", "u-with-qq", "SOLO");
  assert.ok(result.entryId);
  const row = db
    .prepare(`SELECT user_id, status FROM queue_entry WHERE id = ?`)
    .get(result.entryId) as { user_id: string; status: string };
  assert.equal(row.user_id, "u-with-qq");
  assert.equal(row.status, "WAITING");
});
