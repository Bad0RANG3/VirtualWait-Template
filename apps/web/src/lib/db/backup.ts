/**
 * Create a consistent copy of a SQLite database.
 *
 * Deliberately independent of `lib/db/connection.ts`: that module runs
 * `SCHEMA_SQL`, `migrate()` and `seed()` on first use, which a *backup* must
 * never do to the live database.
 */
import { DatabaseSync } from "node:sqlite";

/** Escape a filesystem path for use inside a single-quoted SQL string. */
function sqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Copy `sourcePath` to `outputPath` with `VACUUM INTO`, which produces a
 * transactionally consistent file (including the contents of the WAL).
 *
 * The source is opened read-write because `VACUUM INTO` needs a healthy
 * connection, but no schema, migration or seed statement is executed.
 */
export function createBackup(sourcePath: string, outputPath: string): void {
  const db = new DatabaseSync(sourcePath, {
    timeout: 5_000,
    allowExtension: false,
  });
  try {
    db.exec(`VACUUM INTO '${sqlLiteral(outputPath)}'`);
  } finally {
    db.close();
  }
}
