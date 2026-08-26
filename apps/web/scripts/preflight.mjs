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

function validGatewayUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------------------
// Repository leak scan: reject tracked local-runtime files and known SDGB
// secret material (defense in depth against `git add .` / accidental commits).
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
  `${path.sep}token_cache.json`,
  `${path.sep}records_cache.json`,
  `${path.sep}webui.json`,
];
// 这些文件本身就是检测器，允许包含用于匹配的字符串字面量。
const SECRET_SCAN_SKIP = new Set([
  "apps/web/scripts/preflight.mjs",
  ".github/workflows/verify.yml",
]);
const FORBIDDEN_SECRET_FRAGMENTS = [
  "FKM2JX:VjZNK6hc:A0<JU:i5oR7LA]9W",
  "XcW5FW4cPArBXEk4vzKz3CIrMuA5EVVW",
  "A63E-01C28055905",
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
    if (SECRET_SCAN_SKIP.has(rel.replace(/\\/g, "/"))) continue;
    const normalized = `/${rel.replace(/\\/g, "/")}/`;
    if (FORBIDDEN_TRACKED_PARTS.some((part) => normalized.includes(part.replace(/\\/g, "/")))) {
      failures.push(`tracked file looks like local runtime/secret data: ${rel}`);
      continue;
    }
    if (rel.startsWith("data/")) {
      failures.push(`tracked file under repo data/ directory: ${rel}`);
      continue;
    }
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).size > 256 * 1024) continue;
    try {
      const content = fs.readFileSync(abs, "utf8");
      if (FORBIDDEN_SECRET_FRAGMENTS.some((fragment) => content.includes(fragment))) {
        failures.push(`tracked file contains known SDGB secret material: ${rel}`);
      }
    } catch {
      // binary/unreadable; skip
    }
  }
}

checkTrackedLeaks();

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  failures.push(`Node.js 22.5+ is required (current: ${process.versions.node})`);
}

if (production) {
  const secretNames = ["SESSION_SECRET", "PUBLIC_ID_HMAC_SECRET", "GATEWAY_SHARED_SECRET", "ADMIN_API_TOKEN"];
  for (const name of secretNames) {
    const value = process.env[name] || "";
    if (unsafeProductionSecret(value)) {
      failures.push(`${name} must be a unique non-placeholder value with at least 32 characters`);
    }
  }
  if (process.env.GATEWAY_MODE !== "remote") failures.push("GATEWAY_MODE must be remote");
  if (process.env.TRUST_PROXY_HEADERS !== "true") {
    failures.push("TRUST_PROXY_HEADERS must be true behind a sanitizing reverse proxy");
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
  if (!validGatewayUrl(process.env.GATEWAY_BASE_URL)) {
    failures.push("GATEWAY_BASE_URL must be HTTPS or unauthenticated loopback HTTP (127.0.0.1/[::1])");
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
