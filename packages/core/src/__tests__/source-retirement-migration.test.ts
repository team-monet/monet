/**
 * Schema 12 → 13: the source subsystem's retirement (#16).
 *
 * The rung is split, and these tests hold the split. A store that still holds connector-owned rows
 * REFUSES to open — deleting them is irreversible, and this build will not do that behind an
 * ordinary `new MonetCore(path)`. Once the destructive half has run (behind the verified backup
 * `monet retire-source` takes), opening drops the residue and every later open is inert.
 *
 * A schema-12 store cannot be built by this engine any more (it no longer declares the marker
 * columns or creates the source tables), so the fixture re-creates that shape directly, the same
 * way first-block-migration.test.ts re-creates schema 11.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { BetterSqlitePort } from "../storage";
import type { StoragePort } from "../storage";
import {
  dropRetiredSourceResidue,
  purgeConnectorPopulation,
  RETIRED_SOURCE_TABLES,
  SourceRetirementRequiredError,
} from "../source-retirement";

const raw = (core: MonetCore): StoragePort => (core as unknown as { db: StoragePort }).db;

function tableNames(db: StoragePort): Set<string> {
  return new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
}

function conceptColumns(db: StoragePort): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(concepts)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
}

/** Rebuild the schema-12 shape on top of a current store: marker columns, source tables, rows. */
function seedSchema12(core: MonetCore): void {
  const db = raw(core);
  db.exec(`ALTER TABLE concepts ADD COLUMN source_identity TEXT`);
  db.exec(`ALTER TABLE concepts ADD COLUMN active_observation_id TEXT`);
  for (const table of RETIRED_SOURCE_TABLES) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, circle TEXT)`);
  }
  db.prepare(`INSERT INTO knowledge_sources (id, circle) VALUES ('src-a', 'default')`).run();
  db.prepare(`INSERT INTO source_chunks (id, circle) VALUES ('chunk-1', 'default')`).run();

  const now = Date.now();
  db.prepare(
    `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, version, circle,
                           support_count, dirty, embedding, updated_at, created_at,
                           source_identity, active_observation_id)
     VALUES ('connector-concept', 'connector-doc', 'Connector doc', 'materialized file body', 'source',
             'active', 0.5, 1, 'default', 1, 0, '[]', ?, ?, 'source://src-a', 'connector-observation')`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO observations (id, content, embedding, kind, circle, concept_id, author_agent_id,
                               created_at, updated_at, source_refs)
     VALUES ('connector-observation', 'materialized chunk', '[]', 'source', 'default',
             'connector-concept', 'connector', ?, ?, ?)`,
  ).run(now, now, JSON.stringify(["source://src-a/doc.md#a~1"]));
  db.pragma("user_version = 12");
}

async function withStore(run: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "monet-source-retirement-"));
  try {
    await run(join(dir, "monet.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The destructive half as `monet retire-source` runs it — on the port, without a core. */
function purgeOnPort(dbPath: string): { concepts: number; observations: number } {
  const port = new BetterSqlitePort(dbPath);
  try {
    return purgeConnectorPopulation(port);
  } finally {
    port.close();
  }
}

describe("schema 12 → 13 — source subsystem retirement", () => {
  it("refuses to open a store that still holds connector rows, and names the command that disposes of them", async () => {
    await withStore(async (dbPath) => {
      const seeded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      await seeded.store("A native memory that must survive.", { resolution: "forceNew" });
      seedSchema12(seeded);
      seeded.close();

      let caught: unknown;
      try {
        new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SourceRetirementRequiredError);
      expect((caught as SourceRetirementRequiredError).population).toEqual({ concepts: 1, observations: 1 });
      expect((caught as Error).message).toContain("monet retire-source --apply --yes");

      // REFUSED MEANS UNTOUCHED, not half-migrated: the store is exactly as it was.
      const port = new BetterSqlitePort(dbPath);
      try {
        expect(port.pragma("user_version", { simple: true })).toBe(12);
        expect(port.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source'`).get()).toEqual({ n: 1 });
        expect(tableNames(port).has("knowledge_sources")).toBe(true);
      } finally {
        port.close();
      }
    });
  });

  it("after the purge, opening drops the residue and leaves native rows byte-identical", async () => {
    await withStore(async (dbPath) => {
      const seeded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      const native = await seeded.store("A native memory that must survive the purge.", { resolution: "forceNew" });
      const nativeBefore = raw(seeded).prepare(`SELECT * FROM concepts WHERE id = ?`).get(native.conceptId);
      const nativeObservationsBefore = raw(seeded)
        .prepare(`SELECT * FROM observations WHERE concept_id = ? ORDER BY id`).all(native.conceptId);
      seedSchema12(seeded);
      seeded.close();

      expect(purgeOnPort(dbPath)).toEqual({ concepts: 1, observations: 1 });

      const upgraded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      try {
        expect(raw(upgraded).pragma("user_version", { simple: true })).toBe(13);
        expect(raw(upgraded).prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source'`).get())
          .toEqual({ n: 0 });
        expect(raw(upgraded).prepare(`SELECT COUNT(*) AS n FROM observations WHERE kind = 'source'`).get())
          .toEqual({ n: 0 });

        const tables = tableNames(raw(upgraded));
        for (const table of RETIRED_SOURCE_TABLES) expect(tables.has(table)).toBe(false);
        const columns = conceptColumns(raw(upgraded));
        expect(columns.has("source_identity")).toBe(false);
        expect(columns.has("active_observation_id")).toBe(false);

        // The purge is not a rewrite of everything it passes.
        expect(raw(upgraded).prepare(`SELECT * FROM concepts WHERE id = ?`).get(native.conceptId))
          .toEqual(nativeBefore);
        expect(raw(upgraded).prepare(`SELECT * FROM observations WHERE concept_id = ? ORDER BY id`).all(native.conceptId))
          .toEqual(nativeObservationsBefore);
      } finally {
        upgraded.close();
      }
    });
  });

  it("is a no-op on every later open — the version gate makes the residue drop run exactly once", async () => {
    await withStore(async (dbPath) => {
      const seeded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      await seeded.store("A native memory across two opens.", { resolution: "forceNew" });
      seedSchema12(seeded);
      seeded.close();
      purgeOnPort(dbPath);

      const first = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      const afterMigration = {
        concepts: raw(first).prepare(`SELECT * FROM concepts ORDER BY id`).all(),
        observations: raw(first).prepare(`SELECT * FROM observations ORDER BY id`).all(),
        entities: raw(first).prepare(`SELECT * FROM entities ORDER BY key, scope`).all(),
      };
      first.close();

      const second = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      try {
        expect(raw(second).pragma("user_version", { simple: true })).toBe(13);
        expect(raw(second).prepare(`SELECT * FROM concepts ORDER BY id`).all()).toEqual(afterMigration.concepts);
        expect(raw(second).prepare(`SELECT * FROM observations ORDER BY id`).all()).toEqual(afterMigration.observations);
        expect(raw(second).prepare(`SELECT * FROM entities ORDER BY key, scope`).all()).toEqual(afterMigration.entities);
      } finally {
        second.close();
      }
    });
  });

  it("a fresh store never grows the retired schema at all", async () => {
    await withStore(async (dbPath) => {
      const core = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      try {
        await core.store("A memory in a store built after the retirement.", { resolution: "forceNew" });
        expect(raw(core).pragma("user_version", { simple: true })).toBe(13);
        const tables = tableNames(raw(core));
        for (const table of RETIRED_SOURCE_TABLES) expect(tables.has(table)).toBe(false);
        const columns = conceptColumns(raw(core));
        expect(columns.has("source_identity")).toBe(false);
        expect(columns.has("active_observation_id")).toBe(false);
      } finally {
        core.close();
      }
    });
  });

  it("closes a constructor-owned port when it refuses, so the remediation can take exclusive ownership", async () => {
    await withStore(async (dbPath) => {
      const seeded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      await seeded.store("A native memory.", { resolution: "forceNew" });
      seedSchema12(seeded);
      seeded.close();

      // Ten refused opens. Each leaks a connection if the throw abandons its port, and the verified
      // backup the error tells the operator to run needs exclusive ownership of the file.
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(() => new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 }))
          .toThrow(SourceRetirementRequiredError);
      }
      const port = new BetterSqlitePort(dbPath);
      try {
        await expect(port.createVerifiedBackup(join(dbPath, "..", "after-refusals.db"))).resolves.toBeTruthy();
      } finally {
        port.close();
      }
    });
  });

  it("purges a store that predates the additive observation tables instead of rolling back on the first absent one", async () => {
    await withStore(async (dbPath) => {
      const seeded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      seedSchema12(seeded);
      // An older source-enabled store: the connector rows are there, the newer additive tables are not.
      raw(seeded).exec(`DROP TABLE observation_tokens`);
      raw(seeded).exec(`DROP TABLE observation_segments`);
      seeded.close();

      expect(purgeOnPort(dbPath)).toEqual({ concepts: 1, observations: 1 });
      const port = new BetterSqlitePort(dbPath);
      try {
        expect(port.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source'`).get()).toEqual({ n: 0 });
      } finally {
        port.close();
      }
    });
  });

  /*
   * WHAT THIS DOES AND DOES NOT PROVE. It pins that a second residue drop is inert — a real
   * property, and the one a re-run depends on. It does NOT reproduce the cross-process race Codex
   * named: that needs both migrators to take their presence check before either drop commits, and
   * two sequential in-process calls cannot open that window (verified — this test passes against
   * the unfixed code). The race is closed by construction instead: the drop runs in one write
   * transaction and re-reads presence inside it, so the loser sees the object already gone.
   */
  it("is inert on a second residue drop", async () => {
    await withStore(async (dbPath) => {
      const seeded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      seedSchema12(seeded);
      seeded.close();
      purgeOnPort(dbPath);

      // The loser of the race sees the table in its own check and finds it gone at the drop.
      const first = new BetterSqlitePort(dbPath);
      const second = new BetterSqlitePort(dbPath);
      try {
        dropRetiredSourceResidue(first);
        expect(() => dropRetiredSourceResidue(second)).not.toThrow();
      } finally {
        first.close();
        second.close();
      }
    });
  });
});
