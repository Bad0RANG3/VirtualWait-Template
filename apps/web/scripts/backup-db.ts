import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/lib/db";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const requested = argument("--output");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDirectory =
  process.env.VIRTUALWAIT_BACKUP_DIR || path.join(process.cwd(), "backups");
const output = path.resolve(
  requested || path.join(backupDirectory, `virtualwait-${timestamp}.db`)
);

if (!output.endsWith(".db")) {
  throw new Error("Backup output must use a .db extension");
}
if (fs.existsSync(output)) {
  throw new Error("Backup output already exists");
}
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });

// VACUUM INTO produces a transactionally consistent SQLite copy, unlike a
// filesystem copy that could omit the WAL while maintenance is writing.
const literal = output.replace(/'/g, "''");
getDb().exec(`VACUUM INTO '${literal}'`);
fs.chmodSync(output, 0o600);
console.info("VirtualWait SQLite backup created", { output });
