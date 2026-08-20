/**
 * `monet retire-source` — the destructive half of the source subsystem's retirement (#16).
 *
 * Run against a REAL store rather than the fake ports the rest of repair-cli's tests use, because
 * the property that matters here is an ordering fact about the filesystem: the verified backup
 * exists before a single row is deleted. A fake port can be told it took a backup; only a real one
 * proves the file is there and holds the rows the store no longer does.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { BetterSqlitePort, MonetCore, RETIRED_SOURCE_TABLES, inspectStoredEmbedderState } from "@team-monet/core";
import { defaultRecoveryDependencies, registerRecoveryCommands } from "../repair-cli";
import type { RecoveryCliDependencies } from "../repair-cli";

/** A store in the schema-12 shape: marker columns, the subsystem's tables, one connector concept. */
function seedSchema12Store(dbPath: string): void {
  const core = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
  const db = (core as unknown as { db: BetterSqlitePort }).db;
  db.exec(`ALTER TABLE concepts ADD COLUMN source_identity TEXT`);
  db.exec(`ALTER TABLE concepts ADD COLUMN active_observation_id TEXT`);
  for (const table of RETIRED_SOURCE_TABLES) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, circle TEXT)`);
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, version, circle,
                           support_count, dirty, embedding, updated_at, created_at,
                           source_identity, active_observation_id)
     VALUES ('connector-concept', 'connector-doc', 'Connector doc', 'materialized file body', 'source',
             'active', 0.5, 1, 'default', 1, 0, '[0.1,0.2]', ?, ?, 'source://src-a', 'connector-observation')`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO observations (id, content, embedding, kind, circle, concept_id, author_agent_id,
                               created_at, updated_at, source_refs)
     VALUES ('connector-observation', 'materialized chunk', '[0.1,0.2]', 'source', 'default',
             'connector-concept', 'connector', ?, ?, '[0.1,0.2]')`,
  ).run(now, now);
  db.pragma("user_version = 12");
  core.close();
}

async function run(args: string[], dependencies: RecoveryCliDependencies): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values: unknown[]): void => { stdout.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]): void => { stderr.push(values.map(String).join(" ")); };
  try {
    const program = new Command().name("monet");
    registerRecoveryCommands(program, dependencies);
    await program.parseAsync(["node", "monet", ...args]);
    return { stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function withStore(run: (dbPath: string, dependencies: RecoveryCliDependencies) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "monet-retire-source-cli-"));
  const dbPath = join(dir, "monet.db");
  const dependencies: RecoveryCliDependencies = { ...defaultRecoveryDependencies(), dbPath: () => dbPath };
  return run(dbPath, dependencies).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("monet retire-source", () => {
  it("without --apply, reports the population and changes nothing", async () => {
    await withStore(async (dbPath, dependencies) => {
      seedSchema12Store(dbPath);
      const output = await run(["retire-source"], dependencies);

      expect(output.stdout).toContain("1 concept(s), 1 observation(s)");
      expect(output.stdout).toContain("--apply --yes");

      const port = new BetterSqlitePort(dbPath);
      try {
        expect(port.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source'`).get()).toEqual({ n: 1 });
        expect(port.pragma("user_version", { simple: true })).toBe(12);
      } finally {
        port.close();
      }
      expect(existsSync(join(dbPath, "..", "backups"))).toBe(false);
    });
  });

  it("with --apply --yes, takes a verified backup that still holds the rows the store no longer does", async () => {
    await withStore(async (dbPath, dependencies) => {
      seedSchema12Store(dbPath);
      const output = await run(["retire-source", "--apply", "--yes"], dependencies);

      expect(output.stdout).toContain("Retired 1 concept(s) and 1 observation(s).");
      const backupLine = /backup: (.+)/.exec(output.stderr);
      expect(backupLine).not.toBeNull();
      const backupPath = backupLine![1]!;
      expect(existsSync(backupPath)).toBe(true);

      // THE ORDERING FACT: the backup predates the delete, so it still has the rows.
      const backup = new BetterSqlitePort(backupPath);
      try {
        expect(backup.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source'`).get()).toEqual({ n: 1 });
      } finally {
        backup.close();
      }

      const port = new BetterSqlitePort(dbPath);
      try {
        expect(port.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source'`).get()).toEqual({ n: 0 });
      } finally {
        port.close();
      }

      // And the store opens normally afterwards, with the retired schema gone.
      const core = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      try {
        const db = (core as unknown as { db: BetterSqlitePort }).db;
        const tables = new Set(
          (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
            .map((row) => row.name),
        );
        for (const table of RETIRED_SOURCE_TABLES) expect(tables.has(table)).toBe(false);
      } finally {
        core.close();
      }
    });
  });

  it("refuses --apply without --yes, before opening the store", async () => {
    await withStore(async (dbPath, dependencies) => {
      seedSchema12Store(dbPath);
      await expect(run(["retire-source", "--apply"], dependencies)).rejects.toThrow(/--apply requires --yes/);

      const port = new BetterSqlitePort(dbPath);
      try {
        expect(port.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source'`).get()).toEqual({ n: 1 });
      } finally {
        port.close();
      }
    });
  });

  it("says so plainly when there is nothing to retire", async () => {
    await withStore(async (dbPath, dependencies) => {
      const core = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      await core.store("An ordinary native memory.", { resolution: "forceNew" });
      core.close();
      expect(inspectStoredEmbedderState(dbPath).exists).toBe(true);

      const output = await run(["retire-source"], dependencies);
      expect(output.stdout).toContain("Nothing to retire");
      expect(readdirSync(join(dbPath, ".."))).not.toContain("backups");
    });
  });

  it("refuses a store whose schema is newer than this build supports, before opening a write port", async () => {
    await withStore(async (dbPath, dependencies) => {
      seedSchema12Store(dbPath);
      const port = new BetterSqlitePort(dbPath);
      port.pragma("user_version = 99");
      port.close();

      await expect(run(["retire-source", "--apply", "--yes"], dependencies))
        .rejects.toThrow(/store schema 99 is newer than supported schema/);

      // Nothing was deleted and no backup was taken for a purge that must not run.
      const check = new BetterSqlitePort(dbPath);
      try {
        expect(check.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source'`).get()).toEqual({ n: 1 });
      } finally {
        check.close();
      }
      expect(existsSync(join(dbPath, "..", "backups"))).toBe(false);
    });
  });

  it("reprojects a native concept that owned a purged source observation", async () => {
    await withStore(async (dbPath, dependencies) => {
      // Seeded through a raw port: the store holds connector rows, so MonetCore refuses to open it.
      seedSchema12Store(dbPath);
      const port = new BetterSqlitePort(dbPath);
      const owner = "native-owner";
      const now = Date.now();
      port.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, version, circle,
                               support_count, dirty, embedding, updated_at, created_at)
         VALUES (?, 'owner', 'Owner', 'body', 'fact', 'active', 0.6, 1, 'default', 2, 0, '[0.1,0.2]', ?, ?)`,
      ).run(owner, now, now);
      // Grafting legitimately produces this shape: a NATIVE concept owning a kind='source'
      // observation. The purge deletes the observation; without a reprojection the owner keeps a
      // support count and centroid describing evidence that no longer exists.
      port.prepare(
        `INSERT INTO observations (id, content, embedding, kind, circle, concept_id, author_agent_id,
                                   created_at, updated_at, source_refs)
         VALUES ('grafted-source-obs', 'grafted chunk', '[0.9,0.9]', 'source', 'default', ?, 'peer', ?, ?, '[0.1,0.2]')`,
      ).run(owner, now, now);
      port.prepare(
        `INSERT INTO observations (id, content, embedding, kind, circle, concept_id, author_agent_id,
                                   created_at, updated_at, source_refs)
         VALUES ('native-obs', 'native evidence', '[0.1,0.2]', 'statement', 'default', ?, 'local', ?, ?, '[0.1,0.2]')`,
      ).run(owner, now, now);
      port.close();

      const output = await run(["retire-source", "--apply", "--yes"], dependencies);
      expect(output.stdout).toContain("Reprojected 1 native concept(s)");

      const reopened = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      try {
        const db = (reopened as unknown as { db: BetterSqlitePort }).db;
        const after = db.prepare(`SELECT support_count AS n FROM concepts WHERE id = ?`).get(owner) as { n: number };
        const live = db.prepare(
          `SELECT COUNT(*) AS n FROM observations
            WHERE concept_id = ? AND superseded_by IS NULL AND superseded_at IS NULL`,
        ).get(owner) as { n: number };
        // The stale count was 2 with only one surviving observation; the projection now matches.
        expect(live.n).toBe(1);
        expect(after.n).toBe(1);
      } finally {
        reopened.close();
      }
    });
  });

  it("refuses before deleting anything when the pinned embedder cannot be loaded", async () => {
    await withStore(async (dbPath, dependencies) => {
      seedSchema12Store(dbPath);
      const port = new BetterSqlitePort(dbPath);
      const now = Date.now();
      port.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, version, circle,
                               support_count, dirty, embedding, updated_at, created_at)
         VALUES ('native-owner', 'owner', 'Owner', 'body', 'fact', 'active', 0.6, 1, 'default', 2, 0, '[0.1,0.2]', ?, ?)`,
      ).run(now, now);
      port.prepare(
        `INSERT INTO observations (id, content, embedding, kind, circle, concept_id, author_agent_id,
                                   created_at, updated_at, source_refs)
         VALUES ('grafted-source-obs', 'grafted chunk', '[0.9,0.9]', 'source', 'default',
                 'native-owner', 'peer', ?, ?, '[0.1,0.2]')`,
      ).run(now, now);
      port.close();

      // The reprojection this purge would owe cannot run without the store's own embedder, and
      // discovering that AFTER the delete leaves a stale projection nothing can repair.
      const deps: RecoveryCliDependencies = {
        ...dependencies,
        instantiate: async () => { throw new Error("model cache empty"); },
      };
      await expect(run(["retire-source", "--apply", "--yes"], deps))
        .rejects.toThrow(/could not be loaded \(model cache empty\).*Nothing has been deleted/s);

      const check = new BetterSqlitePort(dbPath);
      try {
        expect(check.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source'`).get()).toEqual({ n: 1 });
        expect(check.prepare(`SELECT COUNT(*) AS n FROM observations WHERE id = 'grafted-source-obs'`).get())
          .toEqual({ n: 1 });
      } finally {
        check.close();
      }
      expect(existsSync(join(dbPath, "..", "backups"))).toBe(false);
    });
  });

  it("keeps observations the user attached after the upgrade, and the concept they belong to", async () => {
    await withStore(async (dbPath, dependencies) => {
      seedSchema12Store(dbPath);
      const port = new BetterSqlitePort(dbPath);
      const now = Date.now();
      // Retained rows are served as ordinary memories, so a user can legitimately write on one.
      port.prepare(
        `INSERT INTO observations (id, content, embedding, kind, circle, concept_id, author_agent_id,
                                   created_at, updated_at, source_refs)
         VALUES ('user-note', 'my own note on this file', '[0.1,0.2]', 'statement', 'default',
                 'connector-concept', 'local', ?, ?, '[0.1,0.2]')`,
      ).run(now, now);
      port.close();

      await run(["retire-source", "--apply", "--yes"], dependencies);

      const check = new BetterSqlitePort(dbPath);
      try {
        // The connector's own chunk is gone; what the user wrote is not, and neither is its concept.
        expect(check.prepare(`SELECT COUNT(*) AS n FROM observations WHERE kind = 'source'`).get()).toEqual({ n: 0 });
        expect(check.prepare(`SELECT COUNT(*) AS n FROM observations WHERE id = 'user-note'`).get()).toEqual({ n: 1 });
        expect(check.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE id = 'connector-concept'`).get())
          .toEqual({ n: 1 });
      } finally {
        check.close();
      }
    });
  });

  it("drops the empty residue itself rather than promising a migration that no longer exists", async () => {
    await withStore(async (dbPath, dependencies) => {
      // Retired tables and marker columns present, all empty — nothing to lose, so no backup.
      const core = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      const db = (core as unknown as { db: BetterSqlitePort }).db;
      db.exec(`ALTER TABLE concepts ADD COLUMN source_identity TEXT`);
      for (const table of RETIRED_SOURCE_TABLES) {
        db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, circle TEXT)`);
      }
      core.close();

      const output = await run(["retire-source", "--apply", "--yes"], dependencies);
      expect(output.stdout).toContain("Dropped the empty tables");

      const check = new BetterSqlitePort(dbPath);
      try {
        const tables = new Set(
          (check.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
            .map((row) => row.name),
        );
        for (const table of RETIRED_SOURCE_TABLES) expect(tables.has(table)).toBe(false);
        const columns = new Set(
          (check.prepare(`PRAGMA table_info(concepts)`).all() as Array<{ name: string }>).map((c) => c.name),
        );
        expect(columns.has("source_identity")).toBe(false);
      } finally {
        check.close();
      }
    });
  });

  it("normalizes a surviving concept so a second run reaches the disposed state", async () => {
    await withStore(async (dbPath, dependencies) => {
      seedSchema12Store(dbPath);
      const port = new BetterSqlitePort(dbPath);
      const now = Date.now();
      port.prepare(
        `INSERT INTO observations (id, content, embedding, kind, circle, concept_id, author_agent_id,
                                   created_at, updated_at, source_refs)
         VALUES ('user-note', 'my own note', '[0.1,0.2]', 'statement', 'default',
                 'connector-concept', 'local', ?, ?, '[]')`,
      ).run(now, now);
      // History the user made on that concept AFTER the upgrade — concept-wide cleanup must not
      // take it just because the row started life as connector-owned.
      port.prepare(
        `INSERT INTO concept_revisions (id, concept_id, version, body, created_at)
         VALUES ('rev-user', 'connector-concept', 2, 'my own note', ?)`,
      ).run(now);
      port.close();

      await run(["retire-source", "--apply", "--yes"], dependencies);

      const check = new BetterSqlitePort(dbPath);
      try {
        // The survivor is native now: left as kind='source' it would be re-detected as retirement
        // data forever, and the store could never reach a disposed state.
        expect(check.prepare(`SELECT kind FROM concepts WHERE id = 'connector-concept'`).get())
          .toEqual({ kind: "fact" });
        expect(check.prepare(`SELECT COUNT(*) AS n FROM concept_revisions WHERE id = 'rev-user'`).get())
          .toEqual({ n: 1 });
      } finally {
        check.close();
      }

      // The second run has nothing left to find — disposal terminates.
      const second = await run(["retire-source"], dependencies);
      expect(second.stdout).toContain("Nothing to retire");
    });
  });

  it("rebuilds a survivor's body and provenance, so the file text it reports as deleted is gone", async () => {
    await withStore(async (dbPath, dependencies) => {
      seedSchema12Store(dbPath);
      const port = new BetterSqlitePort(dbPath);
      const now = Date.now();
      // The connector wrote the FILE into the body, and the ordinary attach path appends to it —
      // so after a user writes on the concept its body holds both.
      port.prepare(
        `UPDATE concepts SET body = ?, source_refs = ? WHERE id = 'connector-concept'`,
      ).run(
        "SECRET FILE TEXT from the vault\n\nmy own note",
        JSON.stringify(["source://src-a/notes.md#a~1", "https://example.com/ticket"]),
      );
      port.prepare(
        `INSERT INTO observations (id, content, embedding, kind, circle, concept_id, author_agent_id,
                                   created_at, updated_at, source_refs)
         VALUES ('user-note', 'my own note', '[0.1,0.2]', 'statement', 'default',
                 'connector-concept', 'local', ?, ?, '[0.1,0.2]')`,
      ).run(now, now);
      port.close();

      await run(["retire-source", "--apply", "--yes"], dependencies);

      const check = new BetterSqlitePort(dbPath);
      try {
        const row = check.prepare(`SELECT body, source_refs, dirty FROM concepts WHERE id = 'connector-concept'`)
          .get() as { body: string; source_refs: string | null; dirty: number };
        expect(row.body).not.toContain("SECRET FILE TEXT");
        expect(row.body).toContain("my own note");
        // `source://` provenance is reserved to a connector that no longer exists.
        expect(row.source_refs ?? "").not.toContain("source://");
        expect(row.source_refs ?? "").toContain("example.com");
        // Marked for synthesis: the joined body is an interim, not a final one.
        expect(row.dirty).toBe(1);
      } finally {
        check.close();
      }
    });
  });
});
