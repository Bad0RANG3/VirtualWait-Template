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

  transaction<T>(fn: () => T): () => T {
    return () => {
      this.raw.exec("BEGIN");
      try {
        const result = fn();
        this.raw.exec("COMMIT");
        return result;
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      }
    };
  }
}

export function openDatabase(path: string) {
  return new Db(new DatabaseSync(path));
}
