import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("completion capability is one-time and purgeable", async () => {
  process.env.VIRTUALWAIT_DATA_DIR = mkdtempSync(path.join(tmpdir(), "vw-cap-"));

  const {
    createCompletionCapability,
    consumeCompletionCapability,
    cleanupExpiredCompletionCapabilities,
  } = await import("./completion-capability");

  const token = createCompletionCapability("attempt-1");
  assert.equal(consumeCompletionCapability("attempt-1", token), true);
  // Consumed once — the same token cannot be replayed.
  assert.equal(consumeCompletionCapability("attempt-1", token), false);
  // Wrong attempt id or token shape never matches.
  assert.equal(consumeCompletionCapability("attempt-2", token), false);
  assert.equal(consumeCompletionCapability("attempt-1", "x".repeat(32)), false);
  assert.equal(consumeCompletionCapability("attempt-1", ""), false);

  // A token created after the purge cutoff is removed by maintenance.
  const young = createCompletionCapability("attempt-3");
  const deleted = cleanupExpiredCompletionCapabilities(Date.now() + 1000);
  assert.ok(deleted >= 1);
  assert.equal(consumeCompletionCapability("attempt-3", young), false);
});
