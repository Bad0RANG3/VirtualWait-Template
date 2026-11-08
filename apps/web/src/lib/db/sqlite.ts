/**
 * node:sqlite 轻封装：openDatabase、Db（exec/prepare/pragma/transaction）、Statement。
 */
import { DatabaseSync } from "node:sqlite";

type SqlParam = string | number | null | bigint | Uint8Array;

export type Row = Record<string, unknown>;

export class Statement {
  constructor(private readonly stmt: ReturnType<DatabaseSync["prepare"]>) {}

  run(...params: SqlParam[]) {
    return this.stmt.run(...params);
  }

  get(...params: SqlParam[]): Row | undefined {
    const row = this.stmt.get(...params) as Row | undefined;
    return row;
  }

  all(...params: SqlParam[]): Row[] {
    return this.stmt.all(...params) as Row[];
  }
}

export class Db {
  private txDepth = 0;

  constructor(private readonly raw: DatabaseSync) {}

  exec(sql: string) {
    this.raw.exec(sql);
  }

  prepare(sql: string) {
    return new Statement(this.raw.prepare(sql));
  }

  pragma(pragma: string) {
    // better-sqlite3 style: "journal_mode = WAL" / "foreign_keys = ON"
    const cleaned = pragma.replace(/^=\s*/, "").trim();
    this.raw.exec(`PRAGMA ${cleaned}`);
  }

  /** Close the connection. The last SQLite connection also removes WAL files. */
  close() {
    this.raw.close();
  }

  /**
   * Run `fn` inside a transaction.
   *
   * Write transactions default to `BEGIN IMMEDIATE`: the write lock is taken
   * up front so concurrent writers wait on `busy_timeout` instead of failing
   * when a deferred transaction tries to upgrade its read snapshot
   * (SQLITE_BUSY_SNAPSHOT ignores busy handlers entirely).
   *
   * Nested calls join the outer transaction instead of issuing a second BEGIN,
   * so a helper like `requeueToEnd` can be transactional on its own and still
   * be used from an already transactional admin action.
   */
  transaction<T>(fn: () => T, options: { immediate?: boolean } = {}): () => T {
    const immediate = options.immediate ?? true;
    return () => {
      if (this.txDepth > 0) return fn();
      this.txDepth += 1;
      try {
        this.raw.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
        try {
          const result = fn();
          this.raw.exec("COMMIT");
          return result;
        } catch (err) {
          try {
            this.raw.exec("ROLLBACK");
          } catch {
            // Already rolled back by SQLite (e.g. a fatal error).
          }
          throw err;
        }
      } finally {
        this.txDepth -= 1;
      }
    };
  }
}

export function openDatabase(path: string) {
  return new Db(new DatabaseSync(path));
}
