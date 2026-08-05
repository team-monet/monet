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
import { computeSourceContentHash, computeSourceIngestFingerprint, computeSourceOperationId, sourceHeadingAnchor } from "../source-chunker";
import { computeSourceManifestHash } from "../source-scanner";
import type { SourceSyncRun, StageSourceManifestInput } from "../source-types";

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
  source: string;
  sourceObservation: string;
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

interface Section { headingPath: string[]; content: string }

/** Lean hand-driven ledger publish (mirrors source-chunk-retrieval.test.ts's own helpers) — a
 *  REAL source_chunks-backed publication with `sections.length` active chunks under one concept,
 *  for the "migrates a real ledger-published source concept's chunk observations" test below.
 *  seedFixture's own source concept deliberately bypasses this (see its comment) to keep the
 *  MAIN heterogeneous-inventory test's fixture minimal; this is the dedicated real-chunk coverage
 *  the reviewer asked for. */
async function publishSourceWithChunks(core: MonetCore, sourceId: string, sections: Section[]): Promise<{ conceptId: string; observationIds: string[] }> {
  core.createSource({
    id: sourceId, type: "repo-md", name: sourceId, localPath: `/tmp/${sourceId}`, circle: sourceId,
    access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] }, writeBack: "none",
  });
  const begun = core.beginSourceRun({ sourceId, snapshotId: `snapshot-${sourceId}` });
  if (begun.kind !== "started") throw new Error("expected a new run");
  const run: SourceSyncRun = begun.run;
  const relativePath = "NOTES.md";
  const chunks = sections.map((section, i) => {
    const contentHash = computeSourceContentHash(Buffer.from(section.content, "utf8"));
    const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
    const ingestFingerprint = computeSourceIngestFingerprint({
      contentHash, headingPath: section.headingPath, metadata, ingestConfigHash: run.ingestConfigHash,
    });
    const bindingId = `binding-${i + 1}`;
    return {
      bindingId, bindingGeneration: 1,
      operationId: computeSourceOperationId(run.sourceId, bindingId, ingestFingerprint, run.snapshotId, 1),
      relativePath, headingPath: section.headingPath, occurrence: 1, segmentIndex: 1, documentSequence: i + 1,
      contentHash, ingestFingerprint, metadata,
      sourceRef: `source://${run.sourceId}/${relativePath}#${sourceHeadingAnchor(section.headingPath)}~1`,
      content: section.content,
    };
  });
  const totalBytes = sections.reduce((n, s) => n + Buffer.byteLength(s.content, "utf8"), 0);
  const files = [{ relativePath, type: "file" as const, contentHash: "file-hash", byteLength: totalBytes, title: relativePath }];
  const manifest: StageSourceManifestInput = { runId: run.id, scanStatus: "complete", manifestHash: computeSourceManifestHash(files), files, chunks };
  core.stageSourceManifest(manifest);
  let attachTo: string | undefined;
  let conceptId = "";
  const observationIds: string[] = [];
  for (const chunk of chunks) {
    const stored = await core.storeSource(chunk.content, {
      circle: sourceId, sourceRefs: [chunk.sourceRef], operationId: chunk.operationId,
      ...(attachTo ? { attachTo } : { resolution: "forceNew" as const }),
    });
    conceptId = stored.conceptId;
    attachTo = stored.conceptId;
    observationIds.push(stored.observationId);
    core.recordSourceBindingReceipt({
      runId: run.id, bindingId: chunk.bindingId, conceptId: stored.conceptId,
      observationId: stored.observationId, predecessorObservationId: null, writeState: "committed",
    });
  }
  core.publishSourceRun({ runId: run.id, activationToken: core.beginSourceActivation(run.id), expectedManifestHash: manifest.manifestHash });
  await core.recomputeSourceConceptBody(conceptId);
  return { conceptId, observationIds };
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

    const source = await core.storeSource("source observation placeholder", {
      sourceRefs: ["source://migration/docs/guide.md#intro~1"],
      operationId: "migration-source-operation",
    });
    const sourceBody = "Persisted source body, independent of the filesystem.";
    dbOf(core).prepare(`UPDATE concepts SET body = ?, embedding = ? WHERE id = ?`).run(
      sourceBody,
      JSON.stringify(Array.from(oldEmbedder.embed(sourceBody))),
      source.conceptId,
    );

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
      source: source.conceptId,
      sourceObservation: source.observationId,
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
    concepts: db.prepare(`SELECT id, title, body, kind, status, version, dirty, source_identity, active_observation_id FROM concepts ORDER BY id`).all(),
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
            ["source/create", () => core.createSource({} as never)],
            ["source/run", () => core.beginSourceRun({} as never)],
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
      expect(blocked).toHaveLength(9);
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
      const placeholderBefore = vector(db, "observations", fixture.sourceObservation);
      const oldConceptVectors = new Map(
        (db.prepare(`SELECT id, embedding FROM concepts ORDER BY id`).all() as Array<{ id: string; embedding: string }>).map(
          (row) => [row.id, row.embedding],
        ),
      );
      const execution: string[] = [];
      const methodNames = [
        "reembedConcept", "writePreparedNativeObservations", "reembedSourceConcept", "writePreparedSourceObservations", "reembedWorkstream",
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
          "source-concepts": { total: 1, completed: 1, failed: 0 },
          // seedFixture's source concept is created via a direct storeSource call, bypassing the
          // ledger's staging/publish pipeline entirely — it has no source_chunks row at all, so
          // reembedSourceChunkObservations (scoped to source_chunks.lifecycle='active', matching
          // scoreSourceConcepts' own read) correctly finds nothing to migrate for it. "1" here
          // means the phase RAN for this one source concept id, not that it found any chunks —
          // see the dedicated "migrates a real ledger-published source concept's chunk
          // observations" test below for actual chunk-rewrite coverage.
          "source-chunk-observations": { total: 1, completed: 1, failed: 0 },
          workstreams: { total: 1, completed: 1, failed: 0 },
          "native-graph": { total: 2, completed: 2, failed: 0 },
          complete: { total: 1, completed: 1, failed: 0 },
        });
        expect(migrationRow(db)).toBeUndefined();
        expect(pinRow(db)).toMatchObject({ embedder_model_id: target.modelId, embedder_pin_source: "migrated" });

        const conceptBodies = new Map(
          (db.prepare(`SELECT id, body FROM concepts ORDER BY id`).all() as Array<{ id: string; body: string }>).map((row) => [row.id, row.body]),
        );
        for (const id of [fixture.activeA, fixture.activeB, fixture.retired, fixture.source]) {
          expect(vector(db, "concepts", id)).toEqual(expected(target, conceptBodies.get(id)!));
          expect(JSON.stringify(vector(db, "concepts", id))).not.toBe(oldConceptVectors.get(id));
        }
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
        // Untracked source observations remain live by conservative inventory policy and migrate.
        expect(vector(db, "observations", fixture.sourceObservation)).toEqual(
          expected(target, "source observation placeholder"),
        );
        expect(vector(db, "observations", fixture.sourceObservation)).not.toEqual(placeholderBefore);
        expect(stableRows(db)).toEqual(stableBefore);

        const graphEvents = execution.map((event, index) => ({ event, index })).filter(({ event }) => event.startsWith("graph:"));
        const lastVectorIndex = execution.reduce((last, event, index) => event.startsWith("vector:") ? index : last, -1);
        expect(graphEvents).toHaveLength(1);
        expect(graphEvents.every(({ index }) => index > lastVectorIndex)).toBe(true);
        expect(graphEvents.map(({ event }) => event)).toEqual(["graph:replace"]);
        expect(db.prepare(`SELECT 1 FROM concept_entities WHERE concept_id = ? LIMIT 1`).get(fixture.activeA)).toBeTruthy();
        expect(db.prepare(`SELECT 1 FROM concept_entities WHERE concept_id = ? LIMIT 1`).get(fixture.retired)).toBeUndefined();

        const phaseOrder: EmbeddingMigrationPhase[] = [
          "preflight", "lock", "native-concepts", "native-observations", "source-concepts", "source-chunk-observations",
          "workstreams", "native-graph", "complete",
        ];
        const observed = progress.map((event) => phaseOrder.indexOf(event.phase));
        expect(observed).toEqual([...observed].sort((a, b) => a - b));
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
          "source-concepts": { total: 1, completed: 1, failed: 0 },
          "source-chunk-observations": { total: 1, completed: 1, failed: 0 },
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
        expect(vector(dbOf(core), "concepts", fixture.activeA)[0]).toBe(2);
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
        expect(vector(dbOf(retry), "concepts", fixture.activeB)).toEqual(
          expected(fixed, "AuthService has a second active concept."),
        );
        expect(vector(dbOf(retry), "concepts", fixture.retired)).toEqual(
          expected(fixed, "Retired native vector must still migrate."),
        );
      } finally {
        retry.close();
      }
    });
  });

  it("migrates a real ledger-published source concept's ACTIVE chunk observations, including one that's still an old-build zero placeholder (reviewer finding 4)", async () => {
    await withTempDb(async (dbPath) => {
      const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
      const core0 = new MonetCore(dbPath, { embedder: oldEmbedder });
      const { observationIds } = await publishSourceWithChunks(core0, "migration-chunks-source", [
        { headingPath: ["Database"], content: "We chose PostgreSQL for the billing service database." },
        { headingPath: ["Caching"], content: "Redis backs the session cache for notify-service." },
      ]);
      const [databaseObservationId, cachingObservationId] = observationIds;
      // Simulate the Caching chunk predating chunk-granular source retrieval entirely (an
      // old-build zero placeholder that was never re-synced) — migration should still give it a
      // real TARGET-space vector, not skip it because it's already zero.
      const db0 = dbOf(core0);
      db0.prepare(`UPDATE observations SET embedding = ? WHERE id = ?`).run(JSON.stringify(new Array(oldEmbedder.dim).fill(0)), cachingObservationId);
      core0.close();

      const target = new SpaceEmbedder("test:space:target", 2);
      const core = new MonetCore(dbPath, { embedder: target });
      const db = dbOf(core);
      try {
        const report = await core.migrateEmbeddings({ targetModelId: target.modelId });
        expect(report.failures).toEqual([]);
        expect(report.phases["source-chunk-observations"]).toMatchObject({ failed: 0 });

        // The Database chunk (already real, old-embedder-space) is rewritten to the target space.
        expect(vector(db, "observations", databaseObservationId)).toEqual(
          expected(target, "We chose PostgreSQL for the billing service database."),
        );
        // The Caching chunk — ACTIVE, but seeded as an old-build zero placeholder — ALSO gets a
        // real target-space vector: migration doesn't special-case "already zero" as "nothing to
        // migrate here."
        const cachingAfter = vector(db, "observations", cachingObservationId);
        expect(cachingAfter.every((component) => component === 0)).toBe(false);
        expect(cachingAfter).toEqual(expected(target, "Redis backs the session cache for notify-service."));
      } finally {
        core.close();
      }
    });
  });

  it("leaves a superseded chunk observation untouched by migration, migrating only its active successor (reviewer finding 4)", async () => {
    await withTempDb(async (dbPath) => {
      const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
      const core0 = new MonetCore(dbPath, { embedder: oldEmbedder });
      const { conceptId, observationIds } = await publishSourceWithChunks(core0, "migration-supersede-source", [
        { headingPath: ["Database"], content: "We chose PostgreSQL for the billing service database." },
      ]);
      const [predecessorObservationId] = observationIds;

      // A second run that edits the SAME (only) section — supersedes the predecessor observation.
      const replacement = core0.beginSourceRun({ sourceId: "migration-supersede-source", snapshotId: "snapshot-migration-supersede-source-2" });
      if (replacement.kind !== "started") throw new Error("expected replacement run");
      const editedContent = "We chose PostgreSQL for the billing service database, now with read replicas.";
      const editedContentHash = computeSourceContentHash(Buffer.from(editedContent, "utf8"));
      const editedMetadata = { tags: [] as string[], scope: null, frontmatter: {} };
      const editedFingerprint = computeSourceIngestFingerprint({
        contentHash: editedContentHash, headingPath: ["Database"], metadata: editedMetadata, ingestConfigHash: replacement.run.ingestConfigHash,
      });
      const editedFiles = [{ relativePath: "NOTES.md", type: "file" as const, contentHash: "file-hash", byteLength: Buffer.byteLength(editedContent), title: "NOTES.md" }];
      const editedManifest: StageSourceManifestInput = {
        runId: replacement.run.id, scanStatus: "complete", manifestHash: computeSourceManifestHash(editedFiles), files: editedFiles,
        chunks: [{
          bindingId: "binding-1", bindingGeneration: 2,
          operationId: computeSourceOperationId("migration-supersede-source", "binding-1", editedFingerprint, replacement.run.snapshotId, 2),
          relativePath: "NOTES.md", headingPath: ["Database"], occurrence: 1, segmentIndex: 1, documentSequence: 1,
          contentHash: editedContentHash, ingestFingerprint: editedFingerprint, metadata: editedMetadata,
          sourceRef: "source://migration-supersede-source/NOTES.md#database~1", content: editedContent,
        }],
      };
      core0.stageSourceManifest(editedManifest);
      const successor = await core0.storeSource(editedContent, {
        circle: "migration-supersede-source", sourceRefs: [editedManifest.chunks[0].sourceRef],
        operationId: editedManifest.chunks[0].operationId, attachTo: conceptId,
      });
      core0.recordSourceBindingReceipt({
        runId: replacement.run.id, bindingId: "binding-1", conceptId: successor.conceptId,
        observationId: successor.observationId, predecessorObservationId, writeState: "engine-written",
      });
      await core0.supersedeSourceChunkObservation(successor.conceptId, successor.observationId, predecessorObservationId);
      core0.recordSourceBindingReceipt({ runId: replacement.run.id, bindingId: "binding-1", writeState: "committed" });
      core0.publishSourceRun({
        runId: replacement.run.id, activationToken: core0.beginSourceActivation(replacement.run.id), expectedManifestHash: editedManifest.manifestHash,
      });
      await core0.recomputeSourceConceptBody(successor.conceptId);
      const db0 = dbOf(core0);
      const predecessorBeforeMigration = vector(db0, "observations", predecessorObservationId);
      core0.close();

      const target = new SpaceEmbedder("test:space:target", 2);
      const core = new MonetCore(dbPath, { embedder: target });
      const db = dbOf(core);
      try {
        const report = await core.migrateEmbeddings({ targetModelId: target.modelId });
        expect(report.failures).toEqual([]);

        // The now-superseded predecessor is untouched — reembedSourceChunkObservations is scoped
        // to source_chunks.lifecycle='active' only, and the predecessor's row flipped to
        // 'superseded' the moment the second run published.
        expect(vector(db, "observations", predecessorObservationId)).toEqual(predecessorBeforeMigration);
        // The successor (currently ACTIVE) gets a real target-space vector of its OWN content.
        expect(vector(db, "observations", successor.observationId)).toEqual(expected(target, editedContent));
      } finally {
        core.close();
      }
    });
  });

  it("covers orphan native, untracked source, and active missing-concept source observations while excluding dead source residue", async () => {
    await withTempDb(async (dbPath) => {
      const old = new SpaceEmbedder("test:coverage:old", 1);
      const setup = new MonetCore(dbPath, { embedder: old });
      const db0 = dbOf(setup);
      const insertObservation = (id: string, content: string, kind: string) => db0.prepare(
        `INSERT INTO observations (id, content, embedding, author_agent_id, kind, concept_id) VALUES (?, ?, ?, 'fixture', ?, NULL)`,
      ).run(id, content, JSON.stringify(Array.from(old.embed(content))), kind);
      insertObservation("orphan-native", "orphan native coverage", "statement");
      insertObservation("untracked-source", "untracked source coverage", "source");
      insertObservation("missing-concept-source", "missing concept source coverage", "source");
      insertObservation("dead-source", "dead source residue", "source");
      const insertChunk = (id: string, observationId: string, lifecycle: string, conceptId: string | null) => db0.prepare(
        `INSERT INTO source_chunks (
           source_id, run_id, snapshot_id, config_version, binding_id, binding_generation, operation_id,
           relative_path, heading_path_json, occurrence, segment_index, document_sequence, content_hash,
           ingest_fingerprint, metadata_json, source_ref, content, concept_id, observation_id,
           predecessor_observation_id, write_state, lifecycle
         ) VALUES ('fixture-source', ?, 'snapshot', 1, ?, 1, ?, 'a.md', '[]', 1, 1, 1,
                   'hash', 'fingerprint', '{}', 'source://fixture', 'content', ?, ?, NULL, 'committed', ?)`,
      ).run(id, id, `op-${id}`, conceptId, observationId, lifecycle);
      insertChunk("missing-active", "missing-concept-source", "active", "missing-concept");
      insertChunk("dead", "dead-source", "superseded", "missing-concept");
      const deadBefore = vector(db0, "observations", "dead-source");
      setup.close();

      const target = new SpaceEmbedder("test:coverage:target", 2);
      const core = new MonetCore(dbPath, { embedder: target });
      try {
        const report = await core.migrateEmbeddings({ targetModelId: target.modelId });
        expect(report.phases["native-observations"].total).toBe(1);
        expect(report.phases["source-chunk-observations"].total).toBe(2);
        expect(vector(dbOf(core), "observations", "orphan-native")).toEqual(expected(target, "orphan native coverage"));
        expect(vector(dbOf(core), "observations", "untracked-source")).toEqual(expected(target, "untracked source coverage"));
        expect(vector(dbOf(core), "observations", "missing-concept-source")).toEqual(expected(target, "missing concept source coverage"));
        expect(vector(dbOf(core), "observations", "dead-source")).toEqual(deadBefore);
      } finally {
        core.close();
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
    { phase: "source-concepts", needle: "Persisted source body" },
    { phase: "source-chunk-observations", needle: "source-chunk-wrong" },
    // The needle is the workstream's embedded text — open items only since the slot cut (#131).
    { phase: "workstreams", needle: "question step" },
  ] as const) {
    it(`validates every ${scenario.phase} provider result before its rewrite and resumes safely after correction`, async () => {
      await withTempDb(async (dbPath) => {
        const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
        const fixture = await seedFixture(dbPath, oldEmbedder);
        const setup = new MonetCore(dbPath, { embedder: oldEmbedder });
        const published = await publishSourceWithChunks(setup, `wrong-${scenario.phase}`, [
          { headingPath: ["One"], content: "source-chunk-wrong" },
          { headingPath: ["Two"], content: "source-chunk-good" },
        ]);
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
          : scenario.phase === "source-chunk-observations" ? published.observationIds : [];
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
