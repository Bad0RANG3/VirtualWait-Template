import { env } from "../src/lib/env";
import { runMaintenance } from "../src/lib/queue/maintenance";

/**
 * A long-running systemd unit (`virtualwait-maintenance`).
 *
 * One failed cycle must not stop every queue timeout — a writer can legitimately
 * hold the SQLite lock longer than the busy timeout. But a *persistent* failure
 * must not look healthy either: systemd only restarts (and finally marks the
 * unit failed) when the process exits. So transient errors are logged and
 * retried, while `MAX_CONSECUTIVE_FAILURES` consecutive failures exit non-zero.
 */
const MAX_CONSECUTIVE_FAILURES = 5;
let consecutiveFailures = 0;

function execute(): boolean {
  try {
    const result = runMaintenance();
    consecutiveFailures = 0;
    // Counts only; never log profiles, credentials or user identifiers.
    console.info("VirtualWait maintenance completed", result);
    return true;
  } catch (err) {
    consecutiveFailures += 1;
    console.error(
      `VirtualWait maintenance cycle failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
      err,
    );
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.error("giving up: exiting so systemd can restart the worker");
      process.exit(1);
    }
    return false;
  }
}

execute();
if (!process.argv.includes("--once")) {
  setInterval(execute, env.maintenanceIntervalSec * 1000);
}
