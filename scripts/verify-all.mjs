#!/usr/bin/env node
/**
 * One-command template verification.
 * Runs the same gates that should pass before publishing this repo as a template.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps/web");
const gateway = path.join(root, "services/sdgb-gateway");

function run(label, command, args, options = {}) {
  console.info(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    shell: false,
  });
  if (result.status !== 0) {
    console.error(`FAILED: ${label}`);
    process.exit(result.status || 1);
  }
}

const productionEnv = {
  SESSION_SECRET: process.env.SESSION_SECRET || "0123456789abcdef0123456789abcdef",
  PUBLIC_ID_HMAC_SECRET:
    process.env.PUBLIC_ID_HMAC_SECRET || "0123456789abcdef0123456789abcdef",
  GATEWAY_SHARED_SECRET:
    process.env.GATEWAY_SHARED_SECRET || "0123456789abcdef0123456789abcdef",
  ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN || "0123456789abcdef0123456789abcdef",
  APP_BASE_URL: process.env.APP_BASE_URL || "https://wait.example.test",
  GATEWAY_MODE: "remote",
  GATEWAY_BASE_URL: process.env.GATEWAY_BASE_URL || "http://127.0.0.1:8787",
  TRUST_PROXY_HEADERS: "true",
};

run("server env examples", "node", ["infra/server/scripts/verify-server-env-examples.mjs"]);
run("nginx template", "node", ["infra/server/scripts/verify-nginx-template.mjs"]);
run("web preflight production", "npm", ["run", "preflight", "--", "--production"], {
  cwd: web,
  env: productionEnv,
});
run("web unit tests", "npm", ["test"], { cwd: web });
run("web lint", "npm", ["run", "lint"], { cwd: web });
run("web typecheck", "npx", ["tsc", "--noEmit"], { cwd: web });
run("web e2e", "npm", ["run", "test:e2e"], { cwd: web });
run("web browser", "npm", ["run", "test:browser"], {
  cwd: web,
  env: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { PLAYWRIGHT_CHROMIUM_EXECUTABLE: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {},
});
run("web build", "npm", ["run", "build"], { cwd: web, env: productionEnv });
run("gateway tests", "python3", ["-m", "pytest", "-q"], {
  cwd: gateway,
  env: { PYTHONPATH: "src" },
});

console.info("\nVirtualWait template verification passed");
