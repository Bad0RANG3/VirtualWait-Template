import fs from "node:fs";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const production = args.has("--production");
const browser = args.has("--browser");
const failures = [];
const unsafeSecretPatterns = [/dev-/i, /change[_-]?me/i, /replace/i, /placeholder/i, /example/i];

function unsafeProductionSecret(value) {
  return !value || value.length < 32 || unsafeSecretPatterns.some((pattern) => pattern.test(value));
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
  try {
    if (new URL(process.env.APP_BASE_URL).protocol !== "https:") throw new Error();
  } catch {
    failures.push("APP_BASE_URL must be an HTTPS URL");
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
