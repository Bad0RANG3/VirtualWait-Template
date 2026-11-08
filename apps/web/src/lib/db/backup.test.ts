import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createBackup } from "./backup";

/** A minimal pre-refactor database: no local credential columns yet. */
const LEGACY_SQL = `
CREATE TABLE app_user (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL UNIQUE,
  sdgb_identity_hash TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO app_user (id, nickname, sdgb_identity_hash, created_at, updated_at)
VALUES ('legacy-1', 'LegacyPlayer', 'identity-hash', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z');
`;

function columns(db: DatabaseSync, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

test("backup copies the database without touching schema, migrations or seeds", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vw-backup-"));
  const source = path.join(dir, "virtualwait.db");
  const output = path.join(dir, "copy.db");

  const seed = new DatabaseSync(source);
  seed.exec(LEGACY_SQL);
  seed.close();

  createBackup(source, output);
  assert.ok(existsSync(output), "backup file must exist");

  // The live database must be byte-for-byte untouched: no schema creation, no
  // migration, no catalog seeding.
  const live = new DatabaseSync(source, { readOnly: true });
  try {
    const cols = columns(live, "app_user");
    assert.ok(!cols.includes("username"), "backup must not migrate the live database");
    assert.ok(cols.includes("sdgb_identity_hash"), "legacy columns stay as they are");
    const rows = live.prepare(`SELECT COUNT(*) AS c FROM app_user`).get() as {
      c: number;
    };
    assert.equal(Number(rows.c), 1, "legacy rows are preserved");
    const tables = live
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map((row) => row.name),
      ["app_user"],
      "no venue/queue/session tables may be created by a backup",
    );
  } finally {
    live.close();
  }

  // The copy is a real SQLite database with the same content.
  const copy = new DatabaseSync(output, { readOnly: true });
  try {
    const integrity = copy.prepare(`PRAGMA integrity_check`).all() as Array<{
      integrity_check: string;
    }>;
    assert.equal(integrity[0]?.integrity_check, "ok");
    const row = copy
      .prepare(`SELECT nickname FROM app_user WHERE id = 'legacy-1'`)
      .get() as { nickname: string };
    assert.equal(row.nickname, "LegacyPlayer");
  } finally {
    copy.close();
  }
});
