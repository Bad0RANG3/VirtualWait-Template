/**
 * Database layer entry-point.
 * Implementation is split across focused modules; this file keeps stable
 * re-exports so every consumer stays compatible.
 */
export { getDb } from "./connection";
export { addSeconds, nowIso } from "./utils";
export { SCHEMA_SQL, MIGRATIONS_SQL } from "./schema";
export { openDatabase, type Db } from "./sqlite";
