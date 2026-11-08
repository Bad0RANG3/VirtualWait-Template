/**
 * SQLite 连接单例：首次 getDb() 建库/执行 schema、migrate、seed，并开启 WAL 与外键。
 */
import fs from "fs";
import path from "path";
import { env } from "../env";
import { SCHEMA_SQL } from "./schema";
import { openDatabase, type Db } from "./sqlite";
import { migrate } from "./migrate";
import { seed } from "./seed";

const globalForDb = globalThis as unknown as { __vwDb?: Db };

function dbPath() {
  const configured = process.env.VIRTUALWAIT_DATA_DIR;
  const dir = configured
    ? path.resolve(configured)
    : path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "virtualwait.db");
}

/** Return the singleton SQLite connection, performing one-time schema setup,
 *  migration, and catalog seeding on first access. */
export function getDb(): Db {
  if (!globalForDb.__vwDb) {
    const db = openDatabase(dbPath());
    // Install the busy handler *before* the first statement that may need to
    // take a lock: switching to WAL takes a short lock itself.
    // The web process and the maintenance worker are two writers on the same
    // file, so wait instead of failing instantly with SQLITE_BUSY.
    db.pragma(`busy_timeout = ${env.dbBusyTimeoutMs}`);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    migrate(db);
    seed(db);
    globalForDb.__vwDb = db;
  }
  return globalForDb.__vwDb;
}
