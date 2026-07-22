import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { inspectStoredEmbedderState } from "../diagnostics";
import { HashingEmbeddingProvider } from "../embedding";
import { MonetCore } from "../engine";

function withTempDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "monet-diagnostics-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function vector(width: number, value = 1): string {
  return JSON.stringify(Array.from({ length: width }, () => value));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("inspectStoredEmbedderState", () => {
  it("reports a missing database without creating it or any sidecar", async () => {
    await withTempDir((dir) => {
      const dbPath = join(dir, "missing.db");
      expect(inspectStoredEmbedderState(dbPath)).toMatchObject({
        dbPath: resolve(dbPath),
        exists: false,
        schemaVersion: null,
        assessment: "missing",
      });
      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    });
  });

  it("reports exact counts, dimensions, malformed rows, pin metadata, and all four live populations", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "current.db");
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      await core.store("native diagnostic row", { resolution: "forceNew" });
      await core.storeSource("source diagnostic row", { sourceRefs: ["source://diagnostic"] });
      core.close();

      const raw = new Database(dbPath);
      const sourceObservation = raw.prepare(`SELECT id FROM observations WHERE kind = 'source'`).pluck().get() as string;
      const sourceConcept = raw.prepare(`SELECT id FROM concepts WHERE kind = 'source'`).pluck().get() as string;
      raw.prepare(`UPDATE observations SET embedding = ? WHERE id = ?`).run(vector(384), sourceObservation);
      raw.prepare(`UPDATE concepts SET embedding = ? WHERE id = ?`).run(vector(384), sourceConcept);
      raw.close();

      const state = inspectStoredEmbedderState(dbPath);
      expect(state).toMatchObject({
        exists: true,
        schemaVersion: 10,
        integrity: { status: "ok", check: "ok" },
        pin: {
          status: "known",
          modelId: "hashing:dim=256:tok=2",
          source: "created",
        },
        assessment: "unsafe",
        migration: { status: "none" },
      });
      expect(state.populations.nativeObservations).toMatchObject({
        status: "known", liveRowCount: 1, scoredVectorCount: 1, dimensions: [256],
      });
      expect(state.populations.nativeConcepts).toMatchObject({
        status: "known", liveRowCount: 1, scoredVectorCount: 1, dimensions: [256],
      });
      expect(state.populations.sourceObservations).toMatchObject({
        status: "known", liveRowCount: 1, scoredVectorCount: 1, dimensions: [384],
      });
      expect(state.populations.sourceConcepts).toMatchObject({
        status: "known", liveRowCount: 1, scoredVectorCount: 1, dimensions: [384],
      });
    });
  });

  it("returns exact malformed counts with a deterministic bounded sample", async () => {
    await withTempDir((dir) => {
      const dbPath = join(dir, "malformed.db");
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      core.close();
      const raw = new Database(dbPath);
      const insert = raw.prepare(
        `INSERT INTO observations (id, content, embedding, kind, author_agent_id)
         VALUES (?, 'bad', 'not-json', 'statement', 'test')`,
      );
      const transaction = raw.transaction(() => {
        for (let index = 24; index >= 0; index--) insert.run(`malformed-${String(index).padStart(2, "0")}`);
      });
      transaction();
      raw.close();

      const population = inspectStoredEmbedderState(dbPath).populations.nativeObservations;
      expect(population.status).toBe("known");
      if (population.status !== "known") throw new Error(population.reason);
      expect(population.malformed).toEqual({
        count: 25,
        sampleIds: Array.from({ length: 20 }, (_, index) => `malformed-${String(index).padStart(2, "0")}`),
      });
      expect(population.liveRowCount).toBe(25);
      expect(population.scoredVectorCount).toBe(0);
    });
  });

  it("marks a provable hashing pin/width mismatch unsafe, a match safe, and an arbitrary model identity unknown", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "pin-width.db");
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      await core.store("pin-width diagnostic row", { resolution: "forceNew" });
      core.close();

      expect(inspectStoredEmbedderState(dbPath)).toMatchObject({
        pin: { status: "known", modelId: "hashing:dim=256:tok=2" },
        assessment: "safe",
      });

      const raw = new Database(dbPath);
      raw.prepare(`UPDATE observations SET embedding = ?`).run(vector(384));
      raw.prepare(`UPDATE concepts SET embedding = ?`).run(vector(384));
      raw.close();
      expect(inspectStoredEmbedderState(dbPath)).toMatchObject({
        populations: {
          nativeObservations: { status: "known", dimensions: [384] },
          nativeConcepts: { status: "known", dimensions: [384] },
        },
        assessment: "unsafe",
      });

      const unknown = new Database(dbPath);
      unknown.prepare(`UPDATE sync_meta SET embedder_model_id = 'custom/model-with-unloaded-width'`).run();
      unknown.close();
      expect(inspectStoredEmbedderState(dbPath)).toMatchObject({
        pin: { status: "known", modelId: "custom/model-with-unloaded-width" },
        assessment: "unknown",
      });
    });
  });

  it("reports legacy and partial schemas as unknown instead of inferring safety", async () => {
    await withTempDir((dir) => {
      const legacyPath = join(dir, "legacy.db");
      const legacy = new Database(legacyPath);
      legacy.exec(`
        CREATE TABLE observations (id TEXT, kind TEXT, embedding TEXT);
        CREATE TABLE concepts (id TEXT, kind TEXT, status TEXT, embedding TEXT);
        PRAGMA user_version = 5;
      `);
      legacy.prepare(`INSERT INTO observations VALUES ('legacy-o', 'statement', ?)`).run(vector(256));
      legacy.prepare(`INSERT INTO concepts VALUES ('legacy-c', 'fact', 'active', ?)`).run(vector(256));
      legacy.close();

      const legacyState = inspectStoredEmbedderState(legacyPath);
      expect(legacyState.schemaVersion).toBe(5);
      expect(legacyState.assessment).toBe("unknown");
      expect(legacyState.populations.nativeObservations.status).toBe("known");
      expect(legacyState.populations.sourceObservations).toMatchObject({ status: "unknown" });
      expect(legacyState.pin).toMatchObject({ status: "unknown" });
      expect(legacyState.migration).toMatchObject({ status: "unknown" });

      const partialPath = join(dir, "partial.db");
      const partial = new Database(partialPath);
      partial.exec(`
        CREATE TABLE embedder_migration (singleton INTEGER PRIMARY KEY, target_model_id TEXT, started_at INTEGER);
        PRAGMA user_version = 10;
      `);
      partial.prepare(`INSERT INTO embedder_migration VALUES (1, 'target', 123)`).run();
      partial.close();
      expect(inspectStoredEmbedderState(partialPath)).toMatchObject({
        assessment: "unknown",
        migration: { status: "unknown" },
      });
    });
  });

  it("classifies active sentinel abandon safety in parity with the migration lifecycle", async () => {
    await withTempDir((dir) => {
      const dbPath = join(dir, "sentinel.db");
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
      core.close();
      const raw = new Database(dbPath);
      const insert = raw.prepare(`
        INSERT INTO embedder_migration (
          singleton, target_model_id, started_at, prior_model_id, prior_pin_source,
          prior_pinned_at, prior_pin_captured, vectors_rewritten
        ) VALUES (1, 'hashing:dim=256:tok=2', 123, ?, ?, ?, ?, ?)
      `);
      const remove = raw.prepare(`DELETE FROM embedder_migration`);

      insert.run("hashing:dim=256:tok=1", "created", 100, 1, 0);
      expect(inspectStoredEmbedderState(dbPath).migration).toMatchObject({
        status: "active",
        rewriteProgress: "not-started",
        abandon: { classification: "safe" },
        priorPin: { captured: true, modelId: "hashing:dim=256:tok=1" },
      });
      remove.run();
      insert.run(null, null, null, 0, 0);
      expect(inspectStoredEmbedderState(dbPath).migration).toMatchObject({
        status: "active",
        abandon: { classification: "unsupported" },
      });
      remove.run();
      insert.run("hashing:dim=256:tok=1", "created", 100, 1, 1);
      expect(inspectStoredEmbedderState(dbPath).migration).toMatchObject({
        status: "active",
        rewriteProgress: "started-or-unknown",
        abandon: { classification: "refused" },
      });
      raw.close();
    });
  });

  it("throws typed failures for non-SQLite, unreadable, and locked existing paths", async () => {
    await withTempDir((dir) => {
      const textPath = join(dir, "text.db");
      writeFileSync(textPath, "not sqlite");
      expect(() => inspectStoredEmbedderState(textPath)).toThrowError(
        expect.objectContaining({ name: "StoredEmbedderStateDiagnosticError", reason: "not-sqlite" }),
      );

      expect(() => inspectStoredEmbedderState(dir)).toThrowError(
        expect.objectContaining({ name: "StoredEmbedderStateDiagnosticError", reason: "unreadable" }),
      );

      const lockedPath = join(dir, "locked.db");
      const lock = new Database(lockedPath);
      lock.exec(`CREATE TABLE lock_probe (id INTEGER); BEGIN EXCLUSIVE; INSERT INTO lock_probe VALUES (1)`);
      try {
        expect(() => inspectStoredEmbedderState(lockedPath)).toThrowError(
          expect.objectContaining({ name: "StoredEmbedderStateDiagnosticError", reason: "locked" }),
        );
      } finally {
        lock.exec(`ROLLBACK`);
        lock.close();
      }
    });
  }, 10_000);

  it("does not mutate database, schema, WAL, or SHM bytes and does not create absent sidecars", async () => {
    await withTempDir(async (dir) => {
      const dbPath = join(dir, "readonly.db");
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      await core.store("WAL-resident diagnostic row", { resolution: "forceNew" });
      const paths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
      expect(paths.every(existsSync)).toBe(true);
      const beforeHashes = paths.map(sha256);
      const beforeSchema = (core as any).db
        .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name`)
        .all();
      const beforeVersion = (core as any).db.pragma("user_version", { simple: true });

      expect(inspectStoredEmbedderState(dbPath).exists).toBe(true);

      expect(paths.map(sha256)).toEqual(beforeHashes);
      expect((core as any).db.pragma("user_version", { simple: true })).toBe(beforeVersion);
      expect((core as any).db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name`).all())
        .toEqual(beforeSchema);
      core.close();

      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
      inspectStoredEmbedderState(dbPath);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
    });
  });
});
