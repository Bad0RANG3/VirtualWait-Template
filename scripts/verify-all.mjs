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
const bot = path.join(root, "services/bot");
// Windows often exposes Python as `python` (or `py`) rather than `python3`.
const python = process.env.PYTHON || "python3";
// npm/npx are .cmd shims on Windows, which Node only executes through a shell.
const useShell = process.platform === "win32";

function run(label, command, args, options = {}) {
  console.info(`\n==> ${label}`);
  const cwd = options.cwd || root;
  const env = { ...process.env, ...(options.env || {}) };
  // Every argument here is a static path or flag, so a single command line is
  // safe and avoids Node's args+shell deprecation warning on Windows.
  const result = useShell
    ? spawnSync([command, ...args].join(" "), { stdio: "inherit", cwd, env, shell: true })
    : spawnSync(command, args, { stdio: "inherit", cwd, env, shell: false });
  if (result.status !== 0) {
    console.error(`FAILED: ${label}`);
    process.exit(result.status || 1);
  }
}

const productionEnv = {
  SESSION_SECRET: process.env.SESSION_SECRET || "0123456789abcdef0123456789abcdef",
  ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN || "0123456789abcdef0123456789abcdef",
  APP_BASE_URL: process.env.APP_BASE_URL || "https://wait.example.test",
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
run("bot compile", python, ["-m", "compileall", "-q", "services/bot"]);
run("bot tests", python, ["-m", "pytest", "-q", "tests"], {
  cwd: bot,
  env: { PYTHONPATH: "." },
});

console.info("\nVirtualWait template verification passed");
