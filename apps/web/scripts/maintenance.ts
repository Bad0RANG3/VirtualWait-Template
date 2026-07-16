import { env } from "../src/lib/env";
import { runMaintenance } from "../src/lib/queue/maintenance";

function execute() {
  const result = runMaintenance();
  // Counts only; never log profiles, QR values, tokens or user identifiers.
  console.info("VirtualWait maintenance completed", result);
}

execute();
if (!process.argv.includes("--once")) {
  setInterval(execute, env.maintenanceIntervalSec * 1000);
}
