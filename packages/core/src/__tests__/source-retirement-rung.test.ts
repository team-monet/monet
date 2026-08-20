/**
 * Schema rung 13 — the source subsystem's retirement (#16).
 *
 * The rung carries no migration: what changed is what this build CREATES (a new store grows none
 * of the subsystem's tables and neither marker column), while rows already in a store are left
 * exactly where they are — disposing of them is `monet retire-source`, behind a verified backup,
 * whenever the operator wants.
 *
 * So the property worth pinning is that every store climbs it, unconditionally. A rung only some
 * stores reach is not a rung: it leaves the next one with no single predecessor to gate on, which
 * is the whole reason the ladder exists.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { MONET_SCHEMA_VERSION } from "../schema-version";
import { RETIRED_SOURCE_TABLES } from "../source-retirement";
import type { StoragePort } from "../storage";

const raw = (core: MonetCore): StoragePort => (core as unknown as { db: StoragePort }).db;

async function withStore(run: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "monet-retirement-rung-"));
  try {
    await run(join(dir, "monet.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A 1.6.x store: the subsystem's tables and marker columns, with content still in them. */
function seedUnretired(core: MonetCore): void {
  const db = raw(core);
  db.exec(`ALTER TABLE concepts ADD COLUMN source_identity TEXT`);
  db.exec(`ALTER TABLE concepts ADD COLUMN active_observation_id TEXT`);
  for (const table of RETIRED_SOURCE_TABLES) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, circle TEXT)`);
  }
  db.prepare(`INSERT INTO knowledge_sources (id, circle) VALUES ('vault', 'default')`).run();
  const now = Date.now();
  db.prepare(
    `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, version, circle,
                           support_count, dirty, embedding, updated_at, created_at, source_identity)
     VALUES ('vault-note', 'note', 'Meeting notes', 'quarterly planning', 'source', 'active', 0.5, 1,
             'default', 1, 0, '[]', ?, ?, 'source://vault')`,
  ).run(now, now);
  db.pragma("user_version = 12");
}

describe("schema rung 13 — source subsystem retirement", () => {
  it("a fresh store reaches it and grows none of the retired schema", async () => {
    await withStore(async (dbPath) => {
      const core = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      try {
        await core.store("An ordinary memory.", { resolution: "forceNew" });
        expect(raw(core).pragma("user_version", { simple: true })).toBe(MONET_SCHEMA_VERSION);
        const tables = new Set(
          (raw(core).prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
            .map((row) => row.name),
        );
        for (const table of RETIRED_SOURCE_TABLES) expect(tables.has(table)).toBe(false);
        const columns = new Set(
          (raw(core).prepare(`PRAGMA table_info(concepts)`).all() as Array<{ name: string }>).map((c) => c.name),
        );
        expect(columns.has("source_identity")).toBe(false);
        expect(columns.has("active_observation_id")).toBe(false);
      } finally {
        core.close();
      }
    });
  });

  it("an UNRETIRED store climbs it too, keeping every row and table it already had", async () => {
    await withStore(async (dbPath) => {
      const seeded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      seedUnretired(seeded);
      seeded.close();

      const upgraded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      try {
        // THE RUNG IS UNCONDITIONAL. Gating it on "has the retired schema been disposed of" would
        // strand this store at 12 forever and leave rung 14 with two possible predecessors.
        expect(raw(upgraded).pragma("user_version", { simple: true })).toBe(MONET_SCHEMA_VERSION);
        // And it disposes of nothing: deletion is retire-source's job, behind a backup.
        expect(raw(upgraded).prepare(`SELECT COUNT(*) AS n FROM knowledge_sources`).get()).toEqual({ n: 1 });
        expect(raw(upgraded).prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source'`).get())
          .toEqual({ n: 1 });
      } finally {
        upgraded.close();
      }
    });
  });

  it("is inert on reopen", async () => {
    await withStore(async (dbPath) => {
      const seeded = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      await seeded.store("A memory across two opens.", { resolution: "forceNew" });
      seeded.close();

      const first = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      const snapshot = raw(first).prepare(`SELECT * FROM concepts ORDER BY id`).all();
      first.close();

      const second = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      try {
        expect(raw(second).pragma("user_version", { simple: true })).toBe(MONET_SCHEMA_VERSION);
        expect(raw(second).prepare(`SELECT * FROM concepts ORDER BY id`).all()).toEqual(snapshot);
      } finally {
        second.close();
      }
    });
  });
});
