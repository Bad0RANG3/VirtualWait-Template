import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = path.join(os.tmpdir(), "virtualwait-playwright-data");
const gatewayPidFile = path.join(dataDir, "gateway.pid");

export default async function globalTeardown() {
  try {
    const pid = Number((await readFile(gatewayPidFile, "utf8")).trim());
    if (Number.isFinite(pid) && pid > 1) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already exited
      }
    }
  } catch {
    // no pid file
  }
  await rm(dataDir, { recursive: true, force: true });
}
