import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("bot catalog and queue detail expose groupUmo and head qq", async () => {
  process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-bot-"));
  process.env.BOT_API_TOKEN = "test-bot-token-with-enough-length-012345";
  process.env.PLAYING_TIMEOUT_SEC = "1500";
  process.env.HEAD_CONFIRM_TIMEOUT_SEC = "180";

  const { getDb } = await import("../db");
  const { getBotCatalog, getBotQueueDetail, botHeadCooldownKey } = await import("./bot");
  const { updateVenueMeta } = await import("../settings/venue-meta");
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO app_user (id, nickname, show_rating_public, qq, created_at, updated_at)
     VALUES
      ('u-a', 'PlayerA', 1, '10001', ?, ?),
      ('u-b', 'PlayerB', 1, '10002', ?, ?),
      ('u-c', 'PlayerC', 1, NULL, ?, ?)`,
  ).run(now, now, now, now, now, now);

  updateVenueMeta("venue-sample-central", {
    address: "addr",
    regionName: "示例区",
    regionKind: "district",
    machineCount: 2,
    openMinute: 10 * 60,
    closeMinute: 22 * 60,
    groupUmo: "aiocqhttp:GroupMessage:999",
  });

  db.prepare(
    `INSERT INTO queue_entry
      (id, queue_id, user_id, party_id, play_mode, sequence_number, status, version,
       joined_at, created_at, updated_at)
     VALUES
      ('e-a', 'queue-a', 'u-a', NULL, 'SOLO', 1, 'WAITING', 1, ?, ?, ?),
      ('e-c', 'queue-a', 'u-c', NULL, 'SOLO', 2, 'WAITING', 1, ?, ?, ?)`,
  ).run(now, now, now, now, now, now);

  const catalog = getBotCatalog();
  const machine = catalog.machines.find(
    (item) => item.venueSlug === "sample-venue" && item.machineSlug === "machine-a",
  );
  assert.ok(machine);
  assert.equal(machine!.activeCount, 2);
  assert.equal(machine!.hasPlaying, false);
  assert.equal(machine!.groupUmo, "aiocqhttp:GroupMessage:999");

  const detail = getBotQueueDetail("sample-venue", "machine-a");
  assert.ok(detail);
  assert.equal(detail!.machineIdle, true);
  assert.equal(detail!.groupUmo, "aiocqhttp:GroupMessage:999");
  assert.ok(detail!.head);
  assert.equal(detail!.head!.players[0]?.displayName, "PlayerA");
  assert.equal(detail!.head!.players[0]?.qq, "10001");
  assert.equal(
    botHeadCooldownKey(detail!.machineSlug, detail!.head!.players),
    "machine-a_10001",
  );

  // busy machine: playing present -> idle false, head null for notify path
  db.prepare(
    `UPDATE queue_entry SET status = 'PLAYING', playing_at = ? WHERE id = 'e-a'`,
  ).run(now);
  const busy = getBotQueueDetail("sample-venue", "machine-a");
  assert.equal(busy!.machineIdle, false);
  assert.equal(busy!.head, null);
});

test("bot head cooldown key sorts qq set", async () => {
  const { botHeadCooldownKey } = await import("./bot");
  assert.equal(
    botHeadCooldownKey("m1", [{ qq: "200" }, { qq: "100" }, { qq: null }]),
    "m1_100_200",
  );
});


test("requireBot rejects missing token and bad bearer", async () => {
  process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-bot-auth-"));
  process.env.BOT_API_TOKEN = "test-bot-token-with-enough-length-012345";
  // re-import env is sticky in process; requireBot reads env module already loaded
  const { requireBot } = await import("../auth/bot");
  assert.throws(
    () => requireBot(new Request("http://localhost/api/bot/catalog")),
    /BOT_UNAUTHORIZED/,
  );
  assert.throws(
    () =>
      requireBot(
        new Request("http://localhost/api/bot/catalog", {
          headers: { Authorization: "Bearer wrong" },
        }),
      ),
    /BOT_UNAUTHORIZED/,
  );
  assert.doesNotThrow(() =>
    requireBot(
      new Request("http://localhost/api/bot/catalog", {
        headers: {
          Authorization: "Bearer test-bot-token-with-enough-length-012345",
        },
      }),
    ),
  );
});
