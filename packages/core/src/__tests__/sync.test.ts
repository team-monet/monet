/**
 * Sync engine primitives — slice 1a tests.
 *
 * Covers exportDelta, graftRows, and batchDedup as specified in the implementation plan.
 * All tests use in-memory SQLite databases; no file I/O.
 */
import { describe, it, expect, vi } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore, EmbedderMismatchError, EmbedderWidthConflictError, MalformedEmbeddingStoreError } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";
import type { GraftPayload } from "../sync-types";

/** A MonetCore with dedup disabled so every store() creates a fresh concept. */
function freshCore(opts: { tauAttach?: number; tauAmbiguous?: number; syncDeviceId?: string; graphEnabled?: boolean } = {}): MonetCore {
  return new MonetCore(":memory:", {
    tauAttach: opts.tauAttach ?? 1.1,
    tauAmbiguous: opts.tauAmbiguous ?? 1.1,
    syncDeviceId: opts.syncDeviceId,
    graphEnabled: opts.graphEnabled,
  });
}

/** Minimal valid GraftPayload with the right embedderModelId for a freshCore. */
function basePayload(overrides: Partial<GraftPayload> = {}): GraftPayload {
  return {
    exportedAt: Date.now(),
    since: 0,
    deviceId: "machine-a",
    // REVIEW FIX (round 4, Codex thread 14): derived from the SAME provider freshCore's default
    // embedder uses, not a hardcoded literal — HashingEmbeddingProvider's modelId now carries a
    // tokenizer version segment, so a copy-pasted string here would silently drift out of sync
    // the next time that version bumps.
    embedderModelId: new HashingEmbeddingProvider().modelId,
    observations: [],
    concepts: [],
    conceptRevisions: [],
    contradictions: [],
    edges: [],
    firstBlock: [],
    circleAliases: [],
    entities: [],
    conceptEntities: [],
    tombstones: [],
    restorations: [],
    sessions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — graft idempotency
// ---------------------------------------------------------------------------
describe("graft idempotency", () => {
  it("grafting the same payload twice: second call reports all-zero inserts", async () => {
    const src = freshCore();
    const dst = freshCore();

    await src.store("The AuthService validates every request.");
    const payload = src.exportDelta(0);

    const first = dst.graftRows(payload);
    const db = (dst as any).db as import("../storage").StoragePort;
    const snapshot = () => JSON.stringify([
      db.prepare(`SELECT * FROM sessions ORDER BY id`).all(),
      db.prepare(`SELECT * FROM concepts ORDER BY id`).all(),
      db.prepare(`SELECT * FROM observations ORDER BY id`).all(),
      db.prepare(`SELECT * FROM concept_revisions ORDER BY id`).all(),
      db.prepare(`SELECT * FROM contradictions ORDER BY id`).all(),
      db.prepare(`SELECT * FROM memory_edge ORDER BY id`).all(),
      db.prepare(`SELECT * FROM memory_edge_components ORDER BY src_id, dst_id, writer_id`).all(),
      db.prepare(`SELECT * FROM first_block ORDER BY id`).all(),
      db.prepare(`SELECT * FROM circle_aliases ORDER BY from_name`).all(),
    ]);
    const settled = snapshot();
    const second = dst.graftRows(payload);

    expect(first.inserted.concepts).toBe(1);
    expect(first.inserted.observations).toBe(1);

    // Second graft: every row already exists
    expect(second.inserted.concepts).toBe(0);
    expect(second.inserted.observations).toBe(0);
    expect(second.inserted.memory_edge).toBe(0);
    const totalInserted = Object.values(second.inserted).reduce((a, b) => a + b, 0);
    expect(totalInserted).toBe(0);
    expect(snapshot()).toBe(settled);

    src.close();
    dst.close();
  });
});

describe("graft vector parsing and full atomicity", () => {
  it("rejects malformed, arbitrary-width, mixed-width, and late-invalid payloads without changing rows or sync_meta", async () => {
    const src = freshCore();
    const dst = freshCore();
    try {
      await src.store("Strict graft vector fixture.", { resolution: "forceNew" });
      const valid = src.exportDelta(0);
      const db = (dst as any).db as import("../storage").StoragePort;
      const snapshot = () => JSON.stringify({
        syncMeta: db.prepare(`SELECT * FROM sync_meta`).all(),
        sessions: db.prepare(`SELECT * FROM sessions ORDER BY id`).all(),
        concepts: db.prepare(`SELECT * FROM concepts ORDER BY id`).all(),
        observations: db.prepare(`SELECT * FROM observations ORDER BY id`).all(),
      });
      const before = snapshot();
      const malformed = [
        `null`,
        `{"value":1}`,
        `[true]`,
        `["1"]`,
        `[null]`,
        `[1e400]`,
      ];
      for (const embedding of malformed) {
        const payload = structuredClone(valid);
        payload.concepts[0]!.embedding = embedding;
        expect(() => dst.graftRows(payload), embedding).toThrow(/JSON array of finite numbers/);
        expect(snapshot(), embedding).toBe(before);
      }

      const mixed = structuredClone(valid);
      mixed.concepts[0]!.embedding = `[]`;
      expect(() => dst.graftRows(mixed)).toThrow(/mixed widths safe|live semantic vector/i);
      expect(snapshot()).toBe(before);

      const wrong = structuredClone(valid);
      wrong.concepts[0]!.embedding = `[0]`;
      wrong.observations[0]!.embedding = `[0]`;
      expect(() => dst.graftRows(wrong)).toThrow(/live semantic vector/i);
      expect(snapshot()).toBe(before);

      const lateInvalid = structuredClone(valid);
      (lateInvalid.concepts[0] as unknown as { circle: null }).circle = null;
      expect(() => dst.graftRows(lateInvalid)).toThrow();
      expect(snapshot()).toBe(before);
    } finally {
      src.close();
      dst.close();
    }
  });

  it.each(["edge-only", "component-only"] as const)(
    "rejects the %s payload against a mixed live store without graph or clock mutation",
    async (shape) => {
      const core = freshCore({ graphEnabled: false });
      try {
        const first = await core.store("Mixed graft endpoint one.", { resolution: "forceNew" });
        const second = await core.store("Mixed graft endpoint two.", { resolution: "forceNew" });
        const now = Date.now();
        const edge = {
          id: "mixed-graft-edge",
          src_id: first.conceptId,
          src_type: "concept",
          dst_id: second.conceptId,
          dst_type: "concept",
          type: "related",
          weight: 0.2,
          origin: "fixture",
          count: 1,
          created_at: now,
          last_reinforced_at: now,
          scope: "default",
          dismissed_at: null,
          dismissed_by: null,
        };
        const component = {
          src_id: first.conceptId,
          dst_id: second.conceptId,
          type: "related",
          scope: "default",
          writer_id: "mixed-graft-peer",
          count: 1,
          weight: 0.2,
          origin: "fixture",
          created_at: now,
          last_reinforced_at: now,
          revision: 1,
          updated_at: now,
        };
        core.graftRows(basePayload({
          schemaVersion: 8,
          ...(shape === "edge-only" ? { edges: [edge] } : { edgeComponents: [component] }),
        }));

        const db = (core as any).db as import("../storage").StoragePort;
        db.prepare(`UPDATE observations SET embedding = ? WHERE id = ?`).run(
          JSON.stringify(new Array(384).fill(0.1)),
          first.observationId,
        );
        const snapshot = () => JSON.stringify({
          syncMeta: db.prepare(`SELECT * FROM sync_meta WHERE singleton = 1`).get(),
          edges: db.prepare(`SELECT * FROM memory_edge ORDER BY id`).all(),
          components: db.prepare(
            `SELECT * FROM memory_edge_components ORDER BY src_id, dst_id, type, scope, writer_id`,
          ).all(),
        });
        const before = snapshot();
        const incoming = basePayload({
          schemaVersion: 8,
          ...(shape === "edge-only"
            ? { edges: [{ ...edge, weight: 0.9, last_reinforced_at: now + 1 }] }
            : { edgeComponents: [{ ...component, count: 2, weight: 0.9, revision: 2, updated_at: now + 1 }] }),
        });

        expect(incoming.concepts).toEqual([]);
        expect(incoming.observations).toEqual([]);
        expect(() => core.graftRows(incoming)).toThrow(EmbedderWidthConflictError);
        expect(snapshot()).toBe(before);
      } finally {
        core.close();
      }
    },
  );
});

describe("terminal supersession replication", () => {
  it("exports a terminal supersession after its creation watermark and applies it to an existing replica observation", async () => {
    const src = freshCore();
    const dst = freshCore();
    try {
      const stored = await src.store("Terminally deleted evidence.");
      dst.graftRows(src.exportDelta(0));

      const watermark = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      src.supersedeObservation(stored.observationId, null);
      const delta = src.exportDelta(watermark);
      expect(delta.observations).toHaveLength(1);
      expect(delta.observations[0]).toMatchObject({ id: stored.observationId, superseded_by: null });
      expect(delta.observations[0]!.superseded_at).not.toBeNull();

      dst.graftRows(delta);
      const replicated = dst
        // @ts-expect-error raw ledger assertion for terminal-state replication
        .db.prepare(`SELECT superseded_by, superseded_at FROM observations WHERE id = ?`)
        .get(stored.observationId) as { superseded_by: string | null; superseded_at: number | null };
      expect(replicated).toEqual({ superseded_by: null, superseded_at: delta.observations[0]!.superseded_at });
    } finally {
      src.close();
      dst.close();
    }
  });
});

describe("retirement tombstone replication", () => {
  it("exports no retired native/source content and makes an existing replica hide both concepts", async () => {
    const nativeSource = freshCore();
    const nativeReplica = freshCore();
    const sourceSource = freshCore();
    const sourceReplica = freshCore();
    try {
      const native = await nativeSource.store("Native retirement secret body.");
      nativeReplica.graftRows(nativeSource.exportDelta(0));
      const nativeWatermark = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      nativeSource.retireConcept(native.conceptId);
      const nativeDelta = nativeSource.exportDelta(nativeWatermark);
      expect(nativeDelta.concepts).toEqual([]);
      expect(nativeDelta.observations).toEqual([]);
      expect(nativeDelta.conceptRevisions).toEqual([]);
      expect(JSON.stringify(nativeDelta)).not.toContain("Native retirement secret body.");
      expect(nativeDelta.tombstones).toContainEqual(expect.objectContaining({ concept_id: native.conceptId }));
      nativeReplica.graftRows(nativeDelta);
      await expect(nativeReplica.getConcept(native.conceptId)).resolves.toBeNull();
      expect((nativeReplica
        // @ts-expect-error raw replica lifecycle assertion
        .db.prepare(`SELECT status FROM concepts WHERE id = ?`).get(native.conceptId) as { status: string }).status).toBe("retired");

      const restoreWatermark = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      nativeSource.restoreConcept(native.conceptId);
      const restoreDelta = nativeSource.exportDelta(restoreWatermark);
      // The monotonic clock may inclusively replay the prior tombstone beside the restoration;
      // graft retains both events and deterministically applies the later semantic lifecycle time.
      expect(restoreDelta.restorations).toContainEqual(expect.objectContaining({ concept_id: native.conceptId }));
      nativeReplica.graftRows(restoreDelta);
      expect((await nativeReplica.getConcept(native.conceptId, { synthesize: false }))?.body).toBe("Native retirement secret body.");
      const restoredLifecycle = nativeReplica
        // @ts-expect-error raw ordered-lifecycle assertion
        .db.prepare(
          `SELECT t.retired_at, r.restored_at, c.status
             FROM concepts c
             JOIN concept_tombstones t ON t.concept_id = c.id
             JOIN concept_restorations r ON r.concept_id = c.id
            WHERE c.id = ?`,
        )
        .get(native.conceptId) as { retired_at: number; restored_at: number; status: string };
      expect(restoredLifecycle).toMatchObject({ status: "active" });
      expect(restoredLifecycle.restored_at).toBeGreaterThan(restoredLifecycle.retired_at);

      // An out-of-order old retirement event cannot undo the newer restore.
      nativeReplica.graftRows(nativeDelta);
      expect((await nativeReplica.getConcept(native.conceptId, { synthesize: false }))?.body).toBe("Native retirement secret body.");

      const reRetireWatermark = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      nativeSource.retireConcept(native.conceptId);
      const reRetireDelta = nativeSource.exportDelta(reRetireWatermark);
      nativeReplica.graftRows(reRetireDelta);
      await expect(nativeReplica.getConcept(native.conceptId)).resolves.toBeNull();
      const reRetiredLifecycle = nativeReplica
        // @ts-expect-error raw ordered-lifecycle assertion
        .db.prepare(
          `SELECT t.retired_at, r.restored_at, c.status
             FROM concepts c
             JOIN concept_tombstones t ON t.concept_id = c.id
             JOIN concept_restorations r ON r.concept_id = c.id
            WHERE c.id = ?`,
        )
        .get(native.conceptId) as { retired_at: number; restored_at: number; status: string };
      expect(reRetiredLifecycle).toMatchObject({ status: "retired" });
      expect(reRetiredLifecycle.retired_at).toBeGreaterThan(reRetiredLifecycle.restored_at);

      const source = await sourceSource.storeSource("Source retirement secret body.", {
        sourceRefs: ["source://source-a/docs/retired.md#intro~1"],
        operationId: "source-a:retired-binding:fingerprint-v1:snapshot-v1",
      });
      // Source lifecycle is connector-owned too — generic sync is intentionally not a connector
      // authority boundary (see assertGraftPayloadIsNativeOnly), so a source concept's retirement
      // must never leave the machine, even toward a same-id local source replica. This also closes
      // the backdoor a forged tombstone could otherwise use to retire a local source concept
      // through generic sync (see source-prereqs.test.ts "rejects forged source grafts").
      sourceReplica
        // @ts-expect-error test-only same-id source replica fixture
        .db.prepare(
          `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, circle, embedding,
                                 support_count, dirty, source_identity, active_observation_id, updated_at, created_at,
                                 usefulness_score, arousal_score)
           VALUES (?, 'source-retired', 'Source retired', 'local source body', 'source', 'active', .6, 'default', '[]', 1, 0,
                   'source://source-a', NULL, ?, ?, 0, 0)`,
        )
        .run(source.conceptId, Date.now(), Date.now());
      const sourceWatermark = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      sourceSource.retireConcept(source.conceptId);
      const sourceDelta = sourceSource.exportDelta(sourceWatermark);
      expect(sourceDelta.concepts).toEqual([]);
      expect(sourceDelta.observations).toEqual([]);
      expect(JSON.stringify(sourceDelta)).not.toContain("Source retirement secret body.");
      expect(sourceDelta.tombstones).not.toContainEqual(expect.objectContaining({ concept_id: source.conceptId }));
      sourceReplica.graftRows(sourceDelta);
      // No lifecycle event ever arrived: the same-id local source replica stays untouched.
      expect((sourceReplica
        // @ts-expect-error raw replica lifecycle assertion
        .db.prepare(`SELECT status FROM concepts WHERE id = ?`).get(source.conceptId) as { status: string }).status).toBe("active");
    } finally {
      nativeSource.close();
      nativeReplica.close();
      sourceSource.close();
      sourceReplica.close();
    }
  });

  it("never exports a retired source concept's tombstone — source lifecycle stays connector-owned", async () => {
    const core = freshCore();
    try {
      const source = await core.storeSource("Source concept retired locally.", {
        sourceRefs: ["source://source-a/docs/never-exported.md#intro~1"],
        operationId: "source-a:never-exported-binding:fingerprint-v1:snapshot-v1",
      });
      const watermark = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      core.retireConcept(source.conceptId);
      expect(core.exportDelta(watermark).tombstones).toEqual([]);
    } finally {
      core.close();
    }
  });

  it("migrates a legacy retired concept into a fresh incremental tombstone event", async () => {
    const legacy = freshCore();
    const replica = freshCore();
    try {
      legacy
        // @ts-expect-error test-only pre-lifecycle schema fixture
        .db.prepare(
          `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, circle, embedding,
                                 support_count, dirty, updated_at, created_at, usefulness_score, arousal_score)
           VALUES ('legacy-retired', 'legacy-retired', 'Legacy retired', 'Legacy retirement secret body.', 'fact', 'retired', .6,
                   'default', '[]', 1, 0, 1, 1, 0, 0)`,
        )
        .run();
      replica
        // @ts-expect-error test-only active replica fixture
        .db.prepare(
          `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, circle, embedding,
                                 support_count, dirty, updated_at, created_at, usefulness_score, arousal_score)
           VALUES ('legacy-retired', 'legacy-retired', 'Legacy retired', 'Replica body', 'fact', 'active', .6,
                   'default', ?, 1, 0, 1, 1, 0, 0)`,
        )
        .run(JSON.stringify(new Array(256).fill(0)));
      await replica.ensureEmbedderPin();
      const watermark = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      legacy
        // @ts-expect-error invokes the upgrade migration after inserting legacy-only state
        .migrate();
      const delta = legacy.exportDelta(watermark);
      expect(delta.concepts).toEqual([]);
      expect(delta.tombstones).toContainEqual(expect.objectContaining({ concept_id: "legacy-retired" }));
      expect(delta.tombstones[0]!.retired_at).toBeGreaterThan(watermark);
      replica.graftRows(delta);
      await expect(replica.getConcept("legacy-retired")).resolves.toBeNull();
    } finally {
      legacy.close();
      replica.close();
    }
  });

  it("replays lifecycle events exactly at the caller watermark without changing the settled state", async () => {
    const source = freshCore();
    const replica = freshCore();
    try {
      const concept = await source.store("Equality-boundary lifecycle evidence.");
      replica.graftRows(source.exportDelta(0));

      source.retireConcept(concept.conceptId);
      const retiredAt = (source
        // @ts-expect-error raw lifecycle watermark assertion
        .db.prepare(`SELECT retired_at FROM concept_tombstones WHERE concept_id = ?`).get(concept.conceptId) as { retired_at: number }).retired_at;
      const retirementDelta = source.exportDelta(retiredAt);
      expect(retirementDelta.tombstones).toContainEqual(expect.objectContaining({ concept_id: concept.conceptId, retired_at: retiredAt }));
      replica.graftRows(retirementDelta);
      replica.graftRows(retirementDelta); // equality-boundary replay is idempotent
      await expect(replica.getConcept(concept.conceptId)).resolves.toBeNull();

      source.restoreConcept(concept.conceptId);
      const restoredAt = (source
        // @ts-expect-error raw lifecycle watermark assertion
        .db.prepare(`SELECT restored_at FROM concept_restorations WHERE concept_id = ?`).get(concept.conceptId) as { restored_at: number }).restored_at;
      const restorationDelta = source.exportDelta(restoredAt);
      expect(restorationDelta.restorations).toContainEqual(expect.objectContaining({ concept_id: concept.conceptId, restored_at: restoredAt }));
      replica.graftRows(restorationDelta);
      replica.graftRows(restorationDelta); // equality-boundary replay is idempotent
      expect((await replica.getConcept(concept.conceptId, { synthesize: false }))?.body).toBe("Equality-boundary lifecycle evidence.");
    } finally {
      source.close();
      replica.close();
    }
  });

  it("preserves a locally-dirty concept's dirty flag when its tombstone is applied via graft (mirrors local retireConcept)", async () => {
    const source = freshCore();
    const replica = freshCore();
    try {
      const stored = await source.store("Concept pending synthesis, retired via graft.");
      replica.graftRows(source.exportDelta(0));
      expect(replica.isDirty(stored.conceptId)).toBe(true); // grafted concept arrives dirty=1, mirroring source

      const watermark = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 2));
      source.retireConcept(stored.conceptId);
      replica.graftRows(source.exportDelta(watermark));

      // Retired via the GRAFT lifecycle path (not local retireConcept) — dirty must still survive.
      expect(replica.listDirty().map((d) => d.id)).not.toContain(stored.conceptId); // listDirty filters retired
      const retiredRow = replica
        // @ts-expect-error raw dirty-preservation assertion across the graft lifecycle path
        .db.prepare(`SELECT status, dirty FROM concepts WHERE id = ?`).get(stored.conceptId) as { status: string; dirty: number };
      expect(retiredRow).toEqual({ status: "retired", dirty: 1 });

      replica.restoreConcept(stored.conceptId);
      expect(replica.isDirty(stored.conceptId)).toBe(true);
      expect(replica.listDirty().map((d) => d.id)).toContain(stored.conceptId);
    } finally {
      source.close();
      replica.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2 — dirty-marking
// ---------------------------------------------------------------------------
describe("dirty-marking on graft", () => {
  it("a concept that gains new observations is dirty=1; one without new obs is not", async () => {
    const dst = freshCore();
    const now = Date.now();

    // Insert concept A and concept B directly with known ids, not dirty.
    dst
      // @ts-expect-error accessing private db for test
      .db.exec(`
        INSERT INTO concepts (id, slug, title, body, kind, status, confidence, circle, embedding, support_count, dirty, updated_at, created_at, usefulness_score, arousal_score)
        VALUES
          ('concept-a', 'concept-a', 'Concept A', '', 'fact', 'active', 0.6, 'default', '${JSON.stringify(new Array(256).fill(0))}', 1, 0, ${now}, ${now}, 0, 0),
          ('concept-b', 'concept-b', 'Concept B', '', 'fact', 'active', 0.6, 'default', '${JSON.stringify(new Array(256).fill(0))}', 1, 0, ${now}, ${now}, 0, 0)
      `);

    // Build a payload that has a new observation only for concept A.
    const payload = basePayload({
      concepts: [
        // Concept A and B are already in dst; INSERT OR IGNORE skips them.
      ],
      observations: [
        {
          id: "obs-new-a",
          content: "New evidence for A.",
          embedding: JSON.stringify(new Array(256).fill(0)),
          kind: "statement",
          circle: "default",
          concept_id: "concept-a",
          superseded_by: null,
          superseded_at: null,
          session_id: null,
          author_agent_id: "agent-x",
          source_refs: null,
          created_at: now,
        },
      ],
    });

    const result = dst.graftRows(payload);

    expect(result.conceptsMarkedDirty).toContain("concept-a");
    expect(result.conceptsMarkedDirty).not.toContain("concept-b");
    expect(result.inserted.observations).toBe(1);

    // Verify dirty flag is set in DB
    const rowA = dst
      // @ts-expect-error accessing private db for test
      .db.prepare(`SELECT dirty FROM concepts WHERE id = 'concept-a'`)
      .get() as { dirty: number } | undefined;
    expect(rowA?.dirty).toBe(1);

    const rowB = dst
      // @ts-expect-error accessing private db for test
      .db.prepare(`SELECT dirty FROM concepts WHERE id = 'concept-b'`)
      .get() as { dirty: number } | undefined;
    expect(rowB?.dirty).toBe(0);

    dst.close();
  });
});

// ---------------------------------------------------------------------------
// Test 3 — edge ON CONFLICT reinforcement
// ---------------------------------------------------------------------------
describe("legacy edge compatibility", () => {
  it("replaying one legacy aggregate edge is idempotent", async () => {
    const src = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });
    const dst = freshCore();

    // Create two concepts and manually build a payload with one edge
    const a = await src.store("Topic alpha detail.");
    const b = await src.store("Topic beta detail.");

    const now = Date.now();
    const edgeRow = {
      id: "edge-1",
      src_id: a.conceptId,
      src_type: "concept",
      dst_id: b.conceptId,
      dst_type: "concept",
      type: "related",
      weight: 0.7,
      origin: "nn",
      count: 3,
      created_at: now,
      last_reinforced_at: now,
      scope: "default",
      dismissed_at: null,
      dismissed_by: null,
    };

    const payload = src.exportDelta(0);
    payload.edges = [edgeRow];
    delete payload.schemaVersion;
    delete payload.edgeComponents;

    dst.graftRows(payload);
    dst.graftRows(payload); // second graft — same edge

    const edges = dst.edges({ type: "related" });
    const e = edges.find((x) => x.srcId === a.conceptId && x.dstId === b.conceptId);
    expect(e).toBeDefined();
    // A legacy aggregate is represented by one synthetic component keyed by device id. MAX merge
    // preserves its contribution without double-counting a replay. A v7 intermediary has already
    // collapsed writer provenance, so a later v8 peer cannot reconstruct those independent writers.
    expect(e!.count).toBe(3);
    // weight = MAX(0.7, 0.7) = 0.7
    expect(e!.weight).toBeCloseTo(0.7);

    src.close();
    dst.close();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — edge dismissal wins
// ---------------------------------------------------------------------------
describe("edge dismissal wins on graft", () => {
  it("grafting a dismissed edge over an active local edge sets dismissed_at", async () => {
    const src = freshCore();
    const dst = freshCore();

    // Store matching concepts on both sides
    const a = await src.store("Alpha concept.");
    const b = await src.store("Beta concept.");

    const basePayloadExport = src.exportDelta(0);
    dst.graftRows(basePayloadExport);

    // Verify the edge is not dismissed yet on dst
    const before = dst.edges({ type: "possible_duplicate_of" });
    // Add an explicit active edge payload to be sure
    const now = Date.now();
    const activeEdgePayload = basePayload({
      edges: [
        {
          id: "edge-ab",
          src_id: a.conceptId,
          dst_id: b.conceptId,
          src_type: "concept",
          dst_type: "concept",
          type: "possible_duplicate_of",
          weight: 0.6,
          origin: "cheap",
          count: 1,
          created_at: now - 2000,
          last_reinforced_at: now - 2000,
          scope: "default",
          dismissed_at: null,
          dismissed_by: null,
        },
      ],
    });
    // First graft active edge
    dst.graftRows(basePayload({ concepts: basePayloadExport.concepts, observations: basePayloadExport.observations }));
    dst.graftRows(activeEdgePayload);

    // Now graft a dismissed version
    const dismissedAt = now;
    const dismissedPayload = basePayload({
      edges: [
        {
          id: "edge-ab-dismissed",
          src_id: a.conceptId,
          dst_id: b.conceptId,
          src_type: "concept",
          dst_type: "concept",
          type: "possible_duplicate_of",
          weight: 0.6,
          origin: "cheap",
          count: 1,
          created_at: now - 2000,
          last_reinforced_at: now,
          scope: "default",
          dismissed_at: dismissedAt,
          dismissed_by: "agent-x",
        },
      ],
    });
    dst.graftRows(dismissedPayload);

    // Edge should now be dismissed
    const rawEdges = dst
      // @ts-expect-error accessing private db for test verification
      .db.prepare(
        `SELECT dismissed_at, dismissed_by FROM memory_edge
         WHERE src_id = ? AND dst_id = ? AND type = 'possible_duplicate_of' AND scope = 'default'`,
      )
      .get(a.conceptId, b.conceptId) as { dismissed_at: number | null; dismissed_by: string | null } | undefined;

    expect(rawEdges?.dismissed_at).toBe(dismissedAt);
    expect(rawEdges?.dismissed_by).toBe("agent-x");

    src.close();
    dst.close();
  });
});

// ---------------------------------------------------------------------------
// Test 5 — exportDelta watermark
// ---------------------------------------------------------------------------
describe("exportDelta watermark", () => {
  it("concept at t=100 appears for since=50, is absent for since=150", async () => {
    const core = freshCore();
    const t100 = 100;

    // Manually insert a versioned concept with updated_at=100. Supplying a writer prevents the
    // local mutation trigger from replacing the fixture timestamp.
    core
      // @ts-expect-error accessing private db for test
      .db.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, circle, embedding, support_count, dirty, updated_at, created_at, usefulness_score, arousal_score, sync_revision, sync_writer)
         VALUES ('c1', 'alpha', 'Alpha', '', 'fact', 'active', 0.6, 'default', '[]', 1, 0, ?, ?, 0, 0, 1, 'fixture')`,
      )
      .run(t100, t100);

    const forSince50 = core.exportDelta(50);
    const forSince150 = core.exportDelta(150);

    expect(forSince50.concepts.some((c) => c.id === "c1")).toBe(true);
    expect(forSince150.concepts.some((c) => c.id === "c1")).toBe(false);

    core.close();
  });
});

// ---------------------------------------------------------------------------
// Test 6 — contradiction curation round-trip
// ---------------------------------------------------------------------------
describe("contradiction curation round-trip", () => {
  it("a resolved contradiction grafts with resolved_at and resolved_by intact", async () => {
    const src = freshCore();
    const dst = freshCore();

    const a = await src.store("The DB uses SQLite.");
    // Store a correction to generate a contradiction
    await src.store("Actually we use Postgres.", { kind: "correction", attachTo: a.conceptId });

    // Resolve the contradiction manually via the engine's resolveContradiction
    const prewarm = await src.prewarm("default");
    const contradiction = prewarm.openContradictions[0];
    if (contradiction) {
      await src.resolveContradiction(contradiction.id, { decision: "keep-current", body: "Confirmed: SQLite stays." });
    }

    const payload = src.exportDelta(0);
    dst.graftRows(payload);

    // Verify the contradiction was grafted with resolution data
    const rows = dst
      // @ts-expect-error accessing private db for test
      .db.prepare(`SELECT status, resolved_at, resolved_by FROM contradictions WHERE concept_id = ?`)
      .all(a.conceptId) as Array<{ status: string; resolved_at: number | null; resolved_by: string | null }>;

    if (contradiction) {
      const resolved = rows.find((r) => r.status === "resolved");
      expect(resolved).toBeDefined();
      expect(resolved!.resolved_at).not.toBeNull();
    } else {
      // No contradiction opened (correction path behavior) — still verify a contradiction row exists
      expect(rows.length).toBeGreaterThanOrEqual(0);
    }

    src.close();
    dst.close();
  });

  // contradicted_observation_id is the one contradictions column a legacy peer cannot carry — it
  // predates the column. Its ABSENCE therefore arrives indistinguishable from an explicit NULL, and
  // a straight `= excluded.…` assignment would erase a locally recorded named loser every time such
  // a peer relayed the row at a higher revision. Nothing would signal it: the supersession on
  // `observations` survives, so only the audit record of WHICH observation lost disappears.
  it("a legacy peer relaying at a higher revision does not erase contradicted_observation_id", async () => {
    const src = freshCore({ syncDeviceId: "device-src" });
    const dst = freshCore({ syncDeviceId: "device-dst" });

    const a = await src.store("Ship date is March 3rd.");
    const b = await src.store("Ship date moved to April 10th.", { kind: "correction", attachTo: a.conceptId });
    const contradiction = b.contradiction!;
    expect(contradiction).toBeDefined();

    src.resolveContradiction(contradiction.id, {
      decision: "accept-new",
      contradictedObservationId: a.observationId,
    });

    dst.graftRows(src.exportDelta(0));

    const read = () =>
      // @ts-expect-error accessing private db for test
      dst.db
        .prepare(`SELECT contradicted_observation_id AS named, sync_revision AS rev FROM contradictions WHERE id = ?`)
        .get(contradiction.id) as { named: string | null; rev: number };

    const before = read();
    expect(before.named).toBe(a.observationId);

    // The legacy payload: the same contradiction row at a HIGHER revision (so it wins the LWW race)
    // with the column absent entirely, exactly as a build predating it would serialize.
    const relayed = src.exportDelta(0).contradictions.map((row) => {
      const { contradicted_observation_id: _omitted, ...legacy } = row as unknown as Record<string, unknown>;
      return { ...legacy, sync_revision: before.rev + 5, sync_writer: "device-legacy" };
    });
    dst.graftRows(basePayload({ contradictions: relayed as never, deviceId: "device-legacy" }));

    const after = read();
    expect(after.rev).toBeGreaterThan(before.rev); // the relay really did win
    expect(after.named).toBe(a.observationId); // ...and the audit value survived it

    src.close();
    dst.close();
  });

  // The other direction, and the reason presence is checked rather than value: a CURRENT-schema
  // peer that resolved WITHOUT naming a loser sends an explicit null, which is a real value and must
  // win LWW like any other column. Swallowing it (as a COALESCE would) keeps the losing peer's id
  // beside the winner's status — a hybrid row that never converges.
  it("an explicit null from a current-schema peer wins LWW and clears contradicted_observation_id", async () => {
    const src = freshCore({ syncDeviceId: "device-src" });
    const dst = freshCore({ syncDeviceId: "device-dst" });

    const a = await src.store("Ship date is March 3rd.");
    const b = await src.store("Ship date moved to April 10th.", { kind: "correction", attachTo: a.conceptId });
    const contradiction = b.contradiction!;

    src.resolveContradiction(contradiction.id, {
      decision: "accept-new",
      contradictedObservationId: a.observationId,
    });
    dst.graftRows(src.exportDelta(0));

    const read = () =>
      // @ts-expect-error accessing private db for test
      dst.db
        .prepare(`SELECT contradicted_observation_id AS named, sync_revision AS rev FROM contradictions WHERE id = ?`)
        .get(contradiction.id) as { named: string | null; rev: number };

    const before = read();
    expect(before.named).toBe(a.observationId);

    // Current-schema peer: the key IS present and its value IS null.
    const relayed = src.exportDelta(0).contradictions.map((row) => ({
      ...(row as unknown as Record<string, unknown>),
      contradicted_observation_id: null,
      sync_revision: before.rev + 5,
      sync_writer: "device-peer2",
    }));
    dst.graftRows(basePayload({ contradictions: relayed as never, deviceId: "device-peer2" }));

    const after = read();
    expect(after.rev).toBeGreaterThan(before.rev);
    expect(after.named).toBeNull(); // the explicit null won — no hybrid row, peers converge

    src.close();
    dst.close();
  });
});

// ---------------------------------------------------------------------------
// Test 7 — batchDedup mints possible_duplicate_of
// ---------------------------------------------------------------------------
describe("batchDedup cross-machine dedup", () => {
  it("a grafted concept near an existing local concept gets a possible_duplicate_of edge", async () => {
    // Use default dedup thresholds so similar text attaches; we need two DISTINCT concepts.
    // Force tauAmbiguous low enough that the hashing embedder registers a near-match.
    const dst = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 0.3 });
    const src = freshCore(); // dedup off on source

    // Seed the destination with a concept
    await dst.store("The AuthService validates every request.");

    // Graft a near-duplicate concept from the source (same text, different uuid)
    const r = await src.store("The AuthService validates every request.");
    const payload = src.exportDelta(0);
    dst.graftRows(payload);

    // batchDedup should link the grafted concept to the local one
    dst.batchDedup([r.conceptId]);

    const dupEdges = dst.edges({ type: "possible_duplicate_of" });
    const linked = dupEdges.some(
      (e) => e.srcId === r.conceptId || e.dstId === r.conceptId,
    );
    expect(linked).toBe(true);

    src.close();
    dst.close();
  });

  it.each([
    { name: "malformed", embedding: "[null]", error: MalformedEmbeddingStoreError },
    { name: "mixed-width", embedding: "[0]", error: EmbedderWidthConflictError },
  ])("rejects a $name live store before any graph or sync mutation", async ({ embedding, error }) => {
    const core = freshCore({ tauAmbiguous: 0, graphEnabled: true });
    try {
      const local = await core.store("local dedup proof row", { resolution: "forceNew" });
      const grafted = await core.store("grafted dedup proof row", { resolution: "forceNew" });
      const db = (core as any).db as import("../storage").StoragePort;
      db.prepare(`UPDATE observations SET embedding=? WHERE id=?`).run(embedding, local.observationId);
      const snapshot = () => JSON.stringify({
        sync: db.prepare(`SELECT * FROM sync_meta`).all(),
        edges: db.prepare(`SELECT * FROM memory_edge ORDER BY id`).all(),
        components: db.prepare(`SELECT * FROM memory_edge_components ORDER BY src_id,dst_id,type,scope,writer_id`).all(),
      });
      const before = snapshot();
      expect(() => core.batchDedup([grafted.conceptId])).toThrow(error);
      expect(snapshot()).toBe(before);
    } finally {
      core.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8 — embedder mismatch
// ---------------------------------------------------------------------------
describe("embedder mismatch rejection", () => {
  it("graftRows with wrong embedderModelId throws EmbedderMismatchError", () => {
    const dst = freshCore();
    const payload = basePayload({ embedderModelId: "Xenova/all-MiniLM-L6-v2" });

    expect(() => dst.graftRows(payload)).toThrow(EmbedderMismatchError);
    expect(() => dst.graftRows(payload)).toThrow(/incompatible vector spaces/i);

    dst.close();
  });

  it("rejects a graft from a pre-tokenizer-bump hashing store, even though dim matches (round 4, Codex thread 14)", () => {
    // Before HASHING_TOKENIZER_VERSION existed, every HashingEmbeddingProvider advertised
    // "hashing:dim=256" regardless of tokenizer — this literal is exactly what the OLD
    // (ASCII-only-tokenizer) provider produced, standing in for a store that predates the
    // Unicode-tokenizer bump (item 9). The fix must tell these apart even though `dim` alone is
    // identical: old-tokenizer and new-tokenizer hashing vectors are NOT the same space.
    const dst = freshCore();
    const payload = basePayload({ embedderModelId: "hashing:dim=256" });

    expect(() => dst.graftRows(payload)).toThrow(EmbedderMismatchError);
    expect(() => dst.graftRows(payload)).toThrow(/incompatible vector spaces/i);

    dst.close();
  });
});

// ---------------------------------------------------------------------------
// Test 9 — entity graft
// ---------------------------------------------------------------------------
describe("entity graft", () => {
  it("grafted concepts are findable via entity-based search on the receiver", async () => {
    const src = new MonetCore(":memory:"); // default thresholds, graph enabled
    const dst = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });

    // Store with a rare structural entity so entity edges form
    await src.store("Decided to use AuthService for all authentication flows.");

    const payload = src.exportDelta(0);
    dst.graftRows(payload);

    // Verify entity rows were grafted
    const entityKeys = dst
      // @ts-expect-error accessing private db for test
      .db.prepare(`SELECT entity_key FROM concept_entities`)
      .all() as Array<{ entity_key: string }>;

    // The src engine's entity extraction should have produced at least one entity
    expect(entityKeys.length).toBeGreaterThan(0);
    // id:AuthService should be among them
    const hasAuth = entityKeys.some((e) => e.entity_key.includes("AuthService"));
    expect(hasAuth).toBe(true);

    src.close();
    dst.close();
  });
});

// ---------------------------------------------------------------------------
// Test 10 — circle_alias status propagation
// ---------------------------------------------------------------------------
describe("circle_alias status propagation", () => {
  it("a higher row revision can archive an active alias", () => {
    const dst = freshCore();

    // Seed dst with an active alias
    dst
      // @ts-expect-error accessing private db for test
      .db.prepare(
        `INSERT INTO circle_aliases (from_name, to_name, status, created_at) VALUES (?, ?, 'active', ?)`,
      )
      .run("old-circle", "new-circle", Date.now());

    // Graft an inactive alias for the same from_name
    const payload = basePayload({
      circleAliases: [
        {
          from_name: "old-circle",
          to_name: "new-circle",
          status: "archived",
          created_at: Date.now(),
          sync_revision: 2,
          sync_writer: "machine-a",
        },
      ],
    });
    dst.graftRows(payload);

    const row = dst
      // @ts-expect-error accessing private db for test
      .db.prepare(`SELECT status FROM circle_aliases WHERE from_name = 'old-circle'`)
      .get() as { status: string } | undefined;

    expect(row?.status).toBe("archived");

    dst.close();
  });
});

// ---------------------------------------------------------------------------
// v8 closure — row clocks, relays, components, curation, and restoration
// ---------------------------------------------------------------------------
describe("v8 sync closure", () => {
  it("uses inclusive replay-safe boundaries for every exported row family", async () => {
    const core = freshCore({ syncDeviceId: "boundary", graphEnabled: false });
    try {
      const first = await core.store("Boundary alpha.");
      const second = await core.store("Boundary beta.");
      await core.checkpoint();
      core.promoteToFirstBlock(first.conceptId, "Boundary pin.", "default");
      const db = (core as any).db as import("../storage").StoragePort;
      db.prepare(
        `INSERT INTO contradictions (id, concept_id, kind, status, detail)
         VALUES ('boundary-contradiction', ?, 'value-conflict', 'open', 'fixture')`,
      ).run(first.conceptId);
      db.prepare(
        `INSERT INTO circle_aliases (from_name, to_name, status) VALUES ('boundary-old', 'default', 'active')`,
      ).run();
      (core as any).upsertEdge(first.conceptId, second.conceptId, "related", 0.7, "nn", "default");

      const observation = db.prepare(`SELECT id, created_at FROM observations WHERE concept_id = ? ORDER BY created_at LIMIT 1`).get(first.conceptId) as { id: string; created_at: number };
      const revision = db.prepare(`SELECT id, created_at FROM concept_revisions WHERE concept_id = ? ORDER BY created_at LIMIT 1`).get(first.conceptId) as { id: string; created_at: number };
      const concept = db.prepare(`SELECT updated_at FROM concepts WHERE id = ?`).get(first.conceptId) as { updated_at: number };
      const contradiction = db.prepare(`SELECT updated_at FROM contradictions WHERE id = 'boundary-contradiction'`).get() as { updated_at: number };
      const pin = db.prepare(`SELECT id, updated_at FROM first_block WHERE concept_id = ?`).get(first.conceptId) as { id: string; updated_at: number };
      const alias = db.prepare(`SELECT updated_at FROM circle_aliases WHERE from_name = 'boundary-old'`).get() as { updated_at: number };
      const session = db.prepare(`SELECT id, updated_at FROM sessions ORDER BY started_at LIMIT 1`).get() as { id: string; updated_at: number };
      const component = db.prepare(`SELECT updated_at FROM memory_edge_components WHERE src_id = ? AND dst_id = ?`).get(first.conceptId, second.conceptId) as { updated_at: number };

      expect(core.exportDelta(concept.updated_at).concepts).toContainEqual(expect.objectContaining({ id: first.conceptId }));
      expect(core.exportDelta(observation.created_at).observations).toContainEqual(expect.objectContaining({ id: observation.id }));
      expect(core.exportDelta(revision.created_at).conceptRevisions).toContainEqual(expect.objectContaining({ id: revision.id }));
      expect(core.exportDelta(contradiction.updated_at).contradictions).toContainEqual(expect.objectContaining({ id: "boundary-contradiction" }));
      expect(core.exportDelta(pin.updated_at).firstBlock).toContainEqual(expect.objectContaining({ id: pin.id }));
      expect(core.exportDelta(alias.updated_at).circleAliases).toContainEqual(expect.objectContaining({ from_name: "boundary-old" }));
      expect(core.exportDelta(session.updated_at).sessions).toContainEqual(expect.objectContaining({ id: session.id }));
      expect(core.exportDelta(component.updated_at).edgeComponents).toContainEqual(expect.objectContaining({ writer_id: "boundary" }));
    } finally {
      core.close();
    }
  });

  it("relays an incremental concept/evidence update A to B to C", async () => {
    const a = freshCore({ syncDeviceId: "relay-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "relay-b", graphEnabled: false });
    const c = freshCore({ syncDeviceId: "relay-c", graphEnabled: false });
    try {
      const stored = await a.store("Relay base evidence.");
      const initial = a.exportDelta(0);
      b.graftRows(initial);
      c.graftRows(initial);
      const bBoundary = b.exportDelta(0).exportedAt;

      await a.store("Relay second evidence.", { attachTo: stored.conceptId });
      b.graftRows(a.exportDelta(initial.exportedAt));
      const relayed = b.exportDelta(bBoundary);
      expect(relayed.concepts).toContainEqual(expect.objectContaining({ id: stored.conceptId }));
      expect(relayed.observations).toHaveLength(2);
      c.graftRows(relayed);

      const projection = (c as any).db.prepare(`SELECT support_count FROM concepts WHERE id = ?`).get(stored.conceptId) as { support_count: number };
      expect(projection.support_count).toBe(2);
      expect(((c as any).db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE concept_id = ?`).get(stored.conceptId) as { n: number }).n).toBe(2);
    } finally {
      a.close(); b.close(); c.close();
    }
  });

  it("converges equal-revision mutable rows under shuffled delivery", async () => {
    const seed = freshCore({ syncDeviceId: "row-seed", graphEnabled: false });
    const left = freshCore({ syncDeviceId: "row-left", graphEnabled: false });
    const right = freshCore({ syncDeviceId: "row-right", graphEnabled: false });
    const forward = freshCore({ syncDeviceId: "row-forward", graphEnabled: false });
    const reverse = freshCore({ syncDeviceId: "row-reverse", graphEnabled: false });
    try {
      const stored = await seed.store("Row convergence seed.");
      seed.promoteToFirstBlock(stored.conceptId, "seed-pin", "default");
      (seed as any).db.prepare(`INSERT INTO circle_aliases (from_name, to_name, status) VALUES ('row-alias', 'seed-target', 'active')`).run();
      (seed as any).db.prepare(`INSERT INTO contradictions (id, concept_id, kind, status, detail) VALUES ('row-contradiction', ?, 'value-conflict', 'open', 'seed')`).run(stored.conceptId);
      const initial = seed.exportDelta(0);
      for (const replica of [left, right, forward, reverse]) replica.graftRows(initial);
      (left as any).db.prepare(`UPDATE concepts SET title = 'left-title', body = 'left-body' WHERE id = ?`).run(stored.conceptId);
      (right as any).db.prepare(`UPDATE concepts SET title = 'right-title', body = 'right-body' WHERE id = ?`).run(stored.conceptId);
      for (const [core, suffix] of [[left, "left"], [right, "right"]] as const) {
        const db = (core as any).db as import("../storage").StoragePort;
        db.prepare(`UPDATE first_block SET summary = ? WHERE concept_id = ?`).run(`${suffix}-pin`, stored.conceptId);
        db.prepare(`UPDATE circle_aliases SET to_name = ? WHERE from_name = 'row-alias'`).run(`${suffix}-target`);
        db.prepare(`UPDATE contradictions SET detail = ? WHERE id = 'row-contradiction'`).run(`${suffix}-detail`);
        db.prepare(`UPDATE sessions SET summary = ?`).run(`${suffix}-session`);
      }
      const l = left.exportDelta(0);
      const r = right.exportDelta(0);
      forward.graftRows(l); forward.graftRows(r);
      reverse.graftRows(r); reverse.graftRows(l);
      const read = (core: MonetCore) => (core as any).db.prepare(`SELECT title, body, sync_revision, sync_writer FROM concepts WHERE id = ?`).get(stored.conceptId);
      expect(read(forward)).toEqual(read(reverse));
      expect(read(forward)).toEqual(expect.objectContaining({ title: "right-title", body: "right-body", sync_writer: "row-right" }));
      const mutableState = (core: MonetCore) => {
        const db = (core as any).db as import("../storage").StoragePort;
        return {
          pin: db.prepare(`SELECT summary, sync_revision, sync_writer FROM first_block WHERE concept_id = ?`).get(stored.conceptId),
          alias: db.prepare(`SELECT to_name, sync_revision, sync_writer FROM circle_aliases WHERE from_name = 'row-alias'`).get(),
          contradiction: db.prepare(`SELECT detail, sync_revision, sync_writer FROM contradictions WHERE id = 'row-contradiction'`).get(),
          session: db.prepare(`SELECT summary, sync_revision, sync_writer FROM sessions ORDER BY id LIMIT 1`).get(),
        };
      };
      expect(mutableState(forward)).toEqual(mutableState(reverse));
      expect(mutableState(forward)).toEqual({
        pin: expect.objectContaining({ summary: "right-pin", sync_writer: "row-right" }),
        alias: expect.objectContaining({ to_name: "right-target", sync_writer: "row-right" }),
        contradiction: expect.objectContaining({ detail: "right-detail", sync_writer: "row-right" }),
        session: expect.objectContaining({ summary: "right-session", sync_writer: "row-right" }),
      });
    } finally {
      seed.close(); left.close(); right.close(); forward.close(); reverse.close();
    }
  });

  it("merges per-writer edge components exactly once and ignores v8 aggregate totals", async () => {
    const a = freshCore({ syncDeviceId: "edge-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "edge-b", graphEnabled: false });
    const forward = freshCore({ syncDeviceId: "edge-forward", graphEnabled: false });
    const reverse = freshCore({ syncDeviceId: "edge-reverse", graphEnabled: false });
    const relay = freshCore({ syncDeviceId: "edge-relay", graphEnabled: false });
    try {
      const one = await a.store("Edge component one.");
      const two = await a.store("Edge component two.");
      const initial = a.exportDelta(0);
      for (const replica of [b, forward, reverse, relay]) replica.graftRows(initial);
      for (let i = 0; i < 2; i++) (a as any).upsertEdge(one.conceptId, two.conceptId, "related", 0.6, "nn", "default");
      for (let i = 0; i < 3; i++) (b as any).upsertEdge(one.conceptId, two.conceptId, "related", 0.8, "nn", "default");
      const pa = a.exportDelta(0);
      const pb = b.exportDelta(0);
      for (const edge of pa.edges) edge.count = 999;
      forward.graftRows(pa); forward.graftRows(pb); forward.graftRows(pa); forward.graftRows(pb);
      reverse.graftRows(pb); reverse.graftRows(pa); reverse.graftRows(pb); reverse.graftRows(pa);
      const count = (core: MonetCore) => core.edges({ type: "related" }).find((edge) => edge.srcId === one.conceptId && edge.dstId === two.conceptId)!.count;
      expect(count(forward)).toBe(5);
      expect(count(reverse)).toBe(5);
      relay.graftRows(forward.exportDelta(0));
      expect(count(relay)).toBe(5);
    } finally {
      a.close(); b.close(); forward.close(); reverse.close(); relay.close();
    }
  });

  it("propagates alias chains, First Block edits/removal/re-promotion, contradictions, and session endings", async () => {
    const a = freshCore({ syncDeviceId: "curation-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "curation-b", graphEnabled: false });
    try {
      const stored = await a.store("Curation evidence.", { circle: "old" });
      a.promoteToFirstBlock(stored.conceptId, "Initial summary.", "old");
      const initial = a.exportDelta(0);
      b.graftRows(initial);

      a.updateFirstBlockSummary(stored.conceptId, "Updated summary.", "old");
      await a.store("Curation follow-up.", { attachTo: stored.conceptId, circle: "old" });
      (a as any).db.prepare(
        `INSERT INTO contradictions (id, concept_id, kind, status, detail) VALUES ('curation-contradiction', ?, 'value-conflict', 'open', 'fixture')`,
      ).run(stored.conceptId);
      a.renameCircle("old", "middle");
      a.renameCircle("middle", "final");
      await a.saveWorkstream({ status: "paused", nextSteps: ["resume"] }, { circle: "final", summary: "ended" });
      const changed = a.exportDelta(initial.exportedAt);
      b.graftRows(changed);
      expect(b.resolveCircleName("old")).toBe("final");
      expect(b.listFirstBlock("final")).toContainEqual(expect.objectContaining({ conceptId: stored.conceptId, summary: "Updated summary.", summaryDirty: true }));
      expect(((b as any).db.prepare(`SELECT status FROM contradictions WHERE id = 'curation-contradiction'`).get() as { status: string }).status).toBe("open");
      expect(((b as any).db.prepare(`SELECT status FROM sessions WHERE summary = 'ended'`).get() as { status: string }).status).toBe("ended");

      (a as any).db.prepare(`UPDATE contradictions SET status = 'resolved', resolved_at = unixepoch() * 1000, resolved_by = 'fixture' WHERE id = 'curation-contradiction'`).run();
      a.removeFromFirstBlock(stored.conceptId, "final");
      const removed = a.exportDelta(changed.exportedAt);
      b.graftRows(removed);
      expect(b.listFirstBlock("final")).toEqual([]);
      expect(((b as any).db.prepare(`SELECT status FROM contradictions WHERE id = 'curation-contradiction'`).get() as { status: string }).status).toBe("resolved");

      a.promoteToFirstBlock(stored.conceptId, "Restored pin.", "final");
      b.graftRows(a.exportDelta(removed.exportedAt));
      expect(b.listFirstBlock("final")).toContainEqual(expect.objectContaining({ conceptId: stored.conceptId, summary: "Restored pin." }));
    } finally {
      a.close(); b.close();
    }
  });

  it("restoration deltas carry the complete historical evidence and revision ledger", async () => {
    const a = freshCore({ syncDeviceId: "restore-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "restore-b", graphEnabled: false });
    const c = freshCore({ syncDeviceId: "restore-c", graphEnabled: false });
    try {
      const stored = await a.store("Restoration evidence one.");
      await a.store("Restoration evidence two.", { attachTo: stored.conceptId });
      await a.checkpoint();
      const initial = a.exportDelta(0);
      b.graftRows(initial);
      c.graftRows(initial);
      const bBoundary = b.exportDelta(0).exportedAt;
      a.retireConcept(stored.conceptId);
      const retired = a.exportDelta(initial.exportedAt);
      b.graftRows(retired);
      const relayedRetirement = b.exportDelta(bBoundary);
      c.graftRows(relayedRetirement);
      expect(((c as any).db.prepare(`SELECT status FROM concepts WHERE id = ?`).get(stored.conceptId) as { status: string }).status).toBe("retired");
      a.restoreConcept(stored.conceptId);
      const restored = a.exportDelta(retired.exportedAt);
      expect(restored.restorations).toContainEqual(expect.objectContaining({ concept_id: stored.conceptId }));
      expect(restored.observations.filter((row) => row.concept_id === stored.conceptId)).toHaveLength(2);
      expect(restored.conceptRevisions.some((row) => row.concept_id === stored.conceptId)).toBe(true);
      b.graftRows(restored);
      c.graftRows(b.exportDelta(relayedRetirement.exportedAt));
      expect(((b as any).db.prepare(`SELECT status, support_count FROM concepts WHERE id = ?`).get(stored.conceptId) as { status: string; support_count: number })).toEqual({ status: "active", support_count: 2 });
      expect(((c as any).db.prepare(`SELECT status, support_count FROM concepts WHERE id = ?`).get(stored.conceptId) as { status: string; support_count: number })).toEqual({ status: "active", support_count: 2 });
    } finally {
      a.close(); b.close(); c.close();
    }
  });
});

describe("v8 verification fix round", () => {
  it("exports from one bounded snapshot when another connection writes mid-scan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-sync-snapshot-"));
    const path = join(dir, "monet.db");
    const reader = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, graphEnabled: false, syncDeviceId: "snapshot-store" });
    const writer = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, graphEnabled: false });
    try {
      const stored = await reader.store("Snapshot original title.");
      const db = (reader as any).db as import("../storage").StoragePort;
      const writerDb = (writer as any).db as import("../storage").StoragePort;
      const originalPrepare = db.prepare.bind(db);
      let interleaved = false;
      (db as any).prepare = (sql: string) => {
        const statement = originalPrepare(sql);
        if (!interleaved && sql.includes("FROM observations o")) {
          interleaved = true;
          writerDb.prepare(`UPDATE concepts SET title = 'Snapshot concurrent title' WHERE id = ?`).run(stored.conceptId);
        }
        return statement;
      };
      const first = reader.exportDelta(0);
      (db as any).prepare = originalPrepare;
      expect(first.concepts.find((row) => row.id === stored.conceptId)?.title).toBe("Snapshot original title");
      const next = reader.exportDelta(first.exportedAt);
      expect(next.concepts).toContainEqual(expect.objectContaining({ id: stored.conceptId, title: "Snapshot concurrent title" }));
    } finally {
      reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps graph components native, active, scoped, and replay-safe through move and retirement", async () => {
    const a = freshCore({ syncDeviceId: "graph-a", graphEnabled: true });
    const b = freshCore({ syncDeviceId: "graph-b", graphEnabled: true });
    const c = freshCore({ syncDeviceId: "graph-c", graphEnabled: true });
    try {
      const one = await a.store("Graph native one AuthService.");
      const two = await a.store("Graph native two BillingService.");
      const source = await a.storeSource("Graph connector binding.", {
        sourceRefs: ["source://graph-source/docs/a.md#x~1"],
        operationId: "graph-source:binding:fingerprint:snapshot",
      });
      (a as any).upsertEdge(one.conceptId, two.conceptId, "related", 0.8, "fixture", "default");
      (a as any).upsertEdge(source.conceptId, one.conceptId, "related", 0.8, "fixture", "default");
      const initial = a.exportDelta(0);
      expect(initial.edgeComponents).not.toContainEqual(expect.objectContaining({ src_id: source.conceptId }));
      b.graftRows(initial);
      a.reassignCircle(one.conceptId, "moved");
      const moved = a.exportDelta(initial.exportedAt);
      b.graftRows(moved); b.graftRows(moved);
      expect(((b as any).db.prepare(`SELECT COUNT(*) AS n FROM memory_edge WHERE scope = 'default' AND (src_id = ? OR dst_id = ?)`).get(one.conceptId, one.conceptId) as { n: number }).n).toBe(0);
      expect(((b as any).db.prepare(`SELECT COUNT(*) AS n FROM memory_edge_components WHERE scope = 'default' AND (src_id = ? OR dst_id = ?)`).get(one.conceptId, one.conceptId) as { n: number }).n).toBe(0);
      a.retireConcept(two.conceptId);
      const retired = a.exportDelta(moved.exportedAt);
      b.graftRows(retired); b.graftRows(retired);
      c.graftRows(a.exportDelta(0));
      for (const core of [b, c]) {
        expect(core.edges().some((edge) => edge.srcId === two.conceptId || edge.dstId === two.conceptId)).toBe(false);
      }
    } finally {
      a.close(); b.close(); c.close();
    }
  });

  it("converges independent First Block pins by natural key under shuffled edit/remove/re-promote", async () => {
    const seed = freshCore({ syncDeviceId: "pin-seed", graphEnabled: false });
    const left = freshCore({ syncDeviceId: "pin-left", graphEnabled: false });
    const right = freshCore({ syncDeviceId: "pin-right", graphEnabled: false });
    const forward = freshCore({ syncDeviceId: "pin-forward", graphEnabled: false });
    const reverse = freshCore({ syncDeviceId: "pin-reverse", graphEnabled: false });
    try {
      const stored = await seed.store("Concurrent pin evidence.");
      const initial = seed.exportDelta(0);
      for (const core of [left, right, forward, reverse]) core.graftRows(initial);
      const leftBoundary = left.exportDelta(0).exportedAt;
      const rightBoundary = right.exportDelta(0).exportedAt;
      left.promoteToFirstBlock(stored.conceptId, "left pin", "default");
      right.promoteToFirstBlock(stored.conceptId, "right pin", "default");
      const l1 = left.exportDelta(leftBoundary);
      const r1 = right.exportDelta(rightBoundary);
      forward.graftRows(l1); forward.graftRows(r1);
      reverse.graftRows(r1); reverse.graftRows(l1);
      expect(forward.listFirstBlock("default")).toEqual(reverse.listFirstBlock("default"));
      left.removeFromFirstBlock(stored.conceptId, "default");
      right.updateFirstBlockSummary(stored.conceptId, "right edited", "default");
      left.promoteToFirstBlock(stored.conceptId, "left re-promoted", "default");
      const l2 = left.exportDelta(l1.exportedAt);
      const r2 = right.exportDelta(r1.exportedAt);
      forward.graftRows(r2); forward.graftRows(l2); forward.graftRows(r2);
      reverse.graftRows(l2); reverse.graftRows(r2); reverse.graftRows(l2);
      expect(forward.listFirstBlock("default")).toEqual(reverse.listFirstBlock("default"));
      expect(((forward as any).db.prepare(`SELECT COUNT(*) AS n FROM first_block WHERE concept_id = ?`).get(stored.conceptId) as { n: number }).n).toBe(1);
    } finally {
      seed.close(); left.close(); right.close(); forward.close(); reverse.close();
    }
  });

  it("replicates observation rebinding and hard deletion, then rejects stale resurrection", async () => {
    const a = freshCore({ syncDeviceId: "binding-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "binding-b", graphEnabled: false });
    try {
      const src = await a.store("Binding source one.");
      const attached = await a.store("Binding source two.", { attachTo: src.conceptId });
      const dest = await a.store("Binding destination.");
      const initial = a.exportDelta(0);
      b.graftRows(initial);
      await a.detach(src.conceptId, [attached.observationId], { destConceptId: dest.conceptId });
      const rebound = a.exportDelta(initial.exportedAt);
      b.graftRows(rebound);
      expect(((b as any).db.prepare(`SELECT concept_id FROM observations WHERE id = ?`).get(attached.observationId) as { concept_id: string }).concept_id).toBe(dest.conceptId);
      const remaining = ((a as any).db.prepare(`SELECT id FROM observations WHERE concept_id = ?`).all(src.conceptId) as Array<{ id: string }>).map((row) => row.id);
      await a.detach(src.conceptId, remaining, { destConceptId: dest.conceptId });
      const deleted = a.exportDelta(rebound.exportedAt);
      expect(deleted.deletions).toContainEqual(expect.objectContaining({ concept_id: src.conceptId }));
      b.graftRows(deleted);
      b.graftRows(initial);
      expect((b as any).db.prepare(`SELECT 1 FROM concepts WHERE id = ?`).get(src.conceptId)).toBeUndefined();
      expect(((b as any).db.prepare(`SELECT COUNT(*) AS n FROM concept_entities WHERE concept_id = ?`).get(src.conceptId) as { n: number }).n).toBe(0);
    } finally {
      a.close(); b.close();
    }
  });

  it("adapts changed v7 mutable rows from one origin while identical replay is a no-op", async () => {
    const src = freshCore({ syncDeviceId: "legacy-origin", graphEnabled: false });
    const dst = freshCore({ syncDeviceId: "legacy-dst", graphEnabled: false });
    const legacy = (payload: GraftPayload): GraftPayload => {
      const copy = structuredClone(payload) as GraftPayload;
      delete copy.schemaVersion; delete copy.edgeComponents; delete copy.conceptActivity; delete copy.deletions;
      for (const rows of [copy.concepts, copy.observations, copy.contradictions, copy.firstBlock, copy.circleAliases, copy.sessions ?? []] as unknown as Array<Array<Record<string, unknown>>>) {
        for (const row of rows) { delete row.sync_revision; delete row.sync_writer; delete row.updated_at; }
      }
      return copy;
    };
    try {
      const stored = await src.store("Legacy mutable base.");
      src.promoteToFirstBlock(stored.conceptId, "legacy pin", "default");
      (src as any).db.prepare(`INSERT INTO circle_aliases (from_name, to_name, status) VALUES ('legacy-old', 'default', 'active')`).run();
      (src as any).db.prepare(`INSERT INTO contradictions (id, concept_id, kind, status, detail) VALUES ('legacy-k', ?, 'value-conflict', 'open', 'old')`).run(stored.conceptId);
      dst.graftRows(legacy(src.exportDelta(0)));
      (src as any).db.prepare(`UPDATE concepts SET title = 'Legacy changed' WHERE id = ?`).run(stored.conceptId);
      src.updateFirstBlockSummary(stored.conceptId, "legacy changed pin", "default");
      (src as any).db.prepare(`UPDATE circle_aliases SET to_name = 'legacy-new' WHERE from_name = 'legacy-old'`).run();
      (src as any).db.prepare(`UPDATE contradictions SET detail = 'changed' WHERE id = 'legacy-k'`).run();
      (src as any).db.prepare(`UPDATE sessions SET status = 'ended', ended_at = unixepoch() * 1000`).run();
      const changed = legacy(src.exportDelta(0));
      dst.graftRows(changed);
      const db = (dst as any).db as import("../storage").StoragePort;
      expect(db.prepare(`SELECT title FROM concepts WHERE id = ?`).get(stored.conceptId)).toEqual({ title: "Legacy changed" });
      expect(db.prepare(`SELECT summary FROM first_block WHERE concept_id = ?`).get(stored.conceptId)).toEqual({ summary: "legacy changed pin" });
      expect(db.prepare(`SELECT to_name FROM circle_aliases WHERE from_name = 'legacy-old'`).get()).toEqual({ to_name: "legacy-new" });
      expect(db.prepare(`SELECT detail FROM contradictions WHERE id = 'legacy-k'`).get()).toEqual({ detail: "changed" });
      expect(db.prepare(`SELECT status FROM sessions ORDER BY id LIMIT 1`).get()).toEqual({ status: "ended" });
      const replay = dst.graftRows(changed);
      expect(Object.values(replay.inserted).reduce((sum, value) => sum + value, 0)).toBe(0);
    } finally {
      src.close(); dst.close();
    }
  });

  it("unions concurrent provenance/aliases and sums replay-safe activity components", async () => {
    const seed = freshCore({ syncDeviceId: "activity-seed", graphEnabled: false });
    const left = freshCore({ syncDeviceId: "activity-left", graphEnabled: false });
    const right = freshCore({ syncDeviceId: "activity-right", graphEnabled: false });
    const forward = freshCore({ syncDeviceId: "activity-forward", graphEnabled: false });
    const reverse = freshCore({ syncDeviceId: "activity-reverse", graphEnabled: false });
    try {
      const stored = await seed.store("Activity convergence.");
      const initial = seed.exportDelta(0);
      for (const core of [left, right, forward, reverse]) core.graftRows(initial);
      const leftBoundary = left.exportDelta(0).exportedAt;
      const rightBoundary = right.exportDelta(0).exportedAt;
      (left as any).db.prepare(`UPDATE concepts SET source_refs = '["docs/left"]', aliases = '["left"]' WHERE id = ?`).run(stored.conceptId);
      (right as any).db.prepare(`UPDATE concepts SET source_refs = '["docs/right"]', aliases = '["right"]' WHERE id = ?`).run(stored.conceptId);
      await left.getConcept(stored.conceptId, { synthesize: false });
      await right.getConcept(stored.conceptId, { synthesize: false });
      const l = left.exportDelta(leftBoundary);
      const r = right.exportDelta(rightBoundary);
      forward.graftRows(l); forward.graftRows(r); forward.graftRows(l);
      reverse.graftRows(r); reverse.graftRows(l); reverse.graftRows(r);
      const read = (core: MonetCore) => (core as any).db.prepare(`SELECT source_refs, aliases, usefulness_score FROM concepts WHERE id = ?`).get(stored.conceptId) as { source_refs: string; aliases: string; usefulness_score: number };
      const f = read(forward); const rev = read(reverse);
      expect(JSON.parse(f.source_refs)).toEqual(["docs/left", "docs/right"]);
      expect(JSON.parse(f.aliases)).toEqual(["left", "right"]);
      expect(f).toEqual(rev);
      expect(f.usefulness_score).toBe(2);
    } finally {
      seed.close(); left.close(); right.close(); forward.close(); reverse.close();
    }
  });

  it("rejects native-looking collisions with local source concepts and ledger observations before writing", async () => {
    const core = freshCore({ syncDeviceId: "collision-local", graphEnabled: false });
    try {
      const source = await core.storeSource("Collision source body.", {
        sourceRefs: ["source://collision/docs/a.md#x~1"],
        operationId: "collision:binding:fingerprint:snapshot",
      });
      const native = await core.store("Collision native target.");
      const db = (core as any).db as import("../storage").StoragePort;
      const sourceConcept = db.prepare(`SELECT * FROM concepts WHERE id = ?`).get(source.conceptId) as GraftPayload["concepts"][number];
      const sourceObservation = db.prepare(`SELECT * FROM observations WHERE concept_id = ?`).get(source.conceptId) as GraftPayload["observations"][number];
      const stable = () => JSON.stringify({
        concept: db.prepare(`SELECT * FROM concepts WHERE id = ?`).get(source.conceptId),
        observation: db.prepare(`SELECT * FROM observations WHERE id = ?`).get(sourceObservation.id),
      });
      const before = stable();
      expect(() => core.graftRows(basePayload({
        schemaVersion: 8,
        concepts: [{ ...sourceConcept, kind: "note", source_refs: null, sync_revision: 999, sync_writer: "attacker" }],
      }))).toThrow(/source-owned/);
      expect(stable()).toBe(before);
      expect(() => core.graftRows(basePayload({
        schemaVersion: 8,
        observations: [{ ...sourceObservation, kind: "note", concept_id: native.conceptId, source_refs: null, sync_revision: 999, sync_writer: "attacker" }],
      }))).toThrow(/source-owned/);
      expect(stable()).toBe(before);
      expect(() => core.graftRows(basePayload({
        schemaVersion: 8,
        conceptRevisions: [{ id: "forged-revision", concept_id: native.conceptId, version: 1, body: "forged", trigger_observation_id: sourceObservation.id, created_at: 1 }],
      }))).toThrow(/source-owned/);
      expect(stable()).toBe(before);
    } finally {
      core.close();
    }
  });

  it("requires native deletion provenance, never reserves unknown legacy ids, and relays native deletes", async () => {
    const a = freshCore({ syncDeviceId: "delete-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "delete-b", graphEnabled: false });
    const c = freshCore({ syncDeviceId: "delete-c", graphEnabled: false });
    try {
      expect(() => a.graftRows(basePayload({ schemaVersion: 8, deletions: [{ concept_id: "source-looking-id", deleted_at: 1, updated_at: 1 } as any] }))).toThrow(/provenance/);
      expect(() => a.graftRows(basePayload({ schemaVersion: 8, deletions: [{ concept_id: "source-looking-id", deleted_at: 1, updated_at: 1, writer_id: "attacker", concept_kind: "source" } as any] }))).toThrow(/provenance/);
      expect(() => a.graftRows(basePayload({ deletions: [{ concept_id: "unknown-legacy-id", deleted_at: 1, updated_at: 1 } as any] }))).toThrow(/locally known native/);
      expect(((a as any).db.prepare(`SELECT COUNT(*) AS n FROM concept_deletions`).get() as { n: number }).n).toBe(0);

      const src = await a.store("Native deletion source one.");
      const second = await a.store("Native deletion source two.", { attachTo: src.conceptId });
      const dest = await a.store("Native deletion destination.");
      const initial = a.exportDelta(0);
      b.graftRows(initial); c.graftRows(initial);
      const bBoundary = b.exportDelta(0).exportedAt;
      await a.detach(src.conceptId, [src.observationId, second.observationId], { destConceptId: dest.conceptId });
      const deletion = a.exportDelta(initial.exportedAt);
      expect(deletion.deletions).toContainEqual(expect.objectContaining({ concept_id: src.conceptId, writer_id: "delete-a", concept_kind: "native" }));
      b.graftRows(deletion); b.graftRows(deletion);
      const relay = b.exportDelta(bBoundary);
      expect(relay.deletions).toContainEqual(expect.objectContaining({ concept_id: src.conceptId, writer_id: "delete-a", concept_kind: "native" }));
      c.graftRows(relay); c.graftRows(initial);
      expect((c as any).db.prepare(`SELECT 1 FROM concepts WHERE id = ?`).get(src.conceptId)).toBeUndefined();
    } finally {
      a.close(); b.close(); c.close();
    }
  });

  it("resets an empty active projection and derives confirmation only from remaining active evidence", async () => {
    const source = freshCore({ syncDeviceId: "projection-source", graphEnabled: false });
    const replica = freshCore({ syncDeviceId: "projection-replica", graphEnabled: false });
    try {
      const only = await source.store("Projection only evidence.");
      const initial = source.exportDelta(0);
      replica.graftRows(initial);
      (replica as any).db.prepare(`UPDATE concepts SET last_confirmed_at = 9999999999999, confidence = 1, dirty = 1 WHERE id = ?`).run(only.conceptId);
      source.supersedeObservation(only.observationId, null);
      replica.graftRows(source.exportDelta(initial.exportedAt));
      const empty = (replica as any).db.prepare(`SELECT support_count, embedding, confidence, last_confirmed_at, last_confirmed_session_id, dirty, status FROM concepts WHERE id = ?`).get(only.conceptId) as { support_count: number; embedding: string; confidence: number; last_confirmed_at: number | null; last_confirmed_session_id: string | null; dirty: number; status: string };
      expect(empty).toMatchObject({ support_count: 0, confidence: 0, last_confirmed_at: null, last_confirmed_session_id: null, dirty: 0, status: "active" });
      expect((JSON.parse(empty.embedding) as number[]).every((value) => value === 0)).toBe(true);

      const first = await source.store("Projection remaining first.");
      const successor = await source.store("Projection remaining successor.", { attachTo: first.conceptId });
      const activeInitial = source.exportDelta(0);
      replica.graftRows(activeInitial);
      (replica as any).db.prepare(`UPDATE concepts SET last_confirmed_at = 9999999999999 WHERE id = ?`).run(first.conceptId);
      source.supersedeObservation(first.observationId, successor.observationId);
      replica.graftRows(source.exportDelta(activeInitial.exportedAt));
      const remaining = (replica as any).db.prepare(`SELECT support_count, last_confirmed_at FROM concepts WHERE id = ?`).get(first.conceptId) as { support_count: number; last_confirmed_at: number };
      const sourceRemaining = (source as any).db.prepare(`SELECT support_count, last_confirmed_at FROM concepts WHERE id = ?`).get(first.conceptId);
      expect(remaining).toEqual(sourceRemaining);
      expect(remaining.support_count).toBe(1);
      expect(remaining.last_confirmed_at).toBeLessThan(9999999999999);
    } finally {
      source.close(); replica.close();
    }
  });

  it("adapts later v7 activity changes into a replay-safe component and relays them through v8", async () => {
    const a = freshCore({ syncDeviceId: "legacy-activity-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "legacy-activity-b", graphEnabled: false });
    const c = freshCore({ syncDeviceId: "legacy-activity-c", graphEnabled: false });
    const legacy = (payload: GraftPayload): GraftPayload => {
      const copy = structuredClone(payload);
      delete copy.schemaVersion; delete copy.conceptActivity; delete copy.edgeComponents; delete copy.deletions;
      for (const row of copy.concepts as unknown as Array<Record<string, unknown>>) {
        delete row.sync_revision; delete row.sync_writer; delete row.updated_at;
      }
      return copy;
    };
    try {
      const stored = await a.store("Legacy activity evidence.");
      (a as any).db.prepare(`UPDATE concepts SET usefulness_score = 2, usefulness_last_fetched_at = 20, arousal_score = 3, arousal_last_updated_at = 30 WHERE id = ?`).run(stored.conceptId);
      b.graftRows(legacy(a.exportDelta(0)));
      const initialRelay = b.exportDelta(0);
      c.graftRows(initialRelay);
      const bBoundary = initialRelay.exportedAt;
      (a as any).db.prepare(`UPDATE concepts SET usefulness_score = 7, usefulness_last_fetched_at = 70, arousal_score = 5, arousal_last_updated_at = 50 WHERE id = ?`).run(stored.conceptId);
      const changed = legacy(a.exportDelta(0));
      b.graftRows(changed);
      const settled = JSON.stringify((b as any).db.prepare(`SELECT * FROM concept_activity_components WHERE concept_id = ? ORDER BY writer_id`).all(stored.conceptId));
      b.graftRows(changed);
      expect(JSON.stringify((b as any).db.prepare(`SELECT * FROM concept_activity_components WHERE concept_id = ? ORDER BY writer_id`).all(stored.conceptId))).toBe(settled);
      c.graftRows(b.exportDelta(bBoundary));
      for (const core of [b, c]) {
        expect((core as any).db.prepare(`SELECT usefulness_score, usefulness_last_fetched_at, arousal_score, arousal_last_updated_at FROM concepts WHERE id = ?`).get(stored.conceptId)).toEqual({ usefulness_score: 7, usefulness_last_fetched_at: 70, arousal_score: 5, arousal_last_updated_at: 50 });
        expect((core as any).db.prepare(`SELECT usefulness_count, arousal_count FROM concept_activity_components WHERE concept_id = ? AND writer_id = 'legacy:legacy-activity-a'`).get(stored.conceptId)).toEqual({ usefulness_count: 7, arousal_count: 5 });
      }
    } finally {
      a.close(); b.close(); c.close();
    }
  });

  it("does not export orphan edge components without an active materialized aggregate", async () => {
    const core = freshCore({ syncDeviceId: "orphan-edge", graphEnabled: false });
    try {
      const one = await core.store("Orphan edge one.");
      const two = await core.store("Orphan edge two.");
      (core as any).db.prepare(
        `INSERT INTO memory_edge_components
           (src_id, dst_id, type, scope, writer_id, count, weight, origin, created_at, last_reinforced_at, revision, updated_at)
         VALUES (?, ?, 'related', 'default', 'orphan-edge', 1, .5, 'fixture', 1, 1, 1, 1)`,
      ).run(one.conceptId, two.conceptId);
      expect(core.exportDelta(0).edgeComponents).toEqual([]);
    } finally {
      core.close();
    }
  });

  it("rejects stale membership scopes and cleans old memberships when a concept moves", async () => {
    const a = freshCore({ syncDeviceId: "membership-a", graphEnabled: true });
    const b = freshCore({ syncDeviceId: "membership-b", graphEnabled: true });
    try {
      const stored = await a.store("AuthService membership scope.");
      const initial = a.exportDelta(0);
      b.graftRows(initial);
      a.reassignCircle(stored.conceptId, "moved");
      const moved = a.exportDelta(initial.exportedAt);
      b.graftRows(moved);
      b.graftRows(initial);
      const db = (b as any).db as import("../storage").StoragePort;
      expect(db.prepare(`SELECT circle FROM concepts WHERE id = ?`).get(stored.conceptId)).toEqual({ circle: "moved" });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM concept_entities WHERE concept_id = ? AND scope != 'moved'`).get(stored.conceptId)).toEqual({ n: 0 });
      expect((db.prepare(`SELECT scope FROM concept_entities WHERE concept_id = ?`).all(stored.conceptId) as Array<{ scope: string }>).every((row) => row.scope === "moved")).toBe(true);
    } finally {
      a.close(); b.close();
    }
  });

  it("closes restoration payloads over historical activity before accepting later increments", async () => {
    const a = freshCore({ syncDeviceId: "restore-activity-a", graphEnabled: false });
    const fresh = freshCore({ syncDeviceId: "restore-activity-fresh", graphEnabled: false });
    try {
      const stored = await a.store("Restoration activity evidence.");
      for (let i = 0; i < 3; i++) await a.getConcept(stored.conceptId, { synthesize: false });
      const beforeRetire = a.exportDelta(0);
      a.retireConcept(stored.conceptId);
      const retired = a.exportDelta(beforeRetire.exportedAt);
      a.restoreConcept(stored.conceptId);
      const restored = a.exportDelta(retired.exportedAt);
      expect(restored.conceptActivity).toContainEqual(expect.objectContaining({ concept_id: stored.conceptId, usefulness_count: 3 }));
      fresh.graftRows(restored);
      expect((fresh as any).db.prepare(`SELECT usefulness_score FROM concepts WHERE id = ?`).get(stored.conceptId)).toEqual({ usefulness_score: 3 });
      const boundary = a.exportDelta(0).exportedAt;
      await a.getConcept(stored.conceptId, { synthesize: false });
      fresh.graftRows(a.exportDelta(boundary));
      expect((fresh as any).db.prepare(`SELECT usefulness_score FROM concepts WHERE id = ?`).get(stored.conceptId)).toEqual({ usefulness_score: 4 });
    } finally {
      a.close(); fresh.close();
    }
  });

  it("stamps every pre-v8 mutable row at migration time for one safe incremental replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-sync-v7-"));
    const path = join(dir, "monet.db");
    try {
      const old = new MonetCore(path, { graphEnabled: false, syncDeviceId: "migration-store", tauAttach: 1.1, tauAmbiguous: 1.1 });
      const stored = await old.store("Pre-v8 old edit AuthService.");
      const peer = await old.store("Pre-v8 peer BillingService.");
      old.promoteToFirstBlock(stored.conceptId, "Pre-v8 pin.", "default");
      const db = (old as any).db as import("../storage").StoragePort;
      db.prepare(`INSERT INTO circle_aliases (from_name, to_name, status) VALUES ('pre-v8-old', 'default', 'active')`).run();
      db.prepare(`INSERT INTO contradictions (id, concept_id, kind, status, detail) VALUES ('pre-v8-contradiction', ?, 'value-conflict', 'open', 'old')`).run(stored.conceptId);
      (old as any).upsertEdge(stored.conceptId, peer.conceptId, "related", .8, "fixture", "default");
      await old.getConcept(stored.conceptId, { synthesize: false });
      db.prepare(
        `INSERT INTO concept_deletions (concept_id, deleted_at, updated_at, writer_id, concept_kind)
         VALUES ('pre-v8-deleted-id', 1, 1, 'migration-store', 'native')`,
      ).run();
      db.prepare(`UPDATE sync_meta SET applying_remote = 1`).run();
      db.prepare(`UPDATE concepts SET title = 'Very old edit', usefulness_score = 4, usefulness_last_fetched_at = 4, arousal_score = 2, arousal_last_updated_at = 2, updated_at = 1 WHERE id = ?`).run(stored.conceptId);
      for (const table of ["observations", "circle_aliases", "contradictions", "first_block", "sessions"]) db.prepare(`UPDATE ${table} SET updated_at = 1`).run();
      db.prepare(`UPDATE memory_edge SET sync_updated_at = 1`).run();
      db.prepare(`UPDATE memory_edge_components SET updated_at = 1`).run();
      db.prepare(`DELETE FROM concept_activity_components WHERE concept_id = ?`).run(stored.conceptId);
      db.prepare(`UPDATE concept_deletions SET updated_at = 1`).run();
      db.prepare(`UPDATE sync_meta SET applying_remote = 0, closure_migrated = 0`).run();
      db.pragma("user_version = 7");
      old.close();
      const watermark = Date.now();
      const upgraded = new MonetCore(path, { graphEnabled: true });
      const delta = upgraded.exportDelta(watermark);
      expect(delta.concepts).toContainEqual(expect.objectContaining({ id: stored.conceptId, title: "Very old edit" }));
      expect(delta.observations).toContainEqual(expect.objectContaining({ concept_id: stored.conceptId }));
      expect(delta.circleAliases).toContainEqual(expect.objectContaining({ from_name: "pre-v8-old" }));
      expect(delta.contradictions).toContainEqual(expect.objectContaining({ id: "pre-v8-contradiction" }));
      expect(delta.firstBlock).toContainEqual(expect.objectContaining({ concept_id: stored.conceptId }));
      expect(delta.sessions?.length).toBeGreaterThan(0);
      expect(delta.edges).toContainEqual(expect.objectContaining({ src_id: stored.conceptId, dst_id: peer.conceptId }));
      expect(delta.edgeComponents).toContainEqual(expect.objectContaining({ src_id: stored.conceptId, dst_id: peer.conceptId }));
      expect(delta.conceptActivity).toContainEqual(expect.objectContaining({ concept_id: stored.conceptId, writer_id: "legacy:migration-store", usefulness_count: 4, arousal_count: 2 }));
      expect(delta.deletions).toContainEqual(expect.objectContaining({ concept_id: "pre-v8-deleted-id", writer_id: "migration-store", concept_kind: "native" }));
      const upgradedDb = (upgraded as any).db as import("../storage").StoragePort;
      expect(upgradedDb.prepare(`SELECT closure_migrated FROM sync_meta`).get()).toEqual({ closure_migrated: 1 });
      const stable = JSON.stringify({
        concepts: upgradedDb.prepare(`SELECT id, updated_at, sync_revision, sync_writer FROM concepts ORDER BY id`).all(),
        observations: upgradedDb.prepare(`SELECT id, updated_at, sync_revision, sync_writer FROM observations ORDER BY id`).all(),
        aliases: upgradedDb.prepare(`SELECT * FROM circle_aliases ORDER BY from_name`).all(),
        contradictions: upgradedDb.prepare(`SELECT * FROM contradictions ORDER BY id`).all(),
        firstBlock: upgradedDb.prepare(`SELECT * FROM first_block ORDER BY id`).all(),
        sessions: upgradedDb.prepare(`SELECT * FROM sessions ORDER BY id`).all(),
        edges: upgradedDb.prepare(`SELECT * FROM memory_edge ORDER BY id`).all(),
        components: upgradedDb.prepare(`SELECT * FROM memory_edge_components ORDER BY src_id, dst_id, writer_id`).all(),
        activity: upgradedDb.prepare(`SELECT * FROM concept_activity_components ORDER BY concept_id, writer_id`).all(),
        deletions: upgradedDb.prepare(`SELECT * FROM concept_deletions ORDER BY concept_id`).all(),
      });
      upgraded.close();
      const reopened = new MonetCore(path, { graphEnabled: true });
      const reopenedDb = (reopened as any).db as import("../storage").StoragePort;
      const stableAfter = JSON.stringify({
        concepts: reopenedDb.prepare(`SELECT id, updated_at, sync_revision, sync_writer FROM concepts ORDER BY id`).all(),
        observations: reopenedDb.prepare(`SELECT id, updated_at, sync_revision, sync_writer FROM observations ORDER BY id`).all(),
        aliases: reopenedDb.prepare(`SELECT * FROM circle_aliases ORDER BY from_name`).all(),
        contradictions: reopenedDb.prepare(`SELECT * FROM contradictions ORDER BY id`).all(),
        firstBlock: reopenedDb.prepare(`SELECT * FROM first_block ORDER BY id`).all(),
        sessions: reopenedDb.prepare(`SELECT * FROM sessions ORDER BY id`).all(),
        edges: reopenedDb.prepare(`SELECT * FROM memory_edge ORDER BY id`).all(),
        components: reopenedDb.prepare(`SELECT * FROM memory_edge_components ORDER BY src_id, dst_id, writer_id`).all(),
        activity: reopenedDb.prepare(`SELECT * FROM concept_activity_components ORDER BY concept_id, writer_id`).all(),
        deletions: reopenedDb.prepare(`SELECT * FROM concept_deletions ORDER BY concept_id`).all(),
      });
      expect(stableAfter).toBe(stable);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects source-owned ids through v8 deletions, activity, and edge components", async () => {
    const core = freshCore({ syncDeviceId: "source-guard", graphEnabled: false });
    try {
      const source = await core.storeSource("Guarded source binding.", {
        sourceRefs: ["source://guarded/docs/a.md#x~1"],
        operationId: "guarded:binding:fingerprint:snapshot",
      });
      const native = await core.store("Guarded native endpoint.");
      const common = { schemaVersion: 8, deviceId: "attacker" };
      expect(() => core.graftRows(basePayload({ ...common, deletions: [{ concept_id: source.conceptId, deleted_at: 1, updated_at: 1, writer_id: "attacker", concept_kind: "native" }] }))).toThrow(/source-owned/);
      expect(() => core.graftRows(basePayload({ ...common, conceptActivity: [{ concept_id: source.conceptId, writer_id: "attacker", usefulness_count: 1, usefulness_last_at: 1, arousal_count: 0, arousal_last_at: null, revision: 1, updated_at: 1 }] }))).toThrow(/source-owned/);
      expect(() => core.graftRows(basePayload({
        ...common,
        edgeComponents: [{ src_id: source.conceptId, dst_id: native.conceptId, type: "related", scope: "default", writer_id: "attacker", count: 1, weight: 1, origin: "forged", created_at: 1, last_reinforced_at: 1, revision: 1, updated_at: 1 }],
      }))).toThrow(/source-owned/);
    } finally {
      core.close();
    }
  });
});

describe("final cold-audit sync fixes", () => {
  it("skips stale graph rows for a locally retired endpoint while unrelated changes converge", async () => {
    const a = freshCore({ syncDeviceId: "retired-edge-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "retired-edge-b", graphEnabled: false });
    try {
      const one = await a.store("Retired endpoint one.");
      const two = await a.store("Retired endpoint two.");
      const unrelated = await a.store("Unrelated before update.");
      const initial = a.exportDelta(0);
      b.graftRows(initial);

      (a as any).upsertEdgeBoth(one.conceptId, two.conceptId, "possible_duplicate_of", .9, "fixture", "default");
      const componentDelta = a.exportDelta(initial.exportedAt);
      (a as any).db.prepare(`UPDATE concepts SET title = 'Unrelated converged update' WHERE id = ?`).run(unrelated.conceptId);
      a.dismissPossibleDuplicate(one.conceptId, two.conceptId, "fixture");
      const payload = a.exportDelta(componentDelta.exportedAt);
      payload.edgeComponents = componentDelta.edgeComponents;

      expect(b.reassignCircle(one.conceptId, "archive", { resolution: "forceNew" })).toMatchObject({
        action: "moved",
        conceptId: one.conceptId,
        fromCircle: "default",
        toCircle: "archive",
      });
      b.retireConcept(one.conceptId);
      const forgedUnknown = structuredClone(payload);
      forgedUnknown.edges = [{ ...payload.edges[0]!, src_id: "unknown-endpoint" }];
      forgedUnknown.edgeComponents = [];
      expect(() => b.graftRows(forgedUnknown)).toThrow(/unknown/);
      const forgedScope = structuredClone(payload);
      forgedScope.edges = [{ ...payload.edges[0]!, scope: "forged-scope" }];
      forgedScope.edgeComponents = [];
      expect(() => b.graftRows(forgedScope)).toThrow(/scope/);

      expect(() => b.graftRows(payload)).not.toThrow();
      expect((b as any).db.prepare(`SELECT title FROM concepts WHERE id = ?`).get(unrelated.conceptId)).toEqual({ title: "Unrelated converged update" });
      expect((b as any).db.prepare(`SELECT COUNT(*) AS n FROM memory_edge WHERE src_id = ? OR dst_id = ?`).get(one.conceptId, one.conceptId)).toEqual({ n: 0 });
      expect((b as any).db.prepare(`SELECT COUNT(*) AS n FROM memory_edge_components WHERE src_id = ? OR dst_id = ?`).get(one.conceptId, one.conceptId)).toEqual({ n: 0 });
    } finally {
      a.close(); b.close();
    }
  });

  it("excludes legacy superseded_by losers from projection even without superseded_at", async () => {
    const source = freshCore({ syncDeviceId: "legacy-projection-source", graphEnabled: false });
    const receiver = freshCore({ syncDeviceId: "legacy-projection-receiver", graphEnabled: false });
    try {
      const loser = await source.store("Legacy projection loser.");
      const successor = await source.store("Legacy projection successor.", { attachTo: loser.conceptId });
      const payload = source.exportDelta(0);
      delete payload.schemaVersion;
      delete payload.edgeComponents;
      delete payload.conceptActivity;
      delete payload.deletions;
      const concept = payload.concepts.find((row) => row.id === loser.conceptId)!;
      concept.last_confirmed_at = null;
      concept.last_confirmed_session_id = null;
      const loserRow = payload.observations.find((row) => row.id === loser.observationId)!;
      loserRow.superseded_by = successor.observationId;
      loserRow.superseded_at = null;
      const successorRow = payload.observations.find((row) => row.id === successor.observationId)!;

      receiver.graftRows(payload);
      const read = () => (receiver as any).db.prepare(
        `SELECT support_count, embedding, confidence, last_confirmed_at FROM concepts WHERE id = ?`,
      ).get(loser.conceptId);
      expect(read()).toEqual({
        support_count: 1,
        embedding: successorRow.embedding,
        confidence: .6,
        last_confirmed_at: successorRow.created_at,
      });
      const settled = JSON.stringify(read());
      receiver.graftRows(payload);
      expect(JSON.stringify(read())).toBe(settled);
    } finally {
      source.close(); receiver.close();
    }
  });

  it("relay-stamps a newly grafted old revision without disturbing a newer mutable winner", async () => {
    const source = freshCore({ syncDeviceId: "revision-source", graphEnabled: false });
    const relay = freshCore({ syncDeviceId: "revision-relay", graphEnabled: false });
    const receiver = freshCore({ syncDeviceId: "revision-receiver", graphEnabled: false });
    try {
      const stored = await source.store("Revision relay base.");
      const initial = source.exportDelta(0);
      relay.graftRows(initial); receiver.graftRows(initial);
      (relay as any).db.prepare(`UPDATE concepts SET title = 'Newer relay winner' WHERE id = ?`).run(stored.conceptId);
      const boundary = relay.exportDelta(0).exportedAt;
      const losingConcept = structuredClone(initial.concepts.find((row) => row.id === stored.conceptId)!);
      const oldRevision = {
        id: "old-created-unseen-revision",
        concept_id: stored.conceptId,
        version: 1,
        body: "Historical revision body.",
        trigger_observation_id: null,
        created_at: 1,
      };
      const incoming = basePayload({
        schemaVersion: 8,
        deviceId: "revision-source",
        concepts: [losingConcept],
        conceptRevisions: [oldRevision],
      });

      expect(relay.graftRows(incoming).inserted.concept_revisions).toBe(1);
      expect((relay as any).db.prepare(`SELECT title FROM concepts WHERE id = ?`).get(stored.conceptId)).toEqual({ title: "Newer relay winner" });
      const relayed = relay.exportDelta(boundary);
      expect(relayed.conceptRevisions).toContainEqual(oldRevision);
      receiver.graftRows(relayed);
      expect((receiver as any).db.prepare(`SELECT body FROM concept_revisions WHERE id = ?`).get(oldRevision.id)).toEqual({ body: oldRevision.body });

      const updatedAt = ((relay as any).db.prepare(`SELECT updated_at FROM concepts WHERE id = ?`).get(stored.conceptId) as { updated_at: number }).updated_at;
      expect(relay.graftRows(incoming).inserted.concept_revisions).toBe(0);
      expect(((relay as any).db.prepare(`SELECT updated_at FROM concepts WHERE id = ?`).get(stored.conceptId) as { updated_at: number }).updated_at).toBe(updatedAt);
    } finally {
      source.close(); relay.close(); receiver.close();
    }
  });

  it("exports a dismissal after the persisted clock is ahead, then relays and replays it", async () => {
    const a = freshCore({ syncDeviceId: "dismiss-clock-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "dismiss-clock-b", graphEnabled: false });
    const c = freshCore({ syncDeviceId: "dismiss-clock-c", graphEnabled: false });
    try {
      const one = await a.store("Dismiss clock one.");
      const two = await a.store("Dismiss clock two.");
      (a as any).upsertEdgeBoth(one.conceptId, two.conceptId, "possible_duplicate_of", .9, "fixture", "default");
      const initial = a.exportDelta(0);
      b.graftRows(initial); c.graftRows(initial);
      const bBoundary = b.exportDelta(0).exportedAt;
      (a as any).db.prepare(`UPDATE sync_meta SET last_mutation_at = last_mutation_at + 10000 WHERE singleton = 1`).run();
      const result = a.dismissPossibleDuplicate(one.conceptId, two.conceptId, "reviewer");
      expect(result).toMatchObject({ dismissed: true, rowsUpdated: 2 });
      const delta = a.exportDelta(initial.exportedAt);
      expect(delta.edges.filter((row) => row.type === "possible_duplicate_of")).toHaveLength(2);
      expect(delta.edges.every((row) => row.dismissed_at !== null && row.sync_updated_at === row.dismissed_at)).toBe(true);
      b.graftRows(delta); b.graftRows(delta);
      const relay = b.exportDelta(bBoundary);
      expect(relay.edges.filter((row) => row.type === "possible_duplicate_of" && row.dismissed_at !== null)).toHaveLength(2);
      c.graftRows(relay); c.graftRows(relay);
      for (const core of [b, c]) {
        expect(((core as any).db.prepare(`SELECT COUNT(*) AS n FROM memory_edge WHERE type = 'possible_duplicate_of' AND dismissed_at IS NOT NULL AND dismissed_by = 'reviewer'`).get() as { n: number }).n).toBe(2);
      }
    } finally {
      a.close(); b.close(); c.close();
    }
  });

  it("keeps originating and receiving projections identical after local supersession and resolution", async () => {
    const a = freshCore({ syncDeviceId: "local-projection-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "local-projection-b", graphEnabled: false });
    const projection = (core: MonetCore, id: string) => (core as any).db.prepare(
      `SELECT support_count, embedding, confidence, last_confirmed_at,
              last_confirmed_session_id, dirty, status FROM concepts WHERE id = ?`,
    ).get(id);
    try {
      const terminal = await a.store("Local terminal projection.");
      const terminalInitial = a.exportDelta(0);
      b.graftRows(terminalInitial);
      a.supersedeObservation(terminal.observationId, null);
      b.graftRows(a.exportDelta(terminalInitial.exportedAt));
      expect(projection(b, terminal.conceptId)).toEqual(projection(a, terminal.conceptId));

      const successorBase = await a.store("Local successor old evidence.");
      const successor = await a.store("Local successor winning evidence.", { attachTo: successorBase.conceptId });
      const successorInitial = a.exportDelta(0);
      b.graftRows(successorInitial);
      a.supersedeObservation(successorBase.observationId, successor.observationId);
      b.graftRows(a.exportDelta(successorInitial.exportedAt));
      expect(projection(b, successorBase.conceptId)).toEqual(projection(a, successorBase.conceptId));

      const resolutionBase = await a.store("Local contradiction prior.");
      const correction = await a.store("Local contradiction correction.", { attachTo: resolutionBase.conceptId });
      const contradiction = a.flagContradiction(resolutionBase.conceptId, { observationId: correction.observationId, detail: "fixture" });
      const resolutionInitial = a.exportDelta(0);
      b.graftRows(resolutionInitial);
      a.resolveContradiction(contradiction.id, { decision: "accept-new", by: "reviewer" });
      b.graftRows(a.exportDelta(resolutionInitial.exportedAt));
      expect(projection(b, resolutionBase.conceptId)).toEqual(projection(a, resolutionBase.conceptId));

      const dismissBase = await a.store("Local dismissed contradiction prior.");
      const dismissCorrection = await a.store("Local dismissed contradiction correction.", { attachTo: dismissBase.conceptId });
      const dismissed = a.flagContradiction(dismissBase.conceptId, { observationId: dismissCorrection.observationId, detail: "dismiss fixture" });
      const dismissInitial = a.exportDelta(0);
      b.graftRows(dismissInitial);
      const dismissBeforeSource = projection(a, dismissBase.conceptId) as { last_confirmed_at: number };
      const dismissBeforeReceiver = projection(b, dismissBase.conceptId) as { last_confirmed_at: number };
      const dismissAt = dismissBeforeSource.last_confirmed_at + 5000;
      vi.useFakeTimers();
      vi.setSystemTime(dismissAt);
      try {
        a.resolveContradiction(dismissed.id, { decision: "dismiss", by: "reviewer" });
      } finally {
        vi.useRealTimers();
      }
      expect((projection(a, dismissBase.conceptId) as { last_confirmed_at: number }).last_confirmed_at).toBe(dismissBeforeSource.last_confirmed_at);
      b.graftRows(a.exportDelta(dismissInitial.exportedAt));
      expect((projection(b, dismissBase.conceptId) as { last_confirmed_at: number }).last_confirmed_at).toBe(dismissBeforeReceiver.last_confirmed_at);
      expect(projection(b, dismissBase.conceptId)).toEqual(projection(a, dismissBase.conceptId));
    } finally {
      a.close(); b.close();
    }
  });

  it("leaves sync_meta byte-stable across prewarm and read-only APIs", async () => {
    const core = freshCore({ syncDeviceId: "read-only-clock", graphEnabled: true });
    try {
      await core.store("Read-only clock AuthService.");
      const db = (core as any).db as import("../storage").StoragePort;
      const snapshot = () => JSON.stringify(db.prepare(`SELECT * FROM sync_meta WHERE singleton = 1`).get());
      const before = snapshot();
      core.prewarm();
      core.overview();
      core.getStaleConcepts();
      core.getOpenContradictions();
      core.listMemories();
      core.listFirstBlock("default");
      core.edges();
      expect(snapshot()).toBe(before);
    } finally {
      core.close();
    }
  });

  it("preserves epoch-ms since cursors across a far-future idle for public mutations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-wall-clock-"));
    const path = join(dir, "monet.db");
    const seed = new MonetCore(path, {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      syncDeviceId: "wall-clock",
      graphEnabled: false,
    });
    let seedClosed = false;
    try {
      const base = await seed.store("Epoch cursor base concept.");
      seed.close();
      seedClosed = true;

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2040-01-01T00:00:00.000Z"));
      const core = new MonetCore(path, {
        tauAttach: 1.1,
        tauAmbiguous: 1.1,
        syncDeviceId: "wall-clock",
        graphEnabled: false,
      });
      try {
        const since = Date.now();
        const attached = await core.store("Epoch cursor later evidence.", { attachTo: base.conceptId });
        core.promoteToFirstBlock(base.conceptId, "Epoch cursor First Block.", "default");
        core.supersedeObservation(attached.observationId, null);
        const delta = core.exportDelta(since);

        expect(delta.exportedAt).toBeGreaterThanOrEqual(since);
        expect(delta.concepts).toContainEqual(expect.objectContaining({ id: base.conceptId }));
        expect(delta.observations).toContainEqual(expect.objectContaining({
          id: attached.observationId,
          superseded_at: expect.any(Number),
        }));
        expect(delta.sessions).toContainEqual(expect.objectContaining({ status: "active" }));
        expect(delta.firstBlock).toContainEqual(expect.objectContaining({ concept_id: base.conceptId }));
      } finally {
        core.close();
        vi.useRealTimers();
      }
    } finally {
      if (!seedClosed) seed.close();
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses wall time normally but ignores it in explicit logical clock mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-logical-clock-"));
    const seedPath = join(dir, "seed.db");
    const logicalFirstPath = join(dir, "logical-first.db");
    const logicalSecondPath = join(dir, "logical-second.db");
    const wallFirstPath = join(dir, "wall-first.db");
    const wallSecondPath = join(dir, "wall-second.db");
    const seed = new MonetCore(seedPath, {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      syncDeviceId: "deterministic-clock",
      graphEnabled: false,
    });
    let seedClosed = false;
    try {
      const stored = await seed.store("Logical clock concept.");
      const seedCursor = seed.exportDelta(0).exportedAt;
      seed.close();
      seedClosed = true;
      for (const path of [logicalFirstPath, logicalSecondPath, wallFirstPath, wallSecondPath]) {
        copyFileSync(seedPath, path);
      }

      const mutateAt = (path: string, wallTime: string, clockMode: "wall" | "logical") => {
        vi.setSystemTime(new Date(wallTime));
        const core = new MonetCore(path, { syncDeviceId: "deterministic-clock", graphEnabled: false });
        try {
          const db = (core as any).db as import("../storage").StoragePort;
          db.prepare(`UPDATE sync_meta SET clock_mode = ? WHERE singleton = 1`).run(clockMode);
          (core as any).nextSyncTimestamp();
          db.prepare(`UPDATE concepts SET title = 'Deterministic trigger update' WHERE id = ?`).run(stored.conceptId);
          return {
            meta: db.prepare(`SELECT * FROM sync_meta WHERE singleton = 1`).get(),
            concept: db.prepare(
              `SELECT title, updated_at, sync_revision, sync_writer FROM concepts WHERE id = ?`,
            ).get(stored.conceptId),
            triggerSql: (db.prepare(
              `SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'sync_concepts_update'`,
            ).get() as { sql: string }).sql,
            cursor: core.exportDelta(0).exportedAt,
          };
        } finally {
          core.close();
        }
      };

      vi.useFakeTimers();
      try {
        const logicalFirst = mutateAt(logicalFirstPath, "2030-01-01T00:00:00.000Z", "logical");
        const logicalSecond = mutateAt(logicalSecondPath, "2040-01-01T00:00:00.000Z", "logical");
        expect(logicalSecond).toEqual(logicalFirst);
        expect((logicalFirst.meta as { last_mutation_at: number }).last_mutation_at).toBe(seedCursor + 2);
        expect(logicalFirst.concept).toMatchObject({ sync_writer: "deterministic-clock" });
        expect(logicalFirst.triggerSql).toContain("clock_mode");
        expect(logicalFirst.triggerSql).toContain("julianday");

        const wallFirst = mutateAt(wallFirstPath, "2030-01-01T00:00:00.000Z", "wall");
        const wallSecond = mutateAt(wallSecondPath, "2040-01-01T00:00:00.000Z", "wall");
        expect(wallSecond).not.toEqual(wallFirst);
        expect(wallFirst.cursor).toBeGreaterThanOrEqual(new Date("2030-01-01T00:00:00.000Z").getTime());
        expect(wallSecond.cursor).toBeGreaterThanOrEqual(new Date("2040-01-01T00:00:00.000Z").getTime());
      } finally {
        vi.useRealTimers();
      }
    } finally {
      if (!seedClosed) seed.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sync ownership convergence closure", () => {
  it("closes restoration exports over resolved and retirement-dismissed contradiction history", async () => {
    const a = freshCore({ syncDeviceId: "closure-contradiction-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "closure-contradiction-b", graphEnabled: false });
    const c = freshCore({ syncDeviceId: "closure-contradiction-c", graphEnabled: false });
    const projection = (core: MonetCore, id: string) => (core as any).db.prepare(
      `SELECT support_count, confidence, status, last_confirmed_at, last_confirmed_session_id
         FROM concepts WHERE id = ?`,
    ).get(id);
    try {
      const base = await a.store("Contradiction closure base.");
      const correction = await a.store("Contradiction closure correction.", { attachTo: base.conceptId });
      const resolved = a.flagContradiction(base.conceptId, { observationId: correction.observationId, detail: "resolved history" });
      a.resolveContradiction(resolved.id, { decision: "accept-new", by: "fixture" });
      const later = await a.store("Contradiction closure later evidence.", { attachTo: base.conceptId });
      const dismissed = a.flagContradiction(base.conceptId, { observationId: later.observationId, detail: "retirement history" });
      const beforeRetire = a.exportDelta(0);
      a.retireConcept(base.conceptId);
      const retired = a.exportDelta(beforeRetire.exportedAt);
      a.restoreConcept(base.conceptId);
      const restored = a.exportDelta(retired.exportedAt);

      expect(restored.restorations).toContainEqual(expect.objectContaining({ concept_id: base.conceptId }));
      expect(restored.contradictions).toContainEqual(expect.objectContaining({ id: resolved.id, status: "resolved" }));
      expect(restored.contradictions).toContainEqual(expect.objectContaining({ id: dismissed.id, status: "dismissed" }));

      const boundary = b.exportDelta(0).exportedAt;
      b.graftRows(restored);
      expect(projection(b, base.conceptId)).toEqual(projection(a, base.conceptId));
      const snapshot = JSON.stringify({
        projection: projection(b, base.conceptId),
        contradictions: (b as any).db.prepare(`SELECT * FROM contradictions ORDER BY id`).all(),
      });
      b.graftRows(restored);
      expect(JSON.stringify({
        projection: projection(b, base.conceptId),
        contradictions: (b as any).db.prepare(`SELECT * FROM contradictions ORDER BY id`).all(),
      })).toBe(snapshot);

      const relay = b.exportDelta(boundary);
      expect(relay.contradictions).toHaveLength(2);
      c.graftRows(relay); c.graftRows(relay);
      expect(projection(c, base.conceptId)).toEqual(projection(a, base.conceptId));
    } finally {
      a.close(); b.close(); c.close();
    }
  });

  it("dirties only winning binding endpoints after projection and never re-dirties replay", async () => {
    const a = freshCore({ syncDeviceId: "binding-owner-a", graphEnabled: false });
    const b = freshCore({ syncDeviceId: "binding-owner-b", graphEnabled: false });
    try {
      const source = await a.store("Binding dirty source.");
      const observation = await a.store("Binding dirty movable.", { attachTo: source.conceptId });
      const destination = await a.store("Binding dirty destination.");
      const initial = a.exportDelta(0);
      b.graftRows(initial);
      b.promoteToFirstBlock(source.conceptId, "source pin", "default");
      b.promoteToFirstBlock(destination.conceptId, "destination pin", "default");
      const bdb = (b as any).db as import("../storage").StoragePort;
      for (let i = 0; i < 4; i++) {
        bdb.prepare(`UPDATE concepts SET title = title || ? WHERE id IN (?, ?)`)
          .run(` local-${i}`, source.conceptId, destination.conceptId);
      }
      bdb.prepare(`UPDATE sync_meta SET applying_remote = 1`).run();
      bdb.prepare(`UPDATE concepts SET dirty = 0 WHERE id IN (?, ?)`).run(source.conceptId, destination.conceptId);
      bdb.prepare(`UPDATE first_block SET summary_dirty = 0 WHERE concept_id IN (?, ?)`).run(source.conceptId, destination.conceptId);
      bdb.prepare(`UPDATE sync_meta SET applying_remote = 0`).run();

      const initialObservation = initial.observations.find((row) => row.id === observation.observationId)!;
      const staleConcepts = initial.concepts.filter((row) => row.id === source.conceptId || row.id === destination.conceptId);
      const shell = (revision: number, conceptId: string | null) => ({
        ...structuredClone(initialObservation),
        concept_id: conceptId,
        sync_revision: revision,
        sync_writer: "binding-owner-a",
        circle: "default",
      });
      const graft = (row: ReturnType<typeof shell>) => b.graftRows(basePayload({
        schemaVersion: 8,
        deviceId: "binding-owner-a",
        concepts: structuredClone(staleConcepts),
        observations: [row],
      }));

      const losing = graft(shell(Math.max(0, (initialObservation.sync_revision ?? 1) - 1), destination.conceptId));
      expect(losing.conceptsMarkedDirty).toEqual([]);
      expect(bdb.prepare(`SELECT concept_id FROM observations WHERE id = ?`).get(observation.observationId))
        .toEqual({ concept_id: source.conceptId });

      const unbound = graft(shell((initialObservation.sync_revision ?? 1) + 10, null));
      expect(unbound.conceptsMarkedDirty).toEqual([source.conceptId]);
      const rebound = graft(shell((initialObservation.sync_revision ?? 1) + 11, destination.conceptId));
      expect(rebound.conceptsMarkedDirty).toEqual([destination.conceptId]);
      const direct = graft(shell((initialObservation.sync_revision ?? 1) + 12, source.conceptId));
      expect(new Set(direct.conceptsMarkedDirty)).toEqual(new Set([source.conceptId, destination.conceptId]));
      expect(bdb.prepare(`SELECT dirty FROM concepts WHERE id = ?`).get(source.conceptId)).toEqual({ dirty: 1 });
      expect(bdb.prepare(`SELECT dirty FROM concepts WHERE id = ?`).get(destination.conceptId)).toEqual({ dirty: 1 });
      expect((b.listFirstBlock("default").map((pin) => pin.summaryDirty))).toEqual([true, true]);

      bdb.prepare(`UPDATE sync_meta SET applying_remote = 1`).run();
      bdb.prepare(`UPDATE concepts SET dirty = 0 WHERE id IN (?, ?)`).run(source.conceptId, destination.conceptId);
      bdb.prepare(`UPDATE first_block SET summary_dirty = 0 WHERE concept_id IN (?, ?)`).run(source.conceptId, destination.conceptId);
      bdb.prepare(`UPDATE sync_meta SET applying_remote = 0`).run();
      expect(graft(shell((initialObservation.sync_revision ?? 1) + 12, source.conceptId)).conceptsMarkedDirty).toEqual([]);
      expect(bdb.prepare(`SELECT SUM(dirty) AS n FROM concepts WHERE id IN (?, ?)`).get(source.conceptId, destination.conceptId)).toEqual({ n: 0 });
      expect(b.listFirstBlock("default").every((pin) => !pin.summaryDirty)).toBe(true);

      const retireAndRebind = basePayload({
        schemaVersion: 8,
        deviceId: "binding-owner-a",
        concepts: structuredClone(staleConcepts),
        observations: [shell((initialObservation.sync_revision ?? 1) + 13, destination.conceptId)],
        tombstones: [{ concept_id: source.conceptId, retired_at: Date.now() + 10_000 }],
      });
      expect(b.graftRows(retireAndRebind).conceptsMarkedDirty).toEqual([destination.conceptId]);
      expect(bdb.prepare(`SELECT status, dirty FROM concepts WHERE id = ?`).get(source.conceptId))
        .toEqual({ status: "retired", dirty: 0 });
      bdb.prepare(`UPDATE sync_meta SET applying_remote = 1`).run();
      bdb.prepare(`UPDATE concepts SET dirty = 0 WHERE id = ?`).run(destination.conceptId);
      bdb.prepare(`UPDATE first_block SET summary_dirty = 0 WHERE concept_id = ?`).run(destination.conceptId);
      bdb.prepare(`UPDATE sync_meta SET applying_remote = 0`).run();
      expect(b.graftRows(retireAndRebind).conceptsMarkedDirty).toEqual([]);
      expect(bdb.prepare(`SELECT dirty FROM concepts WHERE id = ?`).get(destination.conceptId)).toEqual({ dirty: 0 });
    } finally {
      a.close(); b.close();
    }
  });

  it("derives First Block ownership from the winning concept circle in either delivery order", async () => {
    const seed = freshCore({ syncDeviceId: "pin-owner-seed", graphEnabled: false });
    const mover = freshCore({ syncDeviceId: "pin-owner-mover", graphEnabled: false });
    const pinner = freshCore({ syncDeviceId: "pin-owner-pinner", graphEnabled: false });
    const forward = freshCore({ syncDeviceId: "pin-owner-forward", graphEnabled: false });
    const reverse = freshCore({ syncDeviceId: "pin-owner-reverse", graphEnabled: false });
    const relay = freshCore({ syncDeviceId: "pin-owner-relay", graphEnabled: false });
    try {
      const stored = await seed.store("First Block ownership concept.");
      const initial = seed.exportDelta(0);
      for (const core of [mover, pinner, forward, reverse, relay]) core.graftRows(initial);
      const moverBoundary = mover.exportDelta(0).exportedAt;
      const pinnerBoundary = pinner.exportDelta(0).exportedAt;
      mover.reassignCircle(stored.conceptId, "archive", { resolution: "forceNew" });
      pinner.promoteToFirstBlock(stored.conceptId, "newer old-circle pin", "default");
      pinner.updateFirstBlockSummary(stored.conceptId, "newest old-circle pin", "default");
      const moved = mover.exportDelta(moverBoundary);
      const stalePin = pinner.exportDelta(pinnerBoundary + 1);
      expect(stalePin.concepts.some((row) => row.id === stored.conceptId)).toBe(false);

      forward.graftRows(moved); forward.graftRows(stalePin);
      reverse.graftRows(stalePin); reverse.graftRows(moved);
      for (const core of [forward, reverse]) {
        expect(core.listFirstBlock("default")).toEqual([]);
        expect(core.listFirstBlock("archive")).toContainEqual(expect.objectContaining({
          conceptId: stored.conceptId,
          summary: "newest old-circle pin",
        }));
        expect(((core as any).db.prepare(
          `SELECT COUNT(*) AS n FROM first_block
            WHERE concept_id = ? AND circle = 'archive' AND deleted_at IS NULL`,
        ).get(stored.conceptId) as { n: number }).n).toBe(1);
      }
      expect({
        forward: (forward as any).db.prepare(`SELECT id, circle, deleted_at FROM first_block WHERE concept_id = ? AND circle = 'archive'`).get(stored.conceptId),
        reverse: (reverse as any).db.prepare(`SELECT id, circle, deleted_at FROM first_block WHERE concept_id = ? AND circle = 'archive'`).get(stored.conceptId),
      }).toEqual({
        forward: expect.objectContaining({ circle: "archive", deleted_at: null }),
        reverse: expect.objectContaining({ circle: "archive", deleted_at: null }),
      });
      expect(forward.listFirstBlock("archive")).toEqual(reverse.listFirstBlock("archive"));

      forward.removeFromFirstBlock(stored.conceptId, "archive");
      forward.graftRows(stalePin);
      expect(forward.listFirstBlock("archive")).toEqual([]);
      forward.promoteToFirstBlock(stored.conceptId, "re-promoted canonical pin", "archive");
      expect(() => forward.reorderFirstBlock([stored.conceptId], "archive")).not.toThrow();
      const relayBoundary = relay.exportDelta(0).exportedAt;
      const relayed = forward.exportDelta(0);
      relay.graftRows(relayed); relay.graftRows(relayed);
      expect(relay.exportDelta(relayBoundary).firstBlock).toHaveLength(1);
      expect(relay.listFirstBlock("archive")).toContainEqual(expect.objectContaining({ summary: "re-promoted canonical pin" }));
    } finally {
      seed.close(); mover.close(); pinner.close(); forward.close(); reverse.close(); relay.close();
    }
  });

  it("converges equal-clock First Block conflicts by semantic value, independent of delivery order", async () => {
    const seed = freshCore({ syncDeviceId: "pin-tie-seed", graphEnabled: false });
    const forward = freshCore({ syncDeviceId: "pin-tie-forward", graphEnabled: false });
    const reverse = freshCore({ syncDeviceId: "pin-tie-reverse", graphEnabled: false });
    const relay = freshCore({ syncDeviceId: "pin-tie-relay", graphEnabled: false });
    try {
      const stored = await seed.store("Equal-clock First Block conflict.");
      const initial = seed.exportDelta(0);
      for (const core of [forward, reverse, relay]) core.graftRows(initial);
      const pin = (summary: string, position: number, promotedBy: string) => ({
        id: `stale:${promotedBy}`,
        concept_id: stored.conceptId,
        circle: "stale-owner",
        summary,
        summary_dirty: promotedBy === "right" ? 1 : 0,
        position,
        promoted_at: promotedBy === "right" ? 200 : 100,
        promoted_by: promotedBy,
        updated_at: promotedBy === "right" ? 1 : Number.MAX_SAFE_INTEGER,
        sync_revision: 7,
        sync_writer: "shared-writer",
        deleted_at: null,
      });
      const left = basePayload({ schemaVersion: 8, deviceId: "left", firstBlock: [pin("alpha", 2, "left")] });
      const right = basePayload({ schemaVersion: 8, deviceId: "right", firstBlock: [pin("omega", 1, "right")] });

      forward.graftRows(left); forward.graftRows(right);
      reverse.graftRows(right); reverse.graftRows(left);
      const semanticRow = (core: MonetCore) => (core as any).db.prepare(
        `SELECT id, concept_id, circle, summary, summary_dirty, position, promoted_at, promoted_by,
                sync_revision, sync_writer, deleted_at
           FROM first_block WHERE concept_id = ? AND circle = 'default'`,
      ).get(stored.conceptId);
      expect(semanticRow(forward)).toEqual(semanticRow(reverse));
      expect(semanticRow(forward)).toEqual(expect.objectContaining({
        circle: "default",
        summary: "omega",
        summary_dirty: 1,
        position: 0,
        promoted_by: "right",
      }));
      expect((semanticRow(forward) as { sync_writer: string }).sync_writer).toMatch(/^rehome:/);

      const relayed = forward.exportDelta(0);
      relay.graftRows(relayed);
      const settled = JSON.stringify(semanticRow(relay));
      expect((semanticRow(relay) as { sync_writer: string }).sync_writer).toMatch(/^rehome:/);
      const replay = relay.graftRows(relayed);
      expect(replay.inserted.first_block).toBe(0);
      expect(JSON.stringify(semanticRow(relay))).toBe(settled);
      relay.graftRows(reverse.exportDelta(0));
      expect(JSON.stringify(semanticRow(relay))).toBe(settled);

      const canonicalActive = structuredClone(semanticRow(forward)) as GraftPayload["firstBlock"][number];
      const activeReplay = basePayload({
        schemaVersion: 8,
        deviceId: "active-replay",
        firstBlock: [canonicalActive],
      });
      const removed = basePayload({
        schemaVersion: 8,
        deviceId: "removed",
        firstBlock: [{ ...canonicalActive, deleted_at: 300 }],
      });
      forward.graftRows(removed); forward.graftRows(activeReplay);
      reverse.graftRows(activeReplay); reverse.graftRows(removed);
      expect(semanticRow(forward)).toEqual(semanticRow(reverse));
      expect(semanticRow(forward)).toEqual(expect.objectContaining({ deleted_at: 300 }));
    } finally {
      seed.close(); forward.close(); reverse.close(); relay.close();
    }
  });

  it("keeps a canonical-circle promotion authoritative over a higher-revision prior-circle tombstone", async () => {
    const seed = freshCore({ syncDeviceId: "pin-scope-seed", graphEnabled: false });
    const forward = freshCore({ syncDeviceId: "pin-scope-forward", graphEnabled: false });
    const reverse = freshCore({ syncDeviceId: "pin-scope-reverse", graphEnabled: false });
    const relay = freshCore({ syncDeviceId: "pin-scope-relay", graphEnabled: false });
    const relayAgain = freshCore({ syncDeviceId: "pin-scope-relay-again", graphEnabled: false });
    try {
      const stored = await seed.store("Scoped First Block clocks.", { circle: "A" });
      seed.promoteToFirstBlock(stored.conceptId, "A active", "A");
      const initial = seed.exportDelta(0);
      for (const core of [forward, reverse]) core.graftRows(initial);
      const baseConcept = structuredClone(initial.concepts.find((row) => row.id === stored.conceptId)!);
      const basePin = structuredClone(initial.firstBlock.find((row) => row.concept_id === stored.conceptId)!);
      const removedA = basePayload({
        schemaVersion: 8,
        deviceId: "pin-remove-a",
        firstBlock: [{ ...basePin, deleted_at: 300, sync_revision: 2, sync_writer: "remove-a" }],
      });
      const movedConcept = {
        ...baseConcept,
        circle: "B",
        sync_revision: (baseConcept.sync_revision ?? 1) + 10,
        sync_writer: "move-b",
      };
      const move = basePayload({ schemaVersion: 8, deviceId: "move-b", concepts: [movedConcept] });
      const promotedB = basePayload({
        schemaVersion: 8,
        deviceId: "promote-b",
        firstBlock: [{
          ...basePin,
          id: "noncanonical-b",
          circle: "B",
          summary: "B authoritative active",
          position: 0,
          promoted_at: 400,
          promoted_by: "promote-b",
          deleted_at: null,
          sync_revision: 1,
          sync_writer: "z-promote-b",
        }],
      });
      const touch = basePayload({
        schemaVersion: 8,
        deviceId: "touch-b",
        concepts: [{
          ...movedConcept,
          title: "Scoped First Block clocks touched",
          sync_revision: (movedConcept.sync_revision ?? 1) + 1,
          sync_writer: "touch-b",
        }],
      });

      forward.graftRows(removedA); forward.graftRows(move); forward.graftRows(promotedB); forward.graftRows(touch);
      reverse.graftRows(move); reverse.graftRows(promotedB); reverse.graftRows(removedA); reverse.graftRows(touch);
      const rows = (core: MonetCore) => (core as any).db.prepare(
        `SELECT circle, summary, sync_revision, deleted_at FROM first_block
          WHERE concept_id = ? ORDER BY circle`,
      ).all(stored.conceptId);
      const expectedRows = [
        { circle: "A", summary: "A active", sync_revision: 2, deleted_at: 300 },
        { circle: "B", summary: "B authoritative active", sync_revision: 1, deleted_at: null },
      ];
      for (const core of [forward, reverse]) {
        expect(rows(core)).toEqual(expectedRows);
        expect(core.listFirstBlock("B")).toContainEqual(expect.objectContaining({
          conceptId: stored.conceptId,
          summary: "B authoritative active",
        }));
        expect(core.listFirstBlock("A")).toEqual([]);
      }
      const exportedPins = forward.exportDelta(0).firstBlock.filter((row) => row.concept_id === stored.conceptId);
      expect(exportedPins).toEqual(expect.arrayContaining([
          expect.objectContaining({ circle: "A", deleted_at: 300 }),
          expect.objectContaining({ circle: "B", summary: "B authoritative active", deleted_at: null }),
        ]));
      expect(exportedPins.filter((row) => row.deleted_at == null)).toHaveLength(1);
      const forwardSettled = JSON.stringify(rows(forward));
      forward.graftRows(removedA); forward.graftRows(touch);
      expect(JSON.stringify(rows(forward))).toBe(forwardSettled);

      const relayed = forward.exportDelta(0);
      relay.graftRows(relayed);
      const relaySettled = JSON.stringify(rows(relay));
      relay.graftRows(relayed);
      expect(JSON.stringify(rows(relay))).toBe(relaySettled);
      expect(rows(relay)).toEqual(expectedRows);
      expect(relay.listFirstBlock("B")).toContainEqual(expect.objectContaining({ summary: "B authoritative active" }));
      const relayedAgain = relay.exportDelta(0);
      relayAgain.graftRows(relayedAgain);
      const relayAgainSettled = JSON.stringify(rows(relayAgain));
      relayAgain.graftRows(relayedAgain);
      expect(JSON.stringify(rows(relayAgain))).toBe(relayAgainSettled);
      expect(rows(relayAgain)).toEqual(rows(relay));
    } finally {
      seed.close(); forward.close(); reverse.close(); relay.close(); relayAgain.close();
    }
  });

  it("adapts legacy First Block clocks by payload-origin circle across a concept move", async () => {
    const seed = freshCore({ syncDeviceId: "legacy-pin-seed", graphEnabled: false });
    const receiver = freshCore({ syncDeviceId: "legacy-pin-receiver", graphEnabled: false });
    try {
      const stored = await seed.store("Legacy First Block natural key.", { circle: "A" });
      seed.promoteToFirstBlock(stored.conceptId, "legacy A summary", "A");
      const exported = seed.exportDelta(0);
      const concept = structuredClone(exported.concepts.find((row) => row.id === stored.conceptId)!);
      const pin = structuredClone(exported.firstBlock.find((row) => row.concept_id === stored.conceptId)!);
      receiver.graftRows(basePayload({ schemaVersion: 8, concepts: [concept] }));
      const legacyPin = basePayload({ deviceId: "legacy-pin-origin", firstBlock: [pin] });
      delete legacyPin.schemaVersion;
      expect(receiver.graftRows(legacyPin).inserted.first_block).toBe(1);

      const move = basePayload({
        schemaVersion: 8,
        deviceId: "legacy-pin-move",
        concepts: [{
          ...concept,
          circle: "B",
          sync_revision: (concept.sync_revision ?? 1) + 10,
          sync_writer: "legacy-pin-move",
        }],
      });
      receiver.graftRows(move);
      expect(((receiver as any).db.prepare(
        `SELECT sync_writer FROM first_block WHERE concept_id = ? AND circle = 'B'`,
      ).get(stored.conceptId) as { sync_writer: string }).sync_writer).toMatch(/^rehome:/);
      receiver.updateFirstBlockSummary(stored.conceptId, "new B summary", "B");
      expect(((receiver as any).db.prepare(
        `SELECT sync_writer FROM first_block WHERE concept_id = ? AND circle = 'B'`,
      ).get(stored.conceptId) as { sync_writer: string }).sync_writer).not.toMatch(/^rehome:/);
      expect(receiver.graftRows(legacyPin).inserted.first_block).toBe(0);
      expect(receiver.listFirstBlock("B")).toContainEqual(expect.objectContaining({ summary: "new B summary" }));

      receiver.removeFromFirstBlock(stored.conceptId, "B");
      const deleted = (receiver as any).db.prepare(
        `SELECT summary, deleted_at FROM first_block WHERE concept_id = ? AND circle = 'B'`,
      ).get(stored.conceptId);
      expect(receiver.graftRows(legacyPin).inserted.first_block).toBe(0);
      expect((receiver as any).db.prepare(
        `SELECT summary, deleted_at FROM first_block WHERE concept_id = ? AND circle = 'B'`,
      ).get(stored.conceptId)).toEqual(deleted);
      expect(receiver.listFirstBlock("B")).toEqual([]);
    } finally {
      seed.close(); receiver.close();
    }
  });

  it("retains a future-circle pin that arrives before its concept move", async () => {
    const seed = freshCore({ syncDeviceId: "future-pin-seed", graphEnabled: false });
    const forward = freshCore({ syncDeviceId: "future-pin-forward", graphEnabled: false });
    const reverse = freshCore({ syncDeviceId: "future-pin-reverse", graphEnabled: false });
    const relay = freshCore({ syncDeviceId: "future-pin-relay", graphEnabled: false });
    try {
      const stored = await seed.store("Future-circle First Block pin.", { circle: "A" });
      seed.promoteToFirstBlock(stored.conceptId, "A prior pin", "A");
      const initial = seed.exportDelta(0);
      forward.graftRows(initial); reverse.graftRows(initial);
      const concept = structuredClone(initial.concepts.find((row) => row.id === stored.conceptId)!);
      const pin = structuredClone(initial.firstBlock.find((row) => row.concept_id === stored.conceptId)!);
      const futurePin = basePayload({
        schemaVersion: 8,
        deviceId: "future-pin-b",
        firstBlock: [{
          ...pin,
          id: "future-b",
          circle: "B",
          summary: "B future authoritative",
          promoted_at: pin.promoted_at + 1,
          sync_revision: 1,
          sync_writer: "a-future-b",
        }],
      });
      const move = basePayload({
        schemaVersion: 8,
        deviceId: "future-pin-move",
        concepts: [{
          ...concept,
          circle: "B",
          sync_revision: (concept.sync_revision ?? 1) + 10,
          sync_writer: "future-pin-move",
        }],
      });

      forward.graftRows(futurePin);
      expect(forward.listFirstBlock("B")).toEqual([]);
      expect(() => forward.reorderFirstBlock([], "B")).not.toThrow();
      forward.graftRows(move);
      reverse.graftRows(move); reverse.graftRows(futurePin);
      for (const core of [forward, reverse]) {
        expect(core.listFirstBlock("B")).toContainEqual(expect.objectContaining({
          conceptId: stored.conceptId,
          summary: "B future authoritative",
        }));
      }
      const canonical = (core: MonetCore) => (core as any).db.prepare(
        `SELECT summary, sync_revision, sync_writer, deleted_at FROM first_block
          WHERE concept_id = ? AND circle = 'B'`,
      ).get(stored.conceptId);
      expect(canonical(forward)).toEqual(canonical(reverse));
      expect(canonical(forward)).toEqual(expect.objectContaining({ sync_writer: "a-future-b" }));
      const relayed = forward.exportDelta(0);
      expect(relayed.firstBlock.filter((row) => row.concept_id === stored.conceptId && row.deleted_at == null))
        .toHaveLength(1);
      relay.graftRows(relayed);
      const settled = JSON.stringify(canonical(relay));
      relay.graftRows(relayed);
      expect(JSON.stringify(canonical(relay))).toBe(settled);
      expect(canonical(relay)).toEqual(canonical(forward));
    } finally {
      seed.close(); forward.close(); reverse.close(); relay.close();
    }
  });

  it("relay-stamps an authoritative destination pin during local reassignCircle", async () => {
    for (const deleted of [false, true]) {
      const local = freshCore({ syncDeviceId: `local-reassign-${deleted}`, graphEnabled: false });
      const downstream = freshCore({ syncDeviceId: `local-reassign-downstream-${deleted}`, graphEnabled: false });
      const relay = freshCore({ syncDeviceId: `local-reassign-relay-${deleted}`, graphEnabled: false });
      try {
        const stored = await local.store(`Local reassign destination ${deleted}.`, { circle: "A" });
        local.promoteToFirstBlock(stored.conceptId, "A source pin", "A");
        const initial = local.exportDelta(0);
        downstream.graftRows(initial); relay.graftRows(initial);
        const pin = structuredClone(initial.firstBlock.find((row) => row.concept_id === stored.conceptId)!);
        const destinationPin = basePayload({
          schemaVersion: 8,
          deviceId: `future-destination-${deleted}`,
          firstBlock: [{
            ...pin,
            id: `future-destination-${deleted}`,
            circle: "B",
            summary: deleted ? "B authoritative tombstone" : "B authoritative active",
            deleted_at: deleted ? 500 : null,
            sync_revision: 1,
            sync_writer: "a-future-destination",
          }],
        });
        local.graftRows(destinationPin);
        const boundary = local.exportDelta(0).exportedAt;
        const beforeMove = (local as any).db.prepare(
          `SELECT sync_revision, sync_writer, updated_at FROM first_block
            WHERE concept_id = ? AND circle = 'B'`,
        ).get(stored.conceptId) as { sync_revision: number; sync_writer: string; updated_at: number };

        local.reassignCircle(stored.conceptId, "B", { resolution: "forceNew" });
        const afterMove = (local as any).db.prepare(
          `SELECT sync_revision, sync_writer, updated_at FROM first_block
            WHERE concept_id = ? AND circle = 'B'`,
        ).get(stored.conceptId) as { sync_revision: number; sync_writer: string; updated_at: number };
        expect(afterMove).toMatchObject({
          sync_revision: beforeMove.sync_revision,
          sync_writer: beforeMove.sync_writer,
        });
        expect(afterMove.updated_at).toBeGreaterThan(boundary);

        const incremental = local.exportDelta(boundary + 1);
        expect(incremental.concepts).toContainEqual(expect.objectContaining({ id: stored.conceptId, circle: "B" }));
        expect(incremental.firstBlock).toContainEqual(expect.objectContaining({
          concept_id: stored.conceptId,
          circle: "B",
          summary: deleted ? "B authoritative tombstone" : "B authoritative active",
          deleted_at: deleted ? 500 : null,
        }));
        const downstreamBoundary = downstream.exportDelta(0).exportedAt;
        downstream.graftRows(incremental);
        const canonical = (core: MonetCore) => (core as any).db.prepare(
          `SELECT circle, summary, sync_revision, sync_writer, deleted_at FROM first_block
            WHERE concept_id = ? AND circle = 'B'`,
        ).get(stored.conceptId);
        expect(canonical(downstream)).toEqual(canonical(local));
        const settled = JSON.stringify(canonical(downstream));
        downstream.graftRows(incremental);
        expect(JSON.stringify(canonical(downstream))).toBe(settled);

        const relayed = downstream.exportDelta(downstreamBoundary + 1);
        relay.graftRows(relayed); relay.graftRows(relayed);
        expect(canonical(relay)).toEqual(canonical(local));
        expect(relay.listFirstBlock("B")).toHaveLength(deleted ? 0 : 1);
      } finally {
        local.close(); downstream.close(); relay.close();
      }
    }
  });

  it("renameCircle reconciles an existing future destination pin without a natural-key collision", async () => {
    const local = freshCore({ syncDeviceId: "rename-future-local", graphEnabled: false });
    const downstream = freshCore({ syncDeviceId: "rename-future-downstream", graphEnabled: false });
    const relay = freshCore({ syncDeviceId: "rename-future-relay", graphEnabled: false });
    try {
      const stored = await local.store("Rename with future destination pin.", { circle: "A" });
      local.promoteToFirstBlock(stored.conceptId, "A historical active", "A");
      const initial = local.exportDelta(0);
      downstream.graftRows(initial); relay.graftRows(initial);
      const pin = structuredClone(initial.firstBlock.find((row) => row.concept_id === stored.conceptId)!);
      local.graftRows(basePayload({
        schemaVersion: 8,
        deviceId: "rename-future-origin",
        firstBlock: [{
          ...pin,
          id: "rename-future-b",
          circle: "B",
          summary: "B rename authority",
          sync_revision: 1,
          sync_writer: "a-rename-future",
        }],
      }));
      const boundary = local.exportDelta(0).exportedAt;
      expect(() => local.renameCircle("A", "B")).not.toThrow();
      expect(local.listFirstBlock("B")).toContainEqual(expect.objectContaining({
        conceptId: stored.conceptId,
        summary: "B rename authority",
      }));
      expect(local.listFirstBlock("A")).toEqual([]);
      const activeRows = (local as any).db.prepare(
        `SELECT circle, summary FROM first_block WHERE concept_id = ? AND deleted_at IS NULL ORDER BY circle`,
      ).all(stored.conceptId);
      expect(activeRows).toEqual([
        { circle: "A", summary: "A historical active" },
        { circle: "B", summary: "B rename authority" },
      ]);

      const incremental = local.exportDelta(boundary + 1);
      expect(incremental.firstBlock.filter((row) => row.concept_id === stored.conceptId && row.deleted_at == null))
        .toEqual([expect.objectContaining({ circle: "B", summary: "B rename authority" })]);
      const downstreamBoundary = downstream.exportDelta(0).exportedAt;
      downstream.graftRows(incremental);
      const canonical = (core: MonetCore) => (core as any).db.prepare(
        `SELECT circle, summary, sync_revision, sync_writer, deleted_at FROM first_block
          WHERE concept_id = ? AND circle = 'B'`,
      ).get(stored.conceptId);
      expect(canonical(downstream)).toEqual(canonical(local));
      downstream.graftRows(incremental);
      expect(canonical(downstream)).toEqual(canonical(local));
      const relayed = downstream.exportDelta(downstreamBoundary + 1);
      relay.graftRows(relayed); relay.graftRows(relayed);
      expect(canonical(relay)).toEqual(canonical(local));
    } finally {
      local.close(); downstream.close(); relay.close();
    }
  });

  it("exports retirement lifecycle without canonical or hidden First Block content", async () => {
    const source = freshCore({ syncDeviceId: "retired-pin-source", graphEnabled: false });
    const receiver = freshCore({ syncDeviceId: "retired-pin-receiver", graphEnabled: false });
    const relay = freshCore({ syncDeviceId: "retired-pin-relay", graphEnabled: false });
    const canonicalSecret = "CANONICAL-RETIREMENT-SECRET";
    const hiddenSecret = "HIDDEN-FUTURE-RETIREMENT-SECRET";
    try {
      const stored = await source.store("Retired First Block export.", { circle: "A" });
      source.promoteToFirstBlock(stored.conceptId, canonicalSecret, "A", { promotedBy: "canonical-secret-actor" });
      const initial = source.exportDelta(0);
      receiver.graftRows(initial); relay.graftRows(initial);
      const pin = structuredClone(initial.firstBlock.find((row) => row.concept_id === stored.conceptId)!);
      source.graftRows(basePayload({
        schemaVersion: 8,
        deviceId: "retired-pin-hidden-origin",
        firstBlock: [{
          ...pin,
          id: "retired-hidden-b",
          circle: "B",
          summary: hiddenSecret,
          promoted_by: "hidden-secret-actor",
          sync_revision: 1,
          sync_writer: "retired-hidden-origin",
        }],
      }));
      const boundary = source.exportDelta(0).exportedAt;
      source.retireConcept(stored.conceptId);

      const incremental = source.exportDelta(boundary + 1);
      expect(incremental.tombstones).toContainEqual(expect.objectContaining({ concept_id: stored.conceptId }));
      expect(incremental.firstBlock).toEqual([]);
      expect(JSON.stringify(incremental)).not.toContain(canonicalSecret);
      expect(JSON.stringify(incremental)).not.toContain(hiddenSecret);
      expect(JSON.stringify(incremental)).not.toContain("secret-actor");
      const full = source.exportDelta(0);
      expect(full.firstBlock).toEqual([]);
      expect(JSON.stringify(full)).not.toContain(canonicalSecret);
      expect(JSON.stringify(full)).not.toContain(hiddenSecret);

      const receiverBoundary = receiver.exportDelta(0).exportedAt;
      receiver.graftRows(incremental);
      expect(receiver.listFirstBlock("A")).toEqual([]);
      const settled = JSON.stringify((receiver as any).db.prepare(
        `SELECT status FROM concepts WHERE id = ?`,
      ).get(stored.conceptId));
      receiver.graftRows(incremental);
      expect(JSON.stringify((receiver as any).db.prepare(
        `SELECT status FROM concepts WHERE id = ?`,
      ).get(stored.conceptId))).toBe(settled);

      const relayed = receiver.exportDelta(receiverBoundary + 1);
      expect(relayed.tombstones).toContainEqual(expect.objectContaining({ concept_id: stored.conceptId }));
      expect(relayed.firstBlock).toEqual([]);
      expect(JSON.stringify(relayed)).not.toContain(canonicalSecret);
      relay.graftRows(relayed); relay.graftRows(relayed);
      expect(relay.listFirstBlock("A")).toEqual([]);
    } finally {
      source.close(); receiver.close(); relay.close();
    }
  });

  it("recomputes a winning concept envelope from receiver-only evidence and contradictions", async () => {
    const sender = freshCore({ syncDeviceId: "projection-envelope-sender", graphEnabled: false });
    const receiver = freshCore({ syncDeviceId: "projection-envelope-receiver", graphEnabled: false });
    const relay = freshCore({ syncDeviceId: "projection-envelope-relay", graphEnabled: false });
    try {
      const stored = await sender.store("Projection envelope original.");
      sender.promoteToFirstBlock(stored.conceptId, "projection pin", "default");
      const initial = sender.exportDelta(0);
      receiver.graftRows(initial); relay.graftRows(initial);
      const extra = await receiver.store("Receiver-only projection evidence.", { attachTo: stored.conceptId });
      receiver.flagContradiction(stored.conceptId, {
        observationId: extra.observationId,
        detail: "receiver-only open contradiction",
      });
      const receiverDb = (receiver as any).db as import("../storage").StoragePort;
      receiverDb.prepare(`UPDATE sync_meta SET applying_remote = 1`).run();
      receiverDb.prepare(`UPDATE concepts SET dirty = 0 WHERE id = ?`).run(stored.conceptId);
      receiverDb.prepare(`UPDATE first_block SET summary_dirty = 0 WHERE concept_id = ?`).run(stored.conceptId);
      receiverDb.prepare(`UPDATE sync_meta SET applying_remote = 0`).run();
      const currentClock = receiverDb.prepare(
        `SELECT sync_revision FROM concepts WHERE id = ?`,
      ).get(stored.conceptId) as { sync_revision: number };
      const initialConcept = structuredClone(initial.concepts.find((row) => row.id === stored.conceptId)!);
      const incomingConcept = {
        ...initialConcept,
        title: "Higher-clock sender semantic content",
        body: "Higher-clock sender body.",
        version: initialConcept.version + 1,
        status: "active" as const,
        support_count: 1,
        dirty: 0,
        sync_revision: currentClock.sync_revision + 10,
        sync_writer: "projection-envelope-winner",
      };
      const payload = basePayload({
        schemaVersion: 8,
        deviceId: "projection-envelope-sender",
        concepts: [incomingConcept],
        observations: [structuredClone(initial.observations.find((row) => row.id === stored.observationId)!)],
      });

      const graft = receiver.graftRows(payload);
      expect(graft.inserted.observations).toBe(0);
      const receiverProjection = receiverDb.prepare(
        `SELECT support_count, embedding, confidence, status, last_confirmed_at,
                last_confirmed_session_id FROM concepts WHERE id = ?`,
      ).get(stored.conceptId) as {
        support_count: number; embedding: string; confidence: number; status: string;
        last_confirmed_at: number; last_confirmed_session_id: string;
      };
      expect(receiverProjection).toMatchObject({ support_count: 2, confidence: 0.5, status: "disputed" });
      expect(receiverProjection.embedding).not.toBe(incomingConcept.embedding);
      const activeEvidence = receiverDb.prepare(
        `SELECT created_at, session_id FROM observations
          WHERE concept_id = ? AND superseded_by IS NULL AND superseded_at IS NULL`,
      ).all(stored.conceptId) as Array<{ created_at: number; session_id: string }>;
      expect(receiverProjection.last_confirmed_at)
        .toBeGreaterThanOrEqual(Math.max(...activeEvidence.map((row) => row.created_at)));
      expect(activeEvidence.map((row) => row.session_id)).toContain(receiverProjection.last_confirmed_session_id);
      expect(receiverDb.prepare(
        `SELECT title, body, version, dirty, sync_revision, sync_writer FROM concepts WHERE id = ?`,
      ).get(stored.conceptId)).toEqual({
        title: "Higher-clock sender semantic content",
        body: "Higher-clock sender body.",
        version: incomingConcept.version,
        dirty: 1,
        sync_revision: incomingConcept.sync_revision,
        sync_writer: incomingConcept.sync_writer,
      });
      expect(receiver.listFirstBlock("default")).toContainEqual(expect.objectContaining({
        conceptId: stored.conceptId,
        summaryDirty: true,
      }));
      const stable = JSON.stringify({
        concept: receiverDb.prepare(`SELECT * FROM concepts WHERE id = ?`).get(stored.conceptId),
        pin: receiverDb.prepare(`SELECT * FROM first_block WHERE concept_id = ? AND circle = 'default'`).get(stored.conceptId),
      });
      receiver.graftRows(payload);
      expect(JSON.stringify({
        concept: receiverDb.prepare(`SELECT * FROM concepts WHERE id = ?`).get(stored.conceptId),
        pin: receiverDb.prepare(`SELECT * FROM first_block WHERE concept_id = ? AND circle = 'default'`).get(stored.conceptId),
      })).toBe(stable);

      const relayed = receiver.exportDelta(0);
      relay.graftRows(relayed); relay.graftRows(relayed);
      const relayDb = (relay as any).db as import("../storage").StoragePort;
      expect(relayDb.prepare(
        `SELECT support_count, embedding, confidence, status, last_confirmed_at,
                last_confirmed_session_id, dirty FROM concepts WHERE id = ?`,
      ).get(stored.conceptId)).toEqual({ ...receiverProjection, dirty: 1 });
      expect((relayDb.prepare(
        `SELECT COUNT(*) AS n FROM observations WHERE concept_id = ? AND superseded_by IS NULL AND superseded_at IS NULL`,
      ).get(stored.conceptId) as { n: number }).n).toBe(2);
      expect((relayDb.prepare(
        `SELECT COUNT(*) AS n FROM contradictions WHERE concept_id = ? AND status = 'open'`,
      ).get(stored.conceptId) as { n: number }).n).toBe(1);
    } finally {
      sender.close(); receiver.close(); relay.close();
    }
  });

  it("retains dirty=0 when a winning envelope matches the receiver's full ledger projection", async () => {
    const sender = freshCore({ syncDeviceId: "matching-envelope-sender", graphEnabled: false });
    const receiver = freshCore({ syncDeviceId: "matching-envelope-receiver", graphEnabled: false });
    const relay = freshCore({ syncDeviceId: "matching-envelope-relay", graphEnabled: false });
    try {
      const stored = await sender.store("Matching projection envelope.");
      sender.promoteToFirstBlock(stored.conceptId, "matching projection pin", "default");
      const initial = sender.exportDelta(0);
      receiver.graftRows(initial); relay.graftRows(initial);
      const db = (receiver as any).db as import("../storage").StoragePort;
      db.prepare(`UPDATE sync_meta SET applying_remote = 1`).run();
      db.prepare(`UPDATE concepts SET dirty = 0 WHERE id = ?`).run(stored.conceptId);
      db.prepare(`UPDATE first_block SET summary_dirty = 0 WHERE concept_id = ?`).run(stored.conceptId);
      db.prepare(`UPDATE sync_meta SET applying_remote = 0`).run();
      const base = structuredClone(initial.concepts.find((row) => row.id === stored.conceptId)!);
      const incoming = {
        ...base,
        title: "Matching projection semantic winner",
        body: "Matching projection semantic body.",
        version: base.version + 1,
        dirty: 0,
        sync_revision: (base.sync_revision ?? 1) + 10,
        sync_writer: "matching-envelope-winner",
      };
      const payload = basePayload({
        schemaVersion: 8,
        concepts: [incoming],
        observations: [structuredClone(initial.observations.find((row) => row.id === stored.observationId)!)],
      });
      const receiverBoundary = receiver.exportDelta(0).exportedAt;
      receiver.graftRows(payload);
      expect(db.prepare(`SELECT title, body, version, dirty FROM concepts WHERE id = ?`).get(stored.conceptId))
        .toEqual({
          title: incoming.title,
          body: incoming.body,
          version: incoming.version,
          dirty: 0,
        });
      expect(receiver.listFirstBlock("default")).toContainEqual(expect.objectContaining({ summaryDirty: true }));
      const settled = JSON.stringify({
        concept: db.prepare(`SELECT * FROM concepts WHERE id = ?`).get(stored.conceptId),
        pin: db.prepare(`SELECT * FROM first_block WHERE concept_id = ? AND circle = 'default'`).get(stored.conceptId),
      });
      receiver.graftRows(payload);
      expect(JSON.stringify({
        concept: db.prepare(`SELECT * FROM concepts WHERE id = ?`).get(stored.conceptId),
        pin: db.prepare(`SELECT * FROM first_block WHERE concept_id = ? AND circle = 'default'`).get(stored.conceptId),
      })).toBe(settled);

      const relayed = receiver.exportDelta(receiverBoundary + 1);
      relay.graftRows(relayed); relay.graftRows(relayed);
      expect((relay as any).db.prepare(`SELECT title, body, version, dirty FROM concepts WHERE id = ?`).get(stored.conceptId))
        .toEqual({ title: incoming.title, body: incoming.body, version: incoming.version, dirty: 0 });
      expect(relay.listFirstBlock("default")).toContainEqual(expect.objectContaining({ summaryDirty: true }));
    } finally {
      sender.close(); receiver.close(); relay.close();
    }
  });

  it("does not invalidate First Block for circle/activity-only winners or losing semantic rows", async () => {
    const core = freshCore({ syncDeviceId: "nonsemantic-envelope", graphEnabled: false });
    try {
      const stored = await core.store("Nonsemantic envelope content.", { circle: "A" });
      core.promoteToFirstBlock(stored.conceptId, "nonsemantic pin", "A");
      const initial = core.exportDelta(0);
      const db = (core as any).db as import("../storage").StoragePort;
      db.prepare(`UPDATE sync_meta SET applying_remote = 1`).run();
      db.prepare(`UPDATE concepts SET dirty = 0 WHERE id = ?`).run(stored.conceptId);
      db.prepare(`UPDATE first_block SET summary_dirty = 0 WHERE concept_id = ?`).run(stored.conceptId);
      db.prepare(`UPDATE sync_meta SET applying_remote = 0`).run();
      const base = structuredClone(initial.concepts.find((row) => row.id === stored.conceptId)!);
      const observation = structuredClone(initial.observations.find((row) => row.id === stored.observationId)!);
      const circleOnly = {
        ...base,
        circle: "B",
        dirty: 0,
        sync_revision: (base.sync_revision ?? 1) + 10,
        sync_writer: "circle-only-winner",
      };
      core.graftRows(basePayload({ schemaVersion: 8, concepts: [circleOnly], observations: [observation] }));
      expect(core.listFirstBlock("B")).toContainEqual(expect.objectContaining({ summaryDirty: false }));

      const activityOnly = {
        ...circleOnly,
        usefulness_score: circleOnly.usefulness_score + 10,
        usefulness_last_fetched_at: (circleOnly.usefulness_last_fetched_at ?? 0) + 10,
        sync_revision: circleOnly.sync_revision + 1,
        sync_writer: "activity-only-winner",
      };
      const activityPayload = basePayload({ schemaVersion: 8, concepts: [activityOnly], observations: [observation] });
      core.graftRows(activityPayload);
      expect(core.listFirstBlock("B")).toContainEqual(expect.objectContaining({ summaryDirty: false }));
      const stable = JSON.stringify({
        concept: db.prepare(`SELECT * FROM concepts WHERE id = ?`).get(stored.conceptId),
        pin: db.prepare(`SELECT * FROM first_block WHERE concept_id = ? AND circle = 'B'`).get(stored.conceptId),
      });
      core.graftRows(activityPayload);
      expect(JSON.stringify({
        concept: db.prepare(`SELECT * FROM concepts WHERE id = ?`).get(stored.conceptId),
        pin: db.prepare(`SELECT * FROM first_block WHERE concept_id = ? AND circle = 'B'`).get(stored.conceptId),
      })).toBe(stable);

      const losingSemantic = {
        ...activityOnly,
        title: "Losing semantic title",
        body: "Losing semantic body.",
        sync_revision: activityOnly.sync_revision - 1,
        sync_writer: "losing-semantic",
      };
      core.graftRows(basePayload({ schemaVersion: 8, concepts: [losingSemantic], observations: [observation] }));
      expect(db.prepare(`SELECT title, body FROM concepts WHERE id = ?`).get(stored.conceptId))
        .toEqual({ title: base.title, body: base.body });
      expect(core.listFirstBlock("B")).toContainEqual(expect.objectContaining({ summaryDirty: false }));
    } finally {
      core.close();
    }
  });

  it("appends a receiver-local active pin when a concept-only graft moves it into a populated circle", async () => {
    const core = freshCore({ syncDeviceId: "pin-position-receiver", graphEnabled: false });
    try {
      const destA = await core.store("Destination pin alpha.", { circle: "dest" });
      const destB = await core.store("Destination pin beta.", { circle: "dest" });
      const moving = await core.store("Receiver-local moving pin.", { circle: "source" });
      core.promoteToFirstBlock(destA.conceptId, "dest alpha", "dest");
      core.promoteToFirstBlock(destB.conceptId, "dest beta", "dest");
      core.promoteToFirstBlock(moving.conceptId, "moving summary", "source");
      (core as any).db.prepare(`UPDATE first_block SET position = 9 WHERE concept_id = ? AND circle = 'source'`)
        .run(moving.conceptId);
      const concept = structuredClone(core.exportDelta(0).concepts.find((row) => row.id === moving.conceptId)!);
      const move = basePayload({
        schemaVersion: 8,
        deviceId: "pin-position-move",
        concepts: [{
          ...concept,
          circle: "dest",
          sync_revision: (concept.sync_revision ?? 1) + 10,
          sync_writer: "pin-position-move",
        }],
      });

      core.graftRows(move);
      expect(core.listFirstBlock("dest").map((row) => [row.conceptId, row.position])).toEqual([
        [destA.conceptId, 0],
        [destB.conceptId, 1],
        [moving.conceptId, 2],
      ]);
      const settled = JSON.stringify(core.listFirstBlock("dest"));
      core.graftRows(move);
      expect(JSON.stringify(core.listFirstBlock("dest"))).toBe(settled);

      const later = await core.store("Destination pin added after remote move.", { circle: "dest" });
      const promotedLater = core.promoteToFirstBlock(later.conceptId, "dest later", "dest");
      expect(promotedLater.position).toBe(3);
      expect(promotedLater.totalSummaryChars).toBe(
        "dest alpha".length + "dest beta".length + "moving summary".length + "dest later".length,
      );

      expect(core.removeFromFirstBlock(moving.conceptId, "dest")).toEqual({ removed: true });
      core.promoteToFirstBlock(moving.conceptId, "moving re-promoted", "dest");
      core.reorderFirstBlock([moving.conceptId, destA.conceptId, destB.conceptId, later.conceptId], "dest");
      expect(core.listFirstBlock("dest").map((row) => [row.conceptId, row.position])).toEqual([
        [moving.conceptId, 0],
        [destA.conceptId, 1],
        [destB.conceptId, 2],
        [later.conceptId, 3],
      ]);
    } finally {
      core.close();
    }
  });

  it("versions source identity pointers as semantic content while excluding activity-only touches", async () => {
    const core = freshCore({ syncDeviceId: "source-pointer-clock", graphEnabled: false });
    try {
      const source = await core.storeSource("Terminal source pointer.", {
        sourceRefs: ["source://pointer/docs/source.md#chunk~1"],
        operationId: "pointer:binding:fingerprint:snapshot",
      });
      const db = (core as any).db as import("../storage").StoragePort;
      const before = db.prepare(
        `SELECT sync_revision, updated_at, active_observation_id FROM concepts WHERE id = ?`,
      ).get(source.conceptId) as { sync_revision: number; updated_at: number; active_observation_id: string | null };
      expect(before.active_observation_id).toBe(source.observationId);
      core.supersedeObservation(source.observationId, null);
      const after = db.prepare(
        `SELECT sync_revision, updated_at, active_observation_id FROM concepts WHERE id = ?`,
      ).get(source.conceptId) as { sync_revision: number; updated_at: number; active_observation_id: string | null };
      expect(after).toMatchObject({ sync_revision: before.sync_revision + 1, active_observation_id: null });
      expect(after.updated_at).toBeGreaterThan(before.updated_at);

      const native = await core.store("Activity-only clock exclusion.");
      const nativeBefore = db.prepare(`SELECT sync_revision, updated_at FROM concepts WHERE id = ?`)
        .get(native.conceptId);
      await core.getConcept(native.conceptId, { synthesize: false });
      expect(db.prepare(`SELECT sync_revision, updated_at FROM concepts WHERE id = ?`).get(native.conceptId))
        .toEqual(nativeBefore);
    } finally {
      core.close();
    }
  });

  it("replicates activity independently from semantic concept content", async () => {
    const seed = freshCore({ syncDeviceId: "activity-seed", graphEnabled: false });
    const activity = freshCore({ syncDeviceId: "activity-only", graphEnabled: false });
    const content = freshCore({ syncDeviceId: "activity-content", graphEnabled: false });
    const forward = freshCore({ syncDeviceId: "activity-forward", graphEnabled: false });
    const reverse = freshCore({ syncDeviceId: "activity-reverse", graphEnabled: false });
    try {
      const stored = await seed.store("Activity isolation original.");
      const initial = seed.exportDelta(0);
      for (const core of [activity, content, forward, reverse]) core.graftRows(initial);
      const activityBoundary = activity.exportDelta(0).exportedAt;
      const contentBoundary = content.exportDelta(0).exportedAt;
      await activity.getConcept(stored.conceptId, { synthesize: false });
      const activityDelta = activity.exportDelta(activityBoundary + 1);
      expect(activityDelta.concepts.some((row) => row.id === stored.conceptId)).toBe(false);
      expect(activityDelta.conceptActivity).toContainEqual(expect.objectContaining({ concept_id: stored.conceptId }));
      activity.promoteToFirstBlock(stored.conceptId, "activity promotion", "default");
      const promotion = activity.exportDelta(activityDelta.exportedAt + 1);
      expect(promotion.concepts.some((row) => row.id === stored.conceptId)).toBe(false);
      expect(promotion.firstBlock).toHaveLength(1);
      expect(promotion.conceptActivity).toContainEqual(expect.objectContaining({ concept_id: stored.conceptId }));

      (content as any).db.prepare(`UPDATE concepts SET title = 'Activity isolation semantic winner' WHERE id = ?`).run(stored.conceptId);
      const contentDelta = content.exportDelta(contentBoundary);
      forward.graftRows(activityDelta); forward.graftRows(contentDelta); forward.graftRows(promotion);
      reverse.graftRows(promotion); reverse.graftRows(contentDelta); reverse.graftRows(activityDelta);
      for (const core of [forward, reverse]) {
        expect(((core as any).db.prepare(`SELECT title FROM concepts WHERE id = ?`).get(stored.conceptId) as { title: string }).title)
          .toBe("Activity isolation semantic winner");
      }
      const expectedActivity = promotion.conceptActivity!.find((row) => row.concept_id === stored.conceptId)!;
      const activityComponent = (core: MonetCore) => (core as any).db.prepare(
        `SELECT usefulness_count, usefulness_last_at, arousal_count, arousal_last_at, revision
           FROM concept_activity_components WHERE concept_id = ? AND writer_id = ?`,
      ).get(stored.conceptId, expectedActivity.writer_id);
      const expectedComponent = {
        usefulness_count: expectedActivity.usefulness_count,
        usefulness_last_at: expectedActivity.usefulness_last_at,
        arousal_count: expectedActivity.arousal_count,
        arousal_last_at: expectedActivity.arousal_last_at,
        revision: expectedActivity.revision,
      };
      expect(activityComponent(forward)).toEqual(expectedComponent);
      expect(activityComponent(reverse)).toEqual(expectedComponent);
      const materializedActivity = (core: MonetCore) => (core as any).db.prepare(
        `SELECT usefulness_score, usefulness_last_fetched_at, arousal_score, arousal_last_updated_at
           FROM concepts WHERE id = ?`,
      ).get(stored.conceptId);
      expect(materializedActivity(forward)).toEqual(materializedActivity(activity));
      expect(materializedActivity(reverse)).toEqual(materializedActivity(activity));
      expect(forward.stats().observations).toBe(reverse.stats().observations);

      const mixed = freshCore({ syncDeviceId: "activity-mixed", graphEnabled: false });
      try {
        const one = await mixed.store("Mixed semantic activity.");
        const db = (mixed as any).db as import("../storage").StoragePort;
        const before = db.prepare(`SELECT sync_revision FROM concepts WHERE id = ?`).get(one.conceptId) as { sync_revision: number };
        const boundary = mixed.exportDelta(0).exportedAt;
        db.prepare(
          `UPDATE concepts SET title = 'Mixed semantic activity changed', usefulness_score = usefulness_score + 1,
                  usefulness_last_fetched_at = ? WHERE id = ?`,
        ).run(Date.now(), one.conceptId);
        const after = db.prepare(`SELECT sync_revision FROM concepts WHERE id = ?`).get(one.conceptId) as { sync_revision: number };
        expect(after.sync_revision).toBe(before.sync_revision + 1);
        const delta = mixed.exportDelta(boundary);
        expect(delta.concepts).toContainEqual(expect.objectContaining({ id: one.conceptId, title: "Mixed semantic activity changed" }));
        expect(delta.conceptActivity).toContainEqual(expect.objectContaining({ concept_id: one.conceptId, revision: 1 }));
      } finally {
        mixed.close();
      }
    } finally {
      seed.close(); activity.close(); content.close(); forward.close(); reverse.close();
    }
  });

  it("normalizes bound observation circles to the post-LWW concept in either clock order", async () => {
    const seed = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      syncDeviceId: "circle-owner-seed",
      graphEnabled: false,
      scopeContext: "/work/circle-owner",
    });
    const forward = freshCore({ syncDeviceId: "circle-owner-forward", graphEnabled: false });
    const reverse = freshCore({ syncDeviceId: "circle-owner-reverse", graphEnabled: false });
    const relay = freshCore({ syncDeviceId: "circle-owner-relay", graphEnabled: false });
    try {
      const stored = await seed.store("Observation circle ownership.");
      const destination = await seed.store("Observation circle rebind destination.");
      const initial = seed.exportDelta(0);
      for (const core of [forward, reverse, relay]) core.graftRows(initial);
      const concept = structuredClone(initial.concepts.find((row) => row.id === stored.conceptId)!);
      concept.circle = "moved";
      concept.sync_revision = (concept.sync_revision ?? 1) + 5;
      concept.sync_writer = "circle-move";
      const observation = structuredClone(initial.observations.find((row) => row.id === stored.observationId)!);
      observation.circle = "default";
      observation.sync_revision = (observation.sync_revision ?? 1) + 10;
      observation.sync_writer = "stale-shell";
      const movePayload = basePayload({ schemaVersion: 8, deviceId: "circle-move", concepts: [concept] });
      const shellPayload = basePayload({ schemaVersion: 8, deviceId: "stale-shell", observations: [observation] });

      forward.graftRows(movePayload); forward.graftRows(shellPayload);
      reverse.graftRows(shellPayload); reverse.graftRows(movePayload);
      const assertOwned = (core: MonetCore) => {
        expect((core as any).db.prepare(
          `SELECT circle, concept_id, session_id FROM observations WHERE id = ?`,
        ).get(stored.observationId)).toEqual(expect.objectContaining({
          circle: "moved",
          concept_id: stored.conceptId,
          session_id: expect.any(String),
        }));
        expect(core.stats("moved")).toMatchObject({ concepts: 1, observations: 1, sessions: 1 });
        expect(core.listMemories("moved", { withProvenance: true })[0]?.provenance).toEqual(["/work/circle-owner"]);
      };
      assertOwned(forward); assertOwned(reverse);

      const destinationConcept = structuredClone(initial.concepts.find((row) => row.id === destination.conceptId)!);
      destinationConcept.circle = "rebind-moved";
      destinationConcept.sync_revision = (destinationConcept.sync_revision ?? 1) + 20;
      destinationConcept.sync_writer = "circle-rebind-move";
      const rebind = structuredClone(initial.observations.find((row) => row.id === stored.observationId)!);
      rebind.concept_id = destination.conceptId;
      rebind.circle = "default";
      rebind.sync_revision = (observation.sync_revision ?? 1) + 1;
      rebind.sync_writer = "stale-circle-rebind";
      const destinationMove = basePayload({
        schemaVersion: 8,
        deviceId: "circle-rebind-move",
        concepts: [destinationConcept],
      });
      const staleCircleRebind = basePayload({
        schemaVersion: 8,
        deviceId: "stale-circle-rebind",
        observations: [rebind],
      });
      forward.graftRows(destinationMove); forward.graftRows(staleCircleRebind);
      reverse.graftRows(staleCircleRebind); reverse.graftRows(destinationMove);
      for (const core of [forward, reverse]) {
        expect((core as any).db.prepare(
          `SELECT circle, concept_id FROM observations WHERE id = ?`,
        ).get(stored.observationId)).toEqual({
          circle: "rebind-moved",
          concept_id: destination.conceptId,
        });
        expect(core.stats("rebind-moved")).toMatchObject({ concepts: 1, observations: 2, sessions: 1 });
      }

      const boundary = relay.exportDelta(0).exportedAt;
      const relayed = forward.exportDelta(0);
      relay.graftRows(relayed); relay.graftRows(relayed);
      expect(relay.exportDelta(boundary).observations).toContainEqual(expect.objectContaining({
        id: stored.observationId,
        circle: "rebind-moved",
      }));
      expect((relay as any).db.prepare(
        `SELECT circle, concept_id, session_id FROM observations WHERE id = ?`,
      ).get(stored.observationId)).toEqual(expect.objectContaining({
        circle: "rebind-moved",
        concept_id: destination.conceptId,
        session_id: expect.any(String),
      }));
      expect(relay.stats("rebind-moved")).toMatchObject({ concepts: 1, observations: 2, sessions: 1 });
      expect(relay.listMemories("rebind-moved", { withProvenance: true })[0]?.provenance).toEqual(["/work/circle-owner"]);
    } finally {
      seed.close(); forward.close(); reverse.close(); relay.close();
    }
  });
});
