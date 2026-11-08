/**
 * Create a backup of the runtime SQLite database.
 *
 * The copy is produced by `lib/db/backup.ts`, which opens the live file
 * directly: going through `getDb()` would run SCHEMA_SQL, `migrate()` and
 * `seed()` against production, so a scheduled backup could execute a
 * destructive migration before the web process ever restarted.
 */
import fs from "node:fs";
import path from "node:path";
import { createBackup } from "../src/lib/db/backup";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function databasePath() {
  const configured = process.env.VIRTUALWAIT_DATA_DIR;
  const dir = configured
    ? path.resolve(configured)
    : path.join(process.cwd(), "data");
  return path.join(dir, "virtualwait.db");
}

const requested = argument("--output");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDirectory =
  process.env.VIRTUALWAIT_BACKUP_DIR || path.join(process.cwd(), "backups");
const output = path.resolve(
  requested || path.join(backupDirectory, `virtualwait-${timestamp}.db`),
);

if (!output.endsWith(".db")) {
  throw new Error("Backup output must use a .db extension");
}
if (fs.existsSync(output)) {
  throw new Error("Backup output already exists");
}
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });

const source = databasePath();
if (!fs.existsSync(source)) {
  throw new Error(`Runtime database not found: ${source}`);
}

createBackup(source, output);
fs.chmodSync(output, 0o600);
console.info("VirtualWait SQLite backup created", { source, output });
