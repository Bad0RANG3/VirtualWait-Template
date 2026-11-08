import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const production = args.has("--production");
const browser = args.has("--browser");
const failures = [];
const unsafeSecretPatterns = [/dev-/i, /change[_-]?me/i, /replace/i, /placeholder/i, /example/i];

function unsafeProductionSecret(value) {
  return !value || value.length < 32 || unsafeSecretPatterns.some((pattern) => pattern.test(value));
}

function validAppUrl(value, { requireHttps = false } = {}) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (requireHttps) return url.protocol === "https:";
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Repository leak scan: reject tracked local-runtime files (defense in depth
// against `git add .` / accidental commits).
// ---------------------------------------------------------------------------
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const FORBIDDEN_TRACKED_PARTS = [
  `${path.sep}napcat${path.sep}`,
  `${path.sep}webui.json`,
];

function checkTrackedLeaks() {
  const root = findRepoRoot(process.cwd());
  if (!root) return;
  let files = [];
  try {
    files = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean);
  } catch {
    return; // not a git checkout; skip
  }
  for (const rel of files) {
    const normalized = `/${rel.replace(/\\/g, "/")}/`;
    if (FORBIDDEN_TRACKED_PARTS.some((part) => normalized.includes(part.replace(/\\/g, "/")))) {
      failures.push(`tracked file looks like local runtime/secret data: ${rel}`);
      continue;
    }
    if (rel.startsWith("data/")) {
      failures.push(`tracked file under repo data/ directory: ${rel}`);
    }
  }
}

checkTrackedLeaks();

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  failures.push(`Node.js 22.5+ is required (current: ${process.versions.node})`);
}

if (production) {
  const secretNames = ["SESSION_SECRET", "ADMIN_API_TOKEN"];
  for (const name of secretNames) {
    const value = process.env[name] || "";
    if (unsafeProductionSecret(value)) {
      failures.push(`${name} must be a unique non-placeholder value with at least 32 characters`);
    }
  }
  if (process.env.TRUST_PROXY_HEADERS !== "true") {
    failures.push("TRUST_PROXY_HEADERS must be true behind a sanitizing reverse proxy");
  }
  // The retired Gateway/provider configuration must not reappear.
  for (const gone of ["GATEWAY_MODE", "GATEWAY_BASE_URL", "GATEWAY_SHARED_SECRET", "PUBLIC_ID_HMAC_SECRET"]) {
    if (process.env[gone]) {
      failures.push(`${gone} was removed with the QR/Gateway login flow and must not be set`);
    }
  }
  const allowInsecureAppUrl = process.env.ALLOW_INSECURE_APP_URL === "true";
  const appUrl = process.env.APP_BASE_URL;
  if (!validAppUrl(appUrl)) {
    failures.push("APP_BASE_URL must be an HTTP or HTTPS URL without credentials");
  } else if (!allowInsecureAppUrl && !validAppUrl(appUrl, { requireHttps: true })) {
    failures.push(
      "APP_BASE_URL must be HTTPS in production (set ALLOW_INSECURE_APP_URL=true only for behind-the-firewall deployments)",
    );
  }
}

if (browser) {
  const { chromium } = await import("@playwright/test");
  const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!fs.existsSync(executable)) {
    failures.push(
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? `PLAYWRIGHT_CHROMIUM_EXECUTABLE does not exist: ${executable}`
        : `Playwright Chromium is missing at ${executable}; run: npx playwright install chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE`,
    );
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`preflight: ${failure}`);
  process.exitCode = 1;
} else {
  console.info("VirtualWait preflight passed", { production, browser });
}
