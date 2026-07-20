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
      const methodNames = ["reembedConcept", "reembedConceptObservations", "reembedSourceConcept", "reembedWorkstream"] as const;
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
          "preflight", "lock", "native-concepts", "native-observations", "source-concepts", "workstreams", "native-graph", "complete",
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
});
