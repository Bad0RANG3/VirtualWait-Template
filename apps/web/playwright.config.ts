import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const dataDir = path.join(os.tmpdir(), "virtualwait-playwright-data");
const adminToken = "playwright-admin-token-0123456789abcdef";
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:13001",
    trace: "retain-on-failure",
    ...(chromiumExecutable
      ? { launchOptions: { executablePath: chromiumExecutable } }
      : {}),
  },
  projects: [
    {
      name: "desktop-chromium",
      testIgnore: /mobile\.spec\.ts/,
    },
    {
      name: "mobile-chromium",
      testMatch: /mobile\.spec\.ts/,
      use: {
        // Match the iPhone 13 CSS viewport while retaining Chromium's regular
        // desktop launch mode. This is stable with system Chromium binaries
        // used for local and CI browser checks.
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
  ],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  webServer: {
    command: "npm run dev -- -p 13001",
    url: "http://127.0.0.1:13001",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      ADMIN_API_TOKEN: adminToken,
      APP_BASE_URL: "http://127.0.0.1:13001",
      GATEWAY_MODE: "mock",
      VIRTUALWAIT_DATA_DIR: dataDir,
    },
  },
});
