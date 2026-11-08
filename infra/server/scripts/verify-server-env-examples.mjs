import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envDir = path.resolve(scriptDir, "../env");

function parseEnvExample(fileName) {
  const filePath = path.join(envDir, fileName);
  const raw = readFileSync(filePath, "utf8");
  const values = new Map();
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    assert.ok(match, `${fileName}:${index + 1} must be KEY=value or a comment`);
    assert.ok(!values.has(match[1]), `${fileName} must not duplicate ${match[1]}`);
    values.set(match[1], match[2]);
  }
  return Object.fromEntries(values);
}

function requireKeys(name, env, keys) {
  for (const key of keys) assert.ok(env[key], `${name} must define ${key}`);
}

function requirePlaceholder(name, env, key) {
  assert.match(
    env[key],
    /^CHANGE_ME_[A-Z0-9_]{20,}$/,
    `${name} ${key} must be an obvious non-runnable placeholder`,
  );
}

function forbidDevDefaults(name, env) {
  for (const [key, value] of Object.entries(env)) {
    assert.doesNotMatch(
      value,
      /dev-|change-me|localhost/i,
      `${name} ${key} must not reuse local dev defaults`,
    );
  }
}

const webStaging = parseEnvExample("web.staging.env.example");
const webProduction = parseEnvExample("web.production.env.example");

const webKeys = [
  "NODE_ENV",
  "APP_BASE_URL",
  "VIRTUALWAIT_DATA_DIR",
  "VIRTUALWAIT_BACKUP_DIR",
  "SESSION_SECRET",
  "SESSION_MAX_AGE_DAYS",
  "ADMIN_API_TOKEN",
  "TRUST_PROXY_HEADERS",
  "HOST",
  "PORT",
  "DB_BUSY_TIMEOUT_MS",
  "CHECKIN_WINDOW_SEC",
  "IP_BINDING_RETENTION_DAYS",
  "IP_ACCOUNT_QUOTA_PER_DAY",
  "LOGIN_METADATA_RETENTION_DAYS",
  "QUEUE_HISTORY_RETENTION_DAYS",
  "AUDIT_EVENT_RETENTION_DAYS",
];
requireKeys("web.staging.env.example", webStaging, webKeys);
requireKeys("web.production.env.example", webProduction, webKeys);

forbidDevDefaults("web.staging.env.example", webStaging);
forbidDevDefaults("web.production.env.example", webProduction);

for (const [name, env] of [
  ["web.staging.env.example", webStaging],
  ["web.production.env.example", webProduction],
]) {
  assert.equal(env.NODE_ENV, "production", "Web examples must exercise the production build/runtime path");
  assert.equal(env.TRUST_PROXY_HEADERS, "true", "Web examples must require sanitized proxy headers");
  assert.equal(env.CHECKIN_REQUIRED, "true", "Web examples must require a venue check-in code");
  assert.equal(env.HOST, "127.0.0.1", `${name} must keep the app on loopback so IP headers cannot be forged`);
  assert.ok(Number(env.DB_BUSY_TIMEOUT_MS) > 0, `${name} DB_BUSY_TIMEOUT_MS must let write conflicts wait`);
  assert.ok(Number(env.SESSION_MAX_AGE_DAYS) > 0, "SESSION_MAX_AGE_DAYS must be a positive number of days");
  assert.ok(Number(env.IP_ACCOUNT_QUOTA_PER_DAY) >= 1, "IP_ACCOUNT_QUOTA_PER_DAY must be a positive number of accounts");
  assert.ok(Number(env.CHECKIN_WINDOW_SEC) > 0, "CHECKIN_WINDOW_SEC must be a positive number of seconds");
  assert.match(env.APP_BASE_URL, /^https:\/\//, `${name} APP_BASE_URL must use HTTPS`);
  for (const key of ["SESSION_SECRET", "ADMIN_API_TOKEN"]) {
    requirePlaceholder(name, env, key);
  }
  // The former Gateway/provider identity settings must be gone for good.
  for (const gone of ["GATEWAY_MODE", "GATEWAY_BASE_URL", "GATEWAY_SHARED_SECRET", "PUBLIC_ID_HMAC_SECRET"]) {
    assert.equal(env[gone], undefined, `${name} must not define the removed ${gone}`);
  }
}

assert.notEqual(webStaging.APP_BASE_URL, webProduction.APP_BASE_URL, "staging and production origins must differ");
assert.notEqual(webStaging.VIRTUALWAIT_DATA_DIR, webProduction.VIRTUALWAIT_DATA_DIR, "staging and production data dirs must differ");
assert.notEqual(webStaging.VIRTUALWAIT_BACKUP_DIR, webProduction.VIRTUALWAIT_BACKUP_DIR, "staging and production backup dirs must differ");
assert.notEqual(webStaging.SESSION_SECRET, webProduction.SESSION_SECRET, "staging and production session secrets must differ");
assert.notEqual(webStaging.ADMIN_API_TOKEN, webProduction.ADMIN_API_TOKEN, "staging and production admin tokens must differ");

console.info("VirtualWait server environment examples verified", {
  envDir,
  files: ["web.staging.env.example", "web.production.env.example"],
});
