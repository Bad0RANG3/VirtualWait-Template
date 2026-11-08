/**
 * Create the runtime SQLite database without starting the web server.
 *
 * `getDb()` applies the schema, runs pending migrations and seeds the catalog,
 * so this produces the same database the app would create on first boot. CI
 * uses it to exercise `db:backup` / `db:verify` on a fresh checkout, and it is
 * also the supported way to prepare a database on a new host before the first
 * `npm run start`.
 *
 *   VIRTUALWAIT_DATA_DIR=/var/lib/virtualwait/web npm run db:init
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "../src/lib/db";

const configured = process.env.VIRTUALWAIT_DATA_DIR;
const dataDir = configured ? path.resolve(configured) : path.join(process.cwd(), "data");

const db = getDb();
try {
  // Force the WAL to be written back into the main file so the fresh database
  // is complete on disk even if the process exits immediately afterwards.
  db.pragma("wal_checkpoint(TRUNCATE)");
} finally {
  db.close();
}

console.info("VirtualWait SQLite database initialized", {
  file: path.join(dataDir, "virtualwait.db"),
  bytes: fs.statSync(path.join(dataDir, "virtualwait.db")).size,
});
