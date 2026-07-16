import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const REQUIRED_TABLES = [
  "venue",
  "queue",
  "app_user",
  "queue_entry",
  "audit_event",
  "join_attempt",
] as const;

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const requested = argument("--input");
if (!requested) {
  throw new Error("Usage: npm run db:verify -- --input /secure/backups/virtualwait.db");
}

const input = path.resolve(requested);
if (!input.endsWith(".db")) {
  throw new Error("Backup input must use a .db extension");
}

const stat = fs.statSync(input);
if (!stat.isFile()) {
  throw new Error("Backup input must be a regular file");
}
if ((stat.mode & 0o077) !== 0) {
  throw new Error("Backup input permissions must not allow group or other access");
}

// Open only after filesystem checks and never execute a mutating pragma. This
// validates a copied backup without touching the running database or its WAL.
const db = new DatabaseSync(input, { readOnly: true, allowExtension: false });
try {
  const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{
    integrity_check?: string;
  }>;
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("SQLite integrity_check failed");
  }

  const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyErrors.length !== 0) {
    throw new Error("SQLite foreign_key_check failed");
  }

  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(() => "?").join(", ")})`
    )
    .all(...REQUIRED_TABLES) as Array<{ name: string }>;
  const actual = new Set(rows.map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((name) => !actual.has(name));
  if (missing.length) {
    throw new Error(`Backup is missing required tables: ${missing.join(", ")}`);
  }

  console.info("VirtualWait SQLite backup verified", {
    input,
    bytes: stat.size,
    requiredTables: REQUIRED_TABLES.length,
  });
} finally {
  db.close();
}
