/**
 * Table evolution.
 *
 * WHY THIS FILE EXISTS. `MOMENT_SPOOL_FORMAT` governs how a spool LINE may change, and until this
 * was written nothing governed how a TABLE may change: `createMomentTables` is one
 * `CREATE TABLE IF NOT EXISTS` per table, which is a no-op against a store that already has them.
 * A column added to the schema therefore reached fresh stores only, and an existing store kept
 * working for reads and threw on the first write that named the new column.
 *
 * WHAT THAT COST, observed on a real store left behind by an earlier round: the fold throws
 * `table governed_moments has no column named outcome_status`, `memory_overview` and
 * `conformance_ask` fail loudly — and the ask signal goes SILENTLY dark, because `askSignalBlock`
 * swallows its own failures by design. That is verbatim the conflation the signal exists to
 * prevent: `not asked` stops meaning the agent failed to ask and starts meaning it was never told.
 *
 * SO THE TESTS HERE ARE ABOUT THE CLASS, NOT THE COLUMN. The last one adds a column that does not
 * exist anywhere in this codebase and proves it migrates anyway, because the migration is derived
 * from the schema rather than from a list somebody has to remember to update.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BetterSqlitePort } from "../storage";
import type { StoragePort } from "../storage";
import { MOMENT_SCHEMA_SQL, createMomentTables, foldMomentSpool, momentConformance } from "../moment-ledger";
import { appendFileSync } from "node:fs";

const dirs: string[] = [];
const ports: StoragePort[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-migration-"));
  dirs.push(dir);
  return dir;
};
const mkDb = (): StoragePort => {
  const db = new BetterSqlitePort(":memory:");
  ports.push(db);
  return db;
};
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const columnsOf = (db: StoragePort, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name).sort();

/** Every table the moment schema declares, read off the schema itself rather than hardcoded. */
const MOMENT_TABLES = [...MOMENT_SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);

describe("a store created before a column existed still works", () => {
  it("adds outcome_status to governed_moments, and the fold stops throwing", () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    // The pre-N2 shape, by hand: everything the table had before the column was introduced.
    db.exec(`CREATE TABLE governed_moments (
      moment_id TEXT PRIMARY KEY, opened INTEGER NOT NULL DEFAULT 0, at TEXT, session_id TEXT,
      tool_use_id TEXT, surface TEXT, action_sha256 TEXT, action_rendering TEXT, action_chars INTEGER,
      action_clipped INTEGER, stage_id TEXT, rule_ids TEXT, disposition TEXT, delivered_rule_ids TEXT,
      rule_reads TEXT NOT NULL DEFAULT '{}', outcome_at TEXT, outcome_sha256 TEXT, asked_at TEXT,
      answer TEXT, answered_at TEXT
    )`);
    expect(columnsOf(db, "governed_moments")).not.toContain("outcome_status");

    appendFileSync(
      spoolPath,
      `${JSON.stringify({
        v: 1, runId: "r", seq: 0, kind: "outcome", momentId: "m1", toolUseId: null,
        outcomeStatus: "failed", outcomeAt: "t", outcomeSha256: "a".repeat(64),
      })}\n`,
    );
    // Before the migration this threw: "table governed_moments has no column named outcome_status".
    expect(() => foldMomentSpool(db, spoolPath)).not.toThrow();
    expect(columnsOf(db, "governed_moments")).toContain("outcome_status");
  });

  it("adds outcome_status to moment_losses, so a held orphan outcome keeps its status", () => {
    const db = mkDb();
    db.exec(`CREATE TABLE moment_losses (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, run_id TEXT, from_seq INTEGER, to_seq INTEGER,
      tool_use_id TEXT, outcome_at TEXT, outcome_sha256 TEXT
    )`);
    createMomentTables(db);
    expect(columnsOf(db, "moment_losses")).toContain("outcome_status");
  });

  it("reaches the conformance surface without throwing on a pre-column store", () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    db.exec(`CREATE TABLE governed_moments (moment_id TEXT PRIMARY KEY, opened INTEGER NOT NULL DEFAULT 0)`);
    expect(() => momentConformance(db, spoolPath)).not.toThrow();
  });
});

describe("the migration is derived from the schema, not from a list", () => {
  it("brings every table to its full addable column set from its bare primary key", () => {
    // THE ANCESTOR IS THE TABLE WITH ITS PRIMARY KEY AND NOTHING ELSE, because a primary key is the
    // one thing ALTER TABLE cannot add — and it is present by construction, since no version of
    // this schema ever created these tables without one. Everything else must be reachable.
    const declared = declaredMomentColumns(MOMENT_SCHEMA_SQL);
    for (const table of MOMENT_TABLES) {
      const old = mkDb();
      old.exec(`CREATE TABLE ${table} (${firstColumnDeclaration(table)})`);
      createMomentTables(old);
      const got = columnsOf(old, table);
      for (const column of declared.get(table) ?? []) {
        expect(got, `${table}.${column.name} was not migrated`).toContain(column.name);
      }
      // And the migration claims a non-empty set for every table, so this cannot pass vacuously.
      expect((declared.get(table) ?? []).length, `${table} declared no addable columns`).toBeGreaterThan(0);
    }
  });

  /** The first column declaration of a table, read off the schema — its primary key in every case. */
  function firstColumnDeclaration(table: string): string {
    const start = MOMENT_SCHEMA_SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
    const open = MOMENT_SCHEMA_SQL.indexOf("(", start) + 1;
    let depth = 0;
    for (let i = open; i < MOMENT_SCHEMA_SQL.length; i += 1) {
      const ch = MOMENT_SCHEMA_SQL[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === "," && depth === 0) {
        return MOMENT_SCHEMA_SQL.slice(open, i).replace(/--[^\n]*/g, "").trim();
      }
    }
    throw new Error(`no first column found for ${table}`);
  }

  it("migrates a column this codebase has never seen, which is the whole point", () => {
    const db = mkDb();
    createMomentTables(db);
    // A column nobody wrote a migration entry for, because there are no entries to write. If this
    // ever fails, someone has replaced the derivation with a hand-maintained list and the next
    // column added to the schema will reach fresh stores only.
    const invented = MOMENT_SCHEMA_SQL.replace(
      "    answered_at TEXT\n  );",
      "    answered_at TEXT,\n    a_future_column TEXT\n  );",
    );
    expect(invented).not.toBe(MOMENT_SCHEMA_SQL);
    db.exec(invented.replace(/CREATE TABLE IF NOT EXISTS/g, "CREATE TABLE IF NOT EXISTS"));
    // The db already has the tables, so the CREATE above was a no-op — exactly the situation this
    // whole file is about. The migration must still notice the new column.
    const migrated = mkDb();
    migrated.exec(`CREATE TABLE governed_moments (moment_id TEXT PRIMARY KEY)`);
    migrateSchemaInto(migrated, invented);
    expect(columnsOf(migrated, "governed_moments")).toContain("a_future_column");
  });
});

/**
 * Runs the real three-phase sequence against an arbitrary schema string — the same order
 * `createMomentTables` uses, because the ordering is part of what is being tested.
 */
function migrateSchemaInto(db: StoragePort, schema: string): void {
  const DEFERRED = /(?:CREATE (?:UNIQUE )?INDEX|INSERT)[^;]*;/g;
  const executable = schema.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  const deferred = executable.match(DEFERRED) ?? [];
  db.exec(executable.replace(DEFERRED, ""));
  migrateMomentColumnsFrom(db, schema);
  for (const statement of deferred) db.exec(statement);
}

// Imported lazily so the test file states plainly which internal it depends on.
import { declaredMomentColumns, migrateMomentColumnsFrom } from "../moment-ledger";
