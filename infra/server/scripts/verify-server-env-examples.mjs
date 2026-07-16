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
    assert.doesNotMatch(value, /dev-|change-me|localhost/i, `${name} ${key} must not reuse local dev defaults`);
  }
}

const webStaging = parseEnvExample("web.staging.env.example");
const gatewayStaging = parseEnvExample("gateway.staging.env.example");
const webProduction = parseEnvExample("web.production.env.example");

const webKeys = [
  "NODE_ENV",
  "APP_BASE_URL",
  "VIRTUALWAIT_DATA_DIR",
  "VIRTUALWAIT_BACKUP_DIR",
  "SESSION_SECRET",
  "PUBLIC_ID_HMAC_SECRET",
  "ADMIN_API_TOKEN",
  "GATEWAY_MODE",
  "GATEWAY_BASE_URL",
  "GATEWAY_KEY_ID",
  "GATEWAY_SHARED_SECRET",
  "TRUST_PROXY_HEADERS",
  "IP_BINDING_RETENTION_DAYS",
  "PROFILE_DATA_RETENTION_DAYS",
  "QUEUE_HISTORY_RETENTION_DAYS",
  "AUDIT_EVENT_RETENTION_DAYS",
];
requireKeys("web.staging.env.example", webStaging, webKeys);
requireKeys("web.production.env.example", webProduction, webKeys);
requireKeys("gateway.staging.env.example", gatewayStaging, [
  "VW_GATEWAY_ENV",
  "VW_GATEWAY_HOST",
  "VW_GATEWAY_PORT",
  "VW_GATEWAY_DATABASE_PATH",
  "VW_GATEWAY_KEY_ID",
  "VW_GATEWAY_SHARED_SECRET",
  "VW_PUBLIC_ID_HMAC_SECRET",
  "VW_GATEWAY_PROVIDER",
]);

forbidDevDefaults("web.staging.env.example", webStaging);
forbidDevDefaults("gateway.staging.env.example", gatewayStaging);
forbidDevDefaults("web.production.env.example", webProduction);

for (const env of [webStaging, webProduction]) {
  assert.equal(env.NODE_ENV, "production", "Web examples must exercise the production build/runtime path");
  assert.equal(env.GATEWAY_MODE, "remote", "Web examples must use the signed remote Gateway contract");
  assert.equal(env.TRUST_PROXY_HEADERS, "true", "Web examples must require sanitized proxy headers");
  assert.match(env.APP_BASE_URL, /^https:\/\//, "APP_BASE_URL must be HTTPS");
  assert.match(
    env.GATEWAY_BASE_URL,
    /^https:\/\/|^http:\/\/127\.0\.0\.1:8787$/,
    "Gateway URL must be HTTPS or same-host loopback HTTP",
  );
  for (const key of ["SESSION_SECRET", "PUBLIC_ID_HMAC_SECRET", "ADMIN_API_TOKEN", "GATEWAY_SHARED_SECRET"]) {
    requirePlaceholder(env === webStaging ? "web.staging.env.example" : "web.production.env.example", env, key);
  }
}

assert.equal(gatewayStaging.VW_GATEWAY_ENV, "test", "staging Gateway must stay in mock/test mode");
assert.equal(gatewayStaging.VW_GATEWAY_HOST, "127.0.0.1", "Gateway must bind only to loopback");
assert.equal(gatewayStaging.VW_GATEWAY_PROVIDER, "mock", "only the mock provider is implemented for staging");
requirePlaceholder("gateway.staging.env.example", gatewayStaging, "VW_GATEWAY_SHARED_SECRET");
requirePlaceholder("gateway.staging.env.example", gatewayStaging, "VW_PUBLIC_ID_HMAC_SECRET");

assert.equal(webStaging.GATEWAY_KEY_ID, gatewayStaging.VW_GATEWAY_KEY_ID, "staging key IDs must match");
assert.equal(
  webStaging.GATEWAY_SHARED_SECRET,
  gatewayStaging.VW_GATEWAY_SHARED_SECRET,
  "staging Web/Gateway shared secret placeholders must match before replacement",
);
assert.equal(
  webStaging.PUBLIC_ID_HMAC_SECRET,
  gatewayStaging.VW_PUBLIC_ID_HMAC_SECRET,
  "staging public identity HMAC placeholders must match before replacement",
);

assert.notEqual(webStaging.APP_BASE_URL, webProduction.APP_BASE_URL, "staging and production origins must differ");
assert.notEqual(webStaging.VIRTUALWAIT_DATA_DIR, webProduction.VIRTUALWAIT_DATA_DIR, "staging and production data dirs must differ");
assert.notEqual(webStaging.VIRTUALWAIT_BACKUP_DIR, webProduction.VIRTUALWAIT_BACKUP_DIR, "staging and production backup dirs must differ");
assert.notEqual(webStaging.GATEWAY_KEY_ID, webProduction.GATEWAY_KEY_ID, "staging and production Gateway key IDs must differ");
assert.notEqual(webStaging.SESSION_SECRET, webProduction.SESSION_SECRET, "staging and production session secrets must differ");
assert.notEqual(webStaging.PUBLIC_ID_HMAC_SECRET, webProduction.PUBLIC_ID_HMAC_SECRET, "staging and production identity secrets must differ");
assert.notEqual(webStaging.GATEWAY_SHARED_SECRET, webProduction.GATEWAY_SHARED_SECRET, "staging and production Gateway secrets must differ");
assert.notEqual(webStaging.ADMIN_API_TOKEN, webProduction.ADMIN_API_TOKEN, "staging and production admin tokens must differ");

console.info("VirtualWait server environment examples verified", {
  envDir,
  files: ["web.staging.env.example", "gateway.staging.env.example", "web.production.env.example"],
});
