import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  EmbedderMigrationFailedError,
  EmbedderMigrationIncompleteError,
  EmbedderMigrationReentryError,
  EmbedderRepairOwnershipError,
  MalformedEmbeddingStoreError,
  MonetCore,
  type EmbeddingMigrationPhase,
  type EmbeddingMigrationProgress,
} from "../index";
import type { EmbeddingProvider } from "../embedding";

class SpaceEmbedder implements EmbeddingProvider {
  readonly dim = 4;
  readonly failures = new Set<string>();
  readonly calls: string[] = [];
  readonly wrongWidths = new Set<string>();
  readonly nonfinite = new Set<string>();

  constructor(
    readonly modelId: string,
    private readonly space: number,
  ) {}

  embed(text: string): Float32Array {
    this.calls.push(text);
    if ([...this.failures].some((needle) => text.includes(needle))) {
      throw new Error(`injected embedding failure for ${text}`);
    }
    if ([...this.wrongWidths].some((needle) => text.includes(needle))) {
      return new Float32Array(this.dim - 1);
    }
    if ([...this.nonfinite].some((needle) => text.includes(needle))) {
      return new Float32Array([this.space, Number.NaN, 0, 0]);
    }
    let checksum = 0;
    for (const char of text) checksum = (checksum + char.codePointAt(0)!) % 997;
    return new Float32Array([this.space, text.length, checksum, this.space * 10 + (checksum % 7)]);
  }
}

type RawDb = { prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown } };

interface Fixture {
  activeA: string;
  activeB: string;
  retired: string;
  supersededObservation: string;
  currentObservation: string;
  activeBObservation: string;
  retiredObservation: string;
  workstream: string;
  workstreamText: string;
}

function dbOf(core: MonetCore): RawDb {
  return (core as unknown as { db: RawDb }).db;
}

function vector(db: RawDb, table: "concepts" | "observations", id: string): number[] {
  const row = db.prepare(`SELECT embedding FROM ${table} WHERE id = ?`).get(id) as { embedding: string };
  return JSON.parse(row.embedding) as number[];
}

function migrationRow(db: RawDb): { target_model_id: string } | undefined {
  return db.prepare(`SELECT target_model_id FROM embedder_migration WHERE singleton = 1`).get() as
    | { target_model_id: string }
    | undefined;
}

function pinRow(db: RawDb): { embedder_model_id: string | null; embedder_pin_source: string | null; embedder_pinned_at: number | null } {
  return db.prepare(
    `SELECT embedder_model_id, embedder_pin_source, embedder_pinned_at FROM sync_meta WHERE singleton = 1`,
  ).get() as ReturnType<typeof pinRow>;
}

function expected(embedder: SpaceEmbedder, text: string): number[] {
  return Array.from(embedder.embed(text));
}

/**
 * The normalized mean of a concept's live observation vectors — what `concepts.embedding` holds for
 * an ACTIVE native concept once a migration finishes (Codex #95, P1). `reembedConcept` can only
 * write `embed(body)`, because it runs before the observation phase has moved the evidence into the
 * target space; the migration then rebuilds the centroid from that evidence.
 *
 * Computed here in float32, mirroring `centroidOf` + `normalizeVector` rather than importing them,
 * so the expectation is independent of the code under test — and so this file still compiles against
 * a tree without the fix, making the red-before run a real assertion failure.
 *
 * A concept with NO live evidence, a `kind = 'source'` concept, and a RETIRED one all keep the body
 * embedding instead — see the migration's own comment for why each is excluded.
 */
function liveCentroid(db: RawDb, conceptId: string): number[] {
  const rows = db.prepare(
    `SELECT embedding FROM observations
      WHERE concept_id = ? AND superseded_by IS NULL AND superseded_at IS NULL ORDER BY id ASC`,
  ).all(conceptId) as Array<{ embedding: string }>;
  const vectors = rows.map((row) => new Float32Array(JSON.parse(row.embedding) as number[]));
  const out = new Float32Array(vectors[0]!.length);
  for (let d = 0; d < out.length; d++) {
    let sum = 0;
    for (const v of vectors) sum += v[d] ?? 0;
    out[d] = sum / vectors.length;
  }
  let mag = 0;
  for (let i = 0; i < out.length; i++) mag += out[i]! * out[i]!;
  mag = Math.sqrt(mag) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= mag;
  return Array.from(out);
}

function withTempDb(run: (dbPath: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "monet-migrate-embeddings-"));
  const dbPath = join(dir, "monet.db");
  return Promise.resolve(run(dbPath)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function seedFixture(dbPath: string, oldEmbedder: SpaceEmbedder): Promise<Fixture> {
  const core = new MonetCore(dbPath, {
    embedder: oldEmbedder,
    tauAttach: 1.1,
    tauAmbiguous: 1.1,
  });
  try {
    const first = await core.store("AuthService keeps the first observation.", { resolution: "forceNew" });
    const current = await core.store("AuthService keeps the current observation.", { attachTo: first.conceptId });
    core.supersedeObservation(first.observationId, current.observationId);
    const activeB = await core.store("AuthService has a second active concept.", { resolution: "forceNew" });
    const retired = await core.store("Retired native vector must still migrate.", { resolution: "forceNew" });
    core.retireConcept(retired.conceptId);

    const workstreamPayload = {
      status: "active" as const,
      open: [{ slot: "question" as const, text: "question" }, { slot: "step" as const, text: "step" }],
    };
    const workstream = await core.saveWorkstream(workstreamPayload);

    return {
      activeA: first.conceptId,
      activeB: activeB.conceptId,
      retired: retired.conceptId,
      supersededObservation: first.observationId,
      currentObservation: current.observationId,
      activeBObservation: activeB.observationId,
      retiredObservation: retired.observationId,
      workstream: workstream!.id,
      // The embedded text is the OPEN items, in payload order (#131): the four record slots
      // that used to be joined in here no longer exist.
      workstreamText: "question step",
    };
  } finally {
    core.close();
  }
}

function stableRows(db: RawDb): {
  concepts: unknown[];
  observations: unknown[];
  tombstones: unknown[];
  revisions: unknown[];
} {
  return {
    concepts: db.prepare(`SELECT id, title, body, kind, status, version, dirty FROM concepts ORDER BY id`).all(),
    observations: db.prepare(`SELECT id, content, kind, concept_id, superseded_by, superseded_at, source_refs FROM observations ORDER BY id`).all(),
    tombstones: db.prepare(`SELECT * FROM concept_tombstones ORDER BY concept_id`).all(),
    revisions: db.prepare(`SELECT concept_id, version, body, trigger_observation_id, created_at FROM concept_revisions ORDER BY id`).all(),
  };
}

describe("MonetCore.migrateEmbeddings", () => {
  it("keeps every public mutation family observational during dry-run callbacks while committed receipts remain no-op successes", async () => {
    const target = new SpaceEmbedder("test:space:target", 2);
    const core = new MonetCore(":memory:", { embedder: target, tauAttach: 1.1, tauAmbiguous: 1.1 });
    const committed = await core.store("durable idempotent receipt", {
      resolution: "forceNew",
      operationId: "migration-reentry-receipt",
    });
    const blocked: string[] = [];
    let receiptRetry: Promise<unknown> | undefined;
    let freshStore: Promise<unknown> | undefined;
    let repairAttempt: Promise<unknown> | undefined;
    try {
      const report = await core.migrateEmbeddings({
        targetModelId: target.modelId,
        dryRun: true,
        onProgress(event) {
          if (event.phase !== "preflight") return;
          const mutations: Array<[string, () => unknown]> = [
            ["circle/archive", () => core.archiveCircle("default")],
            ["circle/unarchive", () => core.unarchiveCircle("default")],
            ["circle/rename", () => core.renameCircle("default", "other")],
            ["graph/dismiss", () => core.dismissPossibleDuplicate("missing-a", "missing-b")],
            ["graph/dedup", () => core.batchDedup([])],
            ["lifecycle/retire", () => core.retireConcept("missing")],
            ["pin/adopt", () => core.adoptEmbedderPin()],
          ];
          for (const [name, mutate] of mutations) {
            expect(mutate, name).toThrow(EmbedderMigrationReentryError);
            blocked.push(name);
          }
          repairAttempt = core.reembedConcept(committed.conceptId);
          void repairAttempt.catch(() => undefined);
          receiptRetry = core.store("ignored retry content", { operationId: "migration-reentry-receipt" });
          freshStore = core.store("must not queue a fresh write", { operationId: "migration-reentry-fresh" });
          void freshStore.catch(() => undefined);
        },
      });
      expect(report.failures).toEqual([]);
      expect(blocked).toHaveLength(7);
      await expect(receiptRetry).resolves.toMatchObject({
        conceptId: committed.conceptId,
        observationId: committed.observationId,
      });
      await expect(freshStore).rejects.toBeInstanceOf(EmbedderMigrationReentryError);
      await expect(repairAttempt).rejects.toBeInstanceOf(EmbedderRepairOwnershipError);
      expect((dbOf(core).prepare(`SELECT COUNT(*) AS n FROM ingest_operations`).get() as { n: number }).n).toBe(1);
    } finally {
      core.close();
    }
  });

  it("migrates the heterogeneous persisted-vector inventory and derives native graph strictly last", async () => {
    await withTempDb(async (dbPath) => {
      const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
      const fixture = await seedFixture(dbPath, oldEmbedder);
      const target = new SpaceEmbedder("test:space:target", 2);
      const core = new MonetCore(dbPath, { embedder: target, tauAttach: 1.1, tauAmbiguous: 1.1 });
      const db = dbOf(core);
      const stableBefore = stableRows(db);
      const oldConceptVectors = new Map(
        (db.prepare(`SELECT id, embedding FROM concepts ORDER BY id`).all() as Array<{ id: string; embedding: string }>).map(
          (row) => [row.id, row.embedding],
        ),
      );
      const execution: string[] = [];
      const methodNames = [
        "reembedConcept", "writePreparedNativeObservations", "reembedWorkstream",
      ] as const;
      for (const name of methodNames) {
        const original = (core as any)[name].bind(core);
        (core as any)[name] = async (...args: unknown[]) => {
          const result = await original(...args);
          execution.push(`vector:${name}`);
          return result;
        };
      }
      const originalGraph = (core as any).replaceNativeRelatedGraph.bind(core);
      (core as any).replaceNativeRelatedGraph = (...args: unknown[]) => {
        execution.push("graph:replace");
        return originalGraph(...args);
      };
      const progress: EmbeddingMigrationProgress[] = [];

      try {
        const report = await core.migrateEmbeddings({
          targetModelId: target.modelId,
          onProgress: (event) => progress.push(event),
        });

        expect(report.failures).toEqual([]);
        expect(report.phases).toMatchObject({
          "native-concepts": { total: 3, completed: 3, failed: 0 },
          "native-observations": { total: 4, completed: 4, failed: 0 },
          workstreams: { total: 1, completed: 1, failed: 0 },
          "native-graph": { total: 2, completed: 2, failed: 0 },
          complete: { total: 1, completed: 1, failed: 0 },
        });
        expect(migrationRow(db)).toBeUndefined();
        expect(pinRow(db)).toMatchObject({ embedder_model_id: target.modelId, embedder_pin_source: "migrated" });

        const conceptBodies = new Map(
          (db.prepare(`SELECT id, body FROM concepts ORDER BY id`).all() as Array<{ id: string; body: string }>).map((row) => [row.id, row.body]),
        );
        // ACTIVE concepts end on the centroid of their migrated evidence, not on `embed(body)`:
        // the body vector is only what `reembedConcept` could write before the observation phase ran.
        for (const id of [fixture.activeA, fixture.activeB]) {
          expect(vector(db, "concepts", id)).toEqual(liveCentroid(db, id));
          expect(vector(db, "concepts", id)).not.toEqual(expected(target, conceptBodies.get(id)!));
          expect(JSON.stringify(vector(db, "concepts", id))).not.toBe(oldConceptVectors.get(id));
        }
        // RETIRED keeps the body embedding — it is not centroid-maintained by any writer.
        expect(vector(db, "concepts", fixture.retired)).toEqual(expected(target, conceptBodies.get(fixture.retired)!));
        expect(JSON.stringify(vector(db, "concepts", fixture.retired))).not.toBe(oldConceptVectors.get(fixture.retired));
        expect(vector(db, "concepts", fixture.workstream)).toEqual(expected(target, fixture.workstreamText));
        expect(JSON.stringify(vector(db, "concepts", fixture.workstream))).not.toBe(oldConceptVectors.get(fixture.workstream));

        const observationContent = new Map(
          (db.prepare(`SELECT id, content FROM observations ORDER BY id`).all() as Array<{ id: string; content: string }>).map((row) => [row.id, row.content]),
        );
        for (const id of [
          fixture.supersededObservation,
          fixture.currentObservation,
          fixture.activeBObservation,
          fixture.retiredObservation,
        ]) {
          expect(vector(db, "observations", id)).toEqual(expected(target, observationContent.get(id)!));
        }
        expect(stableRows(db)).toEqual(stableBefore);

        const graphEvents = execution.map((event, index) => ({ event, index })).filter(({ event }) => event.startsWith("graph:"));
        const lastVectorIndex = execution.reduce((last, event, index) => event.startsWith("vector:") ? index : last, -1);
        expect(graphEvents).toHaveLength(1);
        expect(graphEvents.every(({ index }) => index > lastVectorIndex)).toBe(true);
        expect(graphEvents.map(({ event }) => event)).toEqual(["graph:replace"]);
        expect(db.prepare(`SELECT 1 FROM concept_entities WHERE concept_id = ? LIMIT 1`).get(fixture.activeA)).toBeTruthy();
        expect(db.prepare(`SELECT 1 FROM concept_entities WHERE concept_id = ? LIMIT 1`).get(fixture.retired)).toBeUndefined();

        const phaseOrder: EmbeddingMigrationPhase[] = [
          "preflight", "lock", "native-concepts", "native-observations",
          "workstreams", "native-graph", "complete",
        ];
        const observed = progress.map((event) => phaseOrder.indexOf(event.phase));
        expect(observed).toEqual([...observed].sort((a, b) => a - b));
      } finally {
        core.close();
      }
    });
  });

  /**
   * A MIGRATION MUST LEAVE THE CENTROID, NOT THE BODY EMBEDDING (Codex #95, P1).
   *
   * The native-concepts phase runs `reembedConcept`, which writes `embed(row.body)` — all it can do,
   * since it runs BEFORE the observation phase moves the evidence into the target space. Nothing
   * afterwards used to put the centroid back: the observation phase writes only
   * `observations.embedding`, `reembedWorkstream` touches workstreams alone, and neither the graph
   * phase nor completion writes a concept vector. So every migrated multi-observation concept was
   * left holding a body embedding, which `nominateByObservation` then reads as `centroidScore` and
   * the tauConfident bypass attaches above.
   *
   * THREE LIVE MEMBERS, deliberately: a mean is only distinguishable from its members when the
   * members disagree, and a one-observation concept would make `embed(body)` and the centroid
   * trivially close enough to prove nothing.
   */
  it("rebuilds an active concept's centroid from the MIGRATED evidence, not from its body text", async () => {
    await withTempDb(async (dbPath) => {
      const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
      let conceptId = "";
      {
        const core = new MonetCore(dbPath, { embedder: oldEmbedder, tauAttach: 1.1, tauAmbiguous: 1.1 });
        try {
          const first = await core.store("Rolling deploys drain each node before restart.", { resolution: "forceNew" });
          await core.store("Feature flags are evaluated once per request.", { attachTo: first.conceptId });
          await core.store("The ingest queue shards by tenant id and rebalances.", { attachTo: first.conceptId });
          conceptId = first.conceptId;
        } finally {
          core.close();
        }
      }

      const target = new SpaceEmbedder("test:space:target", 2);
      const core = new MonetCore(dbPath, { embedder: target, tauAttach: 1.1, tauAmbiguous: 1.1 });
      const db = dbOf(core);
      try {
        const oldVector = JSON.stringify(vector(db, "concepts", conceptId));
        const report = await core.migrateEmbeddings({ targetModelId: target.modelId });
        expect(report.failures).toEqual([]);

        const live = db.prepare(
          `SELECT id FROM observations WHERE concept_id = ? AND superseded_by IS NULL AND superseded_at IS NULL`,
        ).all(conceptId);
        expect(live).toHaveLength(3); // the fixture can exhibit a mean at all

        const body = (db.prepare(`SELECT body FROM concepts WHERE id = ?`).get(conceptId) as { body: string }).body;
        const stored = vector(db, "concepts", conceptId);

        // It IS the centroid of the migrated evidence...
        expect(stored).toEqual(liveCentroid(db, conceptId));
        // ...and it is NOT what `reembedConcept` left behind. Asserted so this cannot pass on a tree
        // where the recompute is missing.
        expect(stored).not.toEqual(expected(target, body));
        // Still moved out of the old space, which is the migration's own guarantee.
        expect(JSON.stringify(stored)).not.toBe(oldVector);
        // A centroid is unit-length; a raw SpaceEmbedder body vector is not — so the column is
        // holding the quantity it is supposed to hold, not merely a different one.
        const magnitude = Math.sqrt(stored.reduce((m, x) => m + x * x, 0));
        expect(magnitude).toBeCloseTo(1, 6);

        // Every member the centroid was built from is in the TARGET space (marker 2), so the
        // rebuild consumed migrated evidence rather than leftovers from the old one.
        for (const row of live as Array<{ id: string }>) {
          expect(vector(db, "observations", row.id)[0]).toBe(2);
        }
      } finally {
        core.close();
      }
    });
  });

  it("refreshes disputed related state while preserving every non-model graph byte and excluding retired graph state", async () => {
    await withTempDb(async (dbPath) => {
      const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
      const setup = new MonetCore(dbPath, { embedder: oldEmbedder, tauAttach: 1.1, tauAmbiguous: 1.1 });
      const a = await setup.store("AuthService and PostgreSQL share the billing path.", { resolution: "forceNew" });
      const b = await setup.store("AuthService and PostgreSQL protect invoice writes.", { resolution: "forceNew" });
      const retired = await setup.store("Retired graph state must not be refreshed.", { resolution: "forceNew" });
      setup.flagContradiction(a.conceptId, { detail: "keep this concept disputed during migration" });
      setup.retireConcept(retired.conceptId);
      const setupDb = dbOf(setup);
      (setup as any).upsertEdge(a.conceptId, b.conceptId, "follows", 0.37, "fixture", "default");
      (setup as any).upsertEdgeBoth(a.conceptId, b.conceptId, "possible_duplicate_of", 0.91, "fixture", "default");
      setup.dismissPossibleDuplicate(a.conceptId, b.conceptId, "migration-reviewer");
      (setup as any).upsertEdge(retired.conceptId, retired.conceptId, "follows", 0.19, "fixture", "default");
      setupDb.prepare(`DELETE FROM memory_edge_components WHERE type='related' AND (src_id=? OR dst_id=?)`).run(a.conceptId, a.conceptId);
      setupDb.prepare(`DELETE FROM memory_edge WHERE type='related' AND (src_id=? OR dst_id=?)`).run(a.conceptId, a.conceptId);
      (setup as any).upsertEdgeBoth(a.conceptId, b.conceptId, "related", 0.123, "stale-model", "default");
      const preservedSnapshot = (database: RawDb) => JSON.stringify({
        edges: database.prepare(`SELECT * FROM memory_edge WHERE type!='related' ORDER BY id`).all(),
        components: database.prepare(`SELECT * FROM memory_edge_components WHERE type!='related' ORDER BY src_id,dst_id,type,scope,writer_id`).all(),
        entities: database.prepare(`SELECT * FROM entities ORDER BY key,scope`).all(),
        memberships: database.prepare(`SELECT * FROM concept_entities ORDER BY concept_id,entity_key,scope`).all(),
      });
      const before = preservedSnapshot(setupDb);
      setup.close();

      const target = new SpaceEmbedder("test:space:target", 2);
      const core = new MonetCore(dbPath, { embedder: target, tauAttach: 1.1, tauAmbiguous: 1.1, edgeSimMin: 0 });
      const db = dbOf(core);
      const graphIds: string[] = [];
      try {
        const report = await core.migrateEmbeddings({
          targetModelId: target.modelId,
          onProgress: (event) => { if (event.phase === "native-graph" && event.currentId) graphIds.push(event.currentId); },
        });
        expect(report.phases["native-graph"]).toEqual({ total: 2, completed: 2, failed: 0 });
        expect(graphIds.sort()).toEqual([a.conceptId, b.conceptId].sort());
        expect(graphIds).not.toContain(retired.conceptId);
        expect((db.prepare(`SELECT status FROM concepts WHERE id=?`).get(a.conceptId) as { status: string }).status).toBe("disputed");
        expect(preservedSnapshot(db)).toBe(before);
        const refreshed = db.prepare(
          `SELECT weight,origin FROM memory_edge WHERE type='related' AND ((src_id=? AND dst_id=?) OR (src_id=? AND dst_id=?)) ORDER BY id`,
        ).all(a.conceptId, b.conceptId, b.conceptId, a.conceptId) as Array<{ weight: number; origin: string }>;
        // The target model may legitimately put the pair below its related threshold. Either way,
        // the stale model rows/components are gone and any surviving relation is target-derived.
        expect(refreshed).not.toContainEqual({ weight: 0.123, origin: "stale-model" });
        expect(db.prepare(`SELECT 1 FROM memory_edge_components WHERE type='related' AND origin='stale-model' LIMIT 1`).get()).toBeUndefined();
        const duplicateRows = db.prepare(
          `SELECT dismissed_by FROM memory_edge WHERE type='possible_duplicate_of' AND ((src_id=? AND dst_id=?) OR (src_id=? AND dst_id=?)) ORDER BY id`,
        ).all(a.conceptId, b.conceptId, b.conceptId, a.conceptId) as Array<{ dismissed_by: string | null }>;
        expect(duplicateRows).toEqual([{ dismissed_by: "migration-reviewer" }, { dismissed_by: "migration-reviewer" }]);
      } finally {
        core.close();
      }
    });
  });

  it("dry-run validates, locks, and inventories without changing durable state", async () => {
    await withTempDb(async (dbPath) => {
      const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
      await seedFixture(dbPath, oldEmbedder);
      const target = new SpaceEmbedder("test:space:target", 2);
      const core = new MonetCore(dbPath, { embedder: target });
      const db = dbOf(core);
      const beforePin = pinRow(db);
      const beforeConcepts = db.prepare(`SELECT id, embedding FROM concepts ORDER BY id`).all();
      const beforeObservations = db.prepare(`SELECT id, embedding FROM observations ORDER BY id`).all();
      try {
        const report = await core.migrateEmbeddings({ targetModelId: target.modelId, dryRun: true });
        expect(report.dryRun).toBe(true);
        expect(report.failures).toEqual([]);
        expect(report.phases).toMatchObject({
          "native-concepts": { total: 3, completed: 3, failed: 0 },
          "native-observations": { total: 4, completed: 4, failed: 0 },
          workstreams: { total: 1, completed: 1, failed: 0 },
          "native-graph": { total: 2, completed: 2, failed: 0 },
        });
        expect(migrationRow(db)).toBeUndefined();
        expect(pinRow(db)).toEqual(beforePin);
        expect(db.prepare(`SELECT id, embedding FROM concepts ORDER BY id`).all()).toEqual(beforeConcepts);
        expect(db.prepare(`SELECT id, embedding FROM observations ORDER BY id`).all()).toEqual(beforeObservations);

        const second = new Database(dbPath);
        try {
          expect(second.prepare(`UPDATE sync_meta SET last_mutation_at = last_mutation_at WHERE singleton = 1`).run().changes).toBe(1);
        } finally {
          second.close();
        }
      } finally {
        core.close();
      }
    });
  });

  it("blocks synchronous abandon from onProgress('lock') for the full in-process migration run", async () => {
    await withTempDb(async (dbPath) => {
      const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
      const fixture = await seedFixture(dbPath, oldEmbedder);
      const before = new Database(dbPath);
      const oldVector = JSON.parse((before.prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(fixture.activeA) as { embedding: string }).embedding);
      before.close();

      const target = new SpaceEmbedder("test:space:target", 2);
      const core = new MonetCore(dbPath, { embedder: target });
      let blocked = false;
      try {
        const report = await core.migrateEmbeddings({
          targetModelId: target.modelId,
          onProgress(event) {
            if (event.phase === "lock") {
              expect(() => core.abandonEmbedderMigration()).toThrow(/migrateEmbeddings\(\) is active/i);
              blocked = true;
            }
          },
        });
        expect(report.failures).toEqual([]);
        expect(blocked).toBe(true);
        expect(migrationRow(dbOf(core))).toBeUndefined();
        expect(pinRow(dbOf(core)).embedder_model_id).toBe(target.modelId);
        expect(vector(dbOf(core), "concepts", fixture.activeA)).not.toEqual(oldVector);
      } finally {
        core.close();
      }
    });
  });

  it("blocks a queued microtask abandon after onProgress('lock') until the outer migration completes", async () => {
    await withTempDb(async (dbPath) => {
      const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
      const fixture = await seedFixture(dbPath, oldEmbedder);
      const target = new SpaceEmbedder("test:space:target", 2);
      const core = new MonetCore(dbPath, { embedder: target });
      let abandonAttempt: Promise<void> | undefined;
      let abandonError: unknown;
      try {
        const report = await core.migrateEmbeddings({
          targetModelId: target.modelId,
          onProgress(event) {
            if (event.phase === "lock") {
              abandonAttempt = new Promise<void>((resolve) => {
                queueMicrotask(() => {
                  try { core.abandonEmbedderMigration(); } catch (error) { abandonError = error; }
                  resolve();
                });
              });
            }
          },
        });
        await abandonAttempt;
        expect(abandonError).toBeInstanceOf(Error);
        expect((abandonError as Error).message).toMatch(/migrateEmbeddings\(\) is active/i);
        expect(report.failures).toEqual([]);
        expect(migrationRow(dbOf(core))).toBeUndefined();
        expect(pinRow(dbOf(core)).embedder_model_id).toBe(target.modelId);
        // Landed in the target space: the concept now carries the centroid of its migrated evidence.
        // (The raw `[0] === 2` space marker no longer reads directly off a concept row — the centroid
        // is normalized — so this checks the same thing against the vector the column actually holds.)
        expect(vector(dbOf(core), "concepts", fixture.activeA)).toEqual(liveCentroid(dbOf(core), fixture.activeA));
        expect(vector(dbOf(core), "observations", fixture.currentObservation)[0]).toBe(2);
      } finally {
        core.close();
      }
    });
  });

  it("retains fail-closed recovery state after an item failure and converges on same-target retry", async () => {
    await withTempDb(async (dbPath) => {
      const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
      const fixture = await seedFixture(dbPath, oldEmbedder);
      const failing = new SpaceEmbedder("test:space:target", 2);
      failing.failures.add("second active concept");
      const first = new MonetCore(dbPath, { embedder: failing });
      let caught: unknown;
      try {
        try {
          await first.migrateEmbeddings({ targetModelId: failing.modelId });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(EmbedderMigrationFailedError);
        const failure = caught as EmbedderMigrationFailedError;
        expect(failure.report.failures).toEqual(expect.arrayContaining([
          expect.objectContaining({
            phase: "native-concepts",
            id: fixture.activeB,
            message: expect.stringContaining("injected embedding failure"),
          }),
        ]));
        expect(failure.report.phases["native-concepts"]).toEqual({ total: 3, completed: 3, failed: 1 });
        expect(failure.report.phases["native-graph"]).toEqual({ total: 2, completed: 0, failed: 0 });
        expect(migrationRow(dbOf(first))).toEqual({ target_model_id: failing.modelId });
        await expect(first.search("must stay closed")).rejects.toBeInstanceOf(EmbedderMigrationIncompleteError);
        await expect(first.ensureEmbedderPin()).rejects.toBeInstanceOf(EmbedderMigrationIncompleteError);
      } finally {
        first.close();
      }

      const fixed = new SpaceEmbedder("test:space:target", 2);
      const retry = new MonetCore(dbPath, { embedder: fixed });
      try {
        const report = await retry.migrateEmbeddings({ targetModelId: fixed.modelId });
        expect(report.failures).toEqual([]);
        expect(migrationRow(dbOf(retry))).toBeUndefined();
        await expect(retry.ensureEmbedderPin()).resolves.toBeUndefined();
        // Active: the centroid of its migrated evidence (one live observation, normalized).
        expect(vector(dbOf(retry), "concepts", fixture.activeB)).toEqual(liveCentroid(dbOf(retry), fixture.activeB));
        expect(vector(dbOf(retry), "concepts", fixture.retired)).toEqual(
          expected(fixed, "Retired native vector must still migrate."),
        );
      } finally {
        retry.close();
      }
    });
  });

  it("keeps related graph untouched on pregraph proof failure and keeps the sentinel on late final-proof corruption", async () => {
    await withTempDb(async (dbPath) => {
      const old = new SpaceEmbedder("test:proof:old", 1);
      const fixture = await seedFixture(dbPath, old);
      const target = new SpaceEmbedder("test:proof:target", 2);
      const core = new MonetCore(dbPath, { embedder: target, edgeSimMin: 0, tauAttach: 1.1 });
      const db = dbOf(core);
      const relatedSnapshot = () => JSON.stringify({
        edges: db.prepare(`SELECT * FROM memory_edge WHERE type='related' ORDER BY id`).all(),
        components: db.prepare(`SELECT * FROM memory_edge_components WHERE type='related' ORDER BY src_id,dst_id,writer_id`).all(),
      });
      const before = relatedSnapshot();
      const originalWorkstream = (core as any).reembedWorkstream.bind(core);
      (core as any).reembedWorkstream = async (...args: unknown[]) => {
        const result = await originalWorkstream(...args);
        db.prepare(`UPDATE observations SET embedding='[1]' WHERE id=?`).run(fixture.currentObservation);
        return result;
      };
      try {
        await expect(core.migrateEmbeddings({ targetModelId: target.modelId })).rejects.toBeInstanceOf(EmbedderMigrationFailedError);
        expect(relatedSnapshot()).toBe(before);
        expect(migrationRow(db)).toEqual({ target_model_id: target.modelId });
      } finally {
        core.close();
      }
    });

    await withTempDb(async (dbPath) => {
      const old = new SpaceEmbedder("test:proof-late:old", 1);
      const fixture = await seedFixture(dbPath, old);
      const target = new SpaceEmbedder("test:proof-late:target", 2);
      const core = new MonetCore(dbPath, { embedder: target, edgeSimMin: 0, tauAttach: 1.1 });
      const db = dbOf(core);
      const originalReplace = (core as any).replaceNativeRelatedGraph.bind(core);
      (core as any).replaceNativeRelatedGraph = (...args: unknown[]) => {
        const result = originalReplace(...args);
        db.prepare(`UPDATE observations SET embedding='[null]' WHERE id=?`).run(fixture.currentObservation);
        return result;
      };
      try {
        await expect(core.migrateEmbeddings({ targetModelId: target.modelId })).rejects.toBeInstanceOf(MalformedEmbeddingStoreError);
        expect(migrationRow(db)).toEqual({ target_model_id: target.modelId });
      } finally {
        core.close();
      }
    });
  });

  it("rejects non-finite output after a valid migration preflight without persisting JSON null", async () => {
    await withTempDb(async (dbPath) => {
      const old = new SpaceEmbedder("test:nonfinite:old", 1);
      const fixture = await seedFixture(dbPath, old);
      const target = new SpaceEmbedder("test:nonfinite:target", 2);
      target.nonfinite.add("first observation");
      const core = new MonetCore(dbPath, { embedder: target });
      try {
        const before = dbOf(core).prepare(`SELECT embedding FROM concepts WHERE id=?`).get(fixture.activeA) as { embedding: string };
        let caught: unknown;
        try { await core.migrateEmbeddings({ targetModelId: target.modelId }); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(EmbedderMigrationFailedError);
        expect((caught as EmbedderMigrationFailedError).report.failures.some(
          (failure) => failure.phase === "native-concepts" && failure.message.includes("non-finite component"),
        )).toBe(true);
        expect(dbOf(core).prepare(`SELECT embedding FROM concepts WHERE id=?`).get(fixture.activeA)).toEqual(before);
        expect(JSON.stringify(dbOf(core).prepare(`SELECT embedding FROM concepts`).all())).not.toContain("null");
      } finally {
        core.close();
      }
    });
  });

  for (const scenario of [
    { phase: "native-concepts", needle: "native-concept-wrong" },
    { phase: "native-observations", needle: "native-observation-wrong" },
    // The needle is the workstream's embedded text — open items only since the slot cut (#131).
    { phase: "workstreams", needle: "question step" },
  ] as const) {
    it(`validates every ${scenario.phase} provider result before its rewrite and resumes safely after correction`, async () => {
      await withTempDb(async (dbPath) => {
        const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
        const fixture = await seedFixture(dbPath, oldEmbedder);
        const setup = new MonetCore(dbPath, { embedder: oldEmbedder });
        const setupDb = dbOf(setup);
        setupDb.prepare(`UPDATE concepts SET body = ? WHERE id = ?`).run("native-concept-wrong", fixture.activeB);
        setupDb.prepare(`UPDATE observations SET content = ? WHERE id = ?`).run("native-observation-wrong", fixture.currentObservation);
        setup.close();

        const target = new SpaceEmbedder("test:space:target", 2);
        target.wrongWidths.add(scenario.needle);
        const core = new MonetCore(dbPath, { embedder: target });
        const db = dbOf(core);
        const batchIds = scenario.phase === "native-observations"
          ? [fixture.supersededObservation, fixture.currentObservation]
          : [];
        const batchBefore = batchIds.map((id) => ({ id, vector: vector(db, "observations", id) }));
        try {
          let failure: unknown;
          try {
            await core.migrateEmbeddings({ targetModelId: target.modelId });
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(EmbedderMigrationFailedError);
          const report = (failure as EmbedderMigrationFailedError).report;
          expect(report.failures.some((item) => item.phase === scenario.phase && /declared dimension/.test(item.message))).toBe(true);
          expect(migrationRow(db)?.target_model_id).toBe(target.modelId);
          for (const before of batchBefore) expect(vector(db, "observations", before.id)).toEqual(before.vector);

          target.wrongWidths.clear();
          const retry = await core.migrateEmbeddings({ targetModelId: target.modelId });
          expect(retry.failures).toEqual([]);
          expect(migrationRow(db)).toBeUndefined();
          expect(pinRow(db).embedder_model_id).toBe(target.modelId);
        } finally {
          core.close();
        }
      });
    });
  }
});
