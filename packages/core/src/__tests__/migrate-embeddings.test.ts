import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  EmbedderMigrationFailedError,
  EmbedderMigrationIncompleteError,
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

  constructor(
    readonly modelId: string,
    private readonly space: number,
  ) {}

  embed(text: string): Float32Array {
    this.calls.push(text);
    if ([...this.failures].some((needle) => text.includes(needle))) {
      throw new Error(`injected embedding failure for ${text}`);
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
      openQuestions: ["question"],
      nextSteps: ["step"],
      decisions: ["decision"],
      confirmedContext: ["context"],
      discardedAlternatives: ["must not be embedded"],
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
      workstream: workstream.id,
      workstreamText: "question step decision context",
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
        "reembedConcept", "reembedConceptObservations", "reembedSourceConcept", "reembedSourceChunkObservations", "reembedWorkstream",
      ] as const;
      for (const name of methodNames) {
        const original = (core as any)[name].bind(core);
        (core as any)[name] = async (id: string) => {
          const result = await original(id);
          execution.push(`vector:${name}:${id}`);
          return result;
        };
      }
      const originalGraph = (core as any).rederiveNativeConceptGraph.bind(core);
      (core as any).rederiveNativeConceptGraph = (id: string) => {
        execution.push(`graph:${id}`);
        return originalGraph(id);
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
          "native-observations": { total: 3, completed: 3, failed: 0 },
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
        // Unchanged by migration — NOT because chunk observations are exempt (they aren't: see
        // reembedSourceChunkObservations), but because this specific observation has no
        // source_chunks row at all (seedFixture bypasses the ledger pipeline), so it is invisible
        // to that phase's active-chunk query, exactly like it would be invisible to
        // scoreSourceConcepts' own read at retrieval time.
        expect(vector(db, "observations", fixture.sourceObservation)).toEqual(placeholderBefore);
        expect(stableRows(db)).toEqual(stableBefore);

        const graphEvents = execution.map((event, index) => ({ event, index })).filter(({ event }) => event.startsWith("graph:"));
        const lastVectorIndex = execution.reduce((last, event, index) => event.startsWith("vector:") ? index : last, -1);
        expect(graphEvents).toHaveLength(2);
        expect(graphEvents.every(({ index }) => index > lastVectorIndex)).toBe(true);
        expect(graphEvents.map(({ event }) => event)).toEqual([
          `graph:${fixture.activeA}`,
          `graph:${fixture.activeB}`,
        ].sort());
        expect(execution).not.toContain(`graph:${fixture.retired}`);
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
          "native-observations": { total: 3, completed: 3, failed: 0 },
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

  it("retains fail-closed recovery state after an item failure and converges on same-target retry", async () => {
    await withTempDb(async (dbPath) => {
      const oldEmbedder = new SpaceEmbedder("test:space:old", 1);
      const fixture = await seedFixture(dbPath, oldEmbedder);
      const failing = new SpaceEmbedder("test:space:target", 2);
      failing.failures.add("second active concept");
      const first = new MonetCore(dbPath, { embedder: failing });
      const graphIds: string[] = [];
      const originalGraph = (first as any).rederiveNativeConceptGraph.bind(first);
      (first as any).rederiveNativeConceptGraph = (id: string) => {
        graphIds.push(id);
        return originalGraph(id);
      };
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
        expect(failure.report.phases["native-graph"]).toEqual({ total: 1, completed: 1, failed: 0 });
        expect(graphIds).toEqual([fixture.activeA]);
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
});
