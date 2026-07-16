import assert from "node:assert/strict";
import test from "node:test";
import { isUnsafeProductionSecret } from "./env";

test("production secret validation rejects defaults and deployment placeholders", () => {
  assert.equal(
    isUnsafeProductionSecret("dev-session-secret-change-me", "dev-session-secret-change-me"),
    true,
  );
  assert.equal(
    isUnsafeProductionSecret("CHANGE_ME_STAGING_SESSION_SECRET_64_HEX", "dev-session-secret-change-me"),
    true,
  );
  assert.equal(
    isUnsafeProductionSecret("replace-with-openssl-rand-hex-32-value", "dev-session-secret-change-me"),
    true,
  );
  assert.equal(
    isUnsafeProductionSecret("0123456789abcdef0123456789abcdef", "dev-session-secret-change-me"),
    false,
  );
});
