import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = path.join(os.tmpdir(), "virtualwait-playwright-data");
const gatewayPidFile = path.join(dataDir, "gateway.pid");
const gatewayRoot = path.resolve(__dirname, "../../../services/sdgb-gateway");

async function waitFor(url: string, name: string) {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${name} did not become ready: ${String(lastError)}`);
}

export default async function globalSetup() {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });

  const gatewayDb = path.join(dataDir, "gateway.db");
  const child: ChildProcess = spawn("python3", ["-m", "virtualwait_gateway"], {
    cwd: gatewayRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(gatewayRoot, "src"),
      VW_GATEWAY_ENV: "test",
      VW_GATEWAY_HOST: "127.0.0.1",
      VW_GATEWAY_PORT: "8787",
      VW_GATEWAY_DATABASE_PATH: gatewayDb,
      VW_GATEWAY_PROVIDER: "mock",
      VW_GATEWAY_KEY_ID: "template-web-1",
      VW_GATEWAY_SHARED_SECRET: "CHANGE_ME_DEVELOPMENT_GATEWAY_SHARED_SECRET",
      VW_PUBLIC_ID_HMAC_SECRET: "CHANGE_ME_DEVELOPMENT_PUBLIC_ID_HMAC_SECRET",
    },
    stdio: "ignore",
    detached: true,
  });
  if (!child.pid) throw new Error("failed to start Gateway for Playwright");
  child.unref();
  await writeFile(gatewayPidFile, String(child.pid), "utf8");
  await waitFor("http://127.0.0.1:8787/healthz", "Gateway");
}
