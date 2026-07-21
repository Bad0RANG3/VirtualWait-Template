import assert from "node:assert/strict";
import test from "node:test";
import { isUnsafeProductionSecret, isValidAppBaseUrl } from "./env";

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

test("app base URL validation allows HTTP and HTTPS origins without credentials", () => {
  assert.equal(isValidAppBaseUrl("https://wait.example.com"), true);
  assert.equal(isValidAppBaseUrl("http://wait.example.com"), true);
  assert.equal(isValidAppBaseUrl("http://192.168.1.10:3000"), true);
  assert.equal(isValidAppBaseUrl("ftp://wait.example.com"), false);
  assert.equal(isValidAppBaseUrl("https://user:pass@wait.example.com"), false);
  assert.equal(isValidAppBaseUrl("not-a-url"), false);
});
