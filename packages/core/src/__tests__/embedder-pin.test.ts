/**
 * embedder-pin ADR, slice 1 — pin storage (Task 2) and open-time enforcement + backfill (Task 4).
 *
 * The store PINS its embedder (sync_meta.embedder_model_id/embedder_pin_source/embedder_pinned_at);
 * MonetCore.ensureEmbedderPin() enforces it. These tests cover the closure matrix from the brief:
 * fresh (1), pre-pin ONNX legacy (2), pre-pin hashing legacy (3), empty (4), steady state (6),
 * legacy declined (7), unsatisfiable (9), and the graft-rejection interaction.
 *
 * All stores are :memory: or a mkdtemp'd temp file — never ~/.monet. No test performs a real ONNX
 * load: Shape 2 injects a fake embedderLoader (per the brief, ONNX satisfaction may be
 * faked/injected — the assertion is the pin decision); every other shape either uses hashing for
 * real (no network) or never reaches instantiation at all (Shape 9's unrecognized-format case).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  MonetCore,
  EmbedderMismatchError,
  EmbedderPinUnsatisfiedError,
  EmbedderWidthConflictError,
  EmbedderOutputDimensionError,
  EmbedderIdentityRequiredError,
  MalformedEmbeddingStoreError,
  EmbedderMigrationIncompleteError,
  EmbedderMigrationAbandonRefusedError,
  EmbedderMigrationAbandonUnsupportedError,
} from "../engine";
import { HashingEmbeddingProvider, cosine, type EmbeddingProvider, type EmbeddingThresholds } from "../embedding";
import { UnsatisfiableEmbedderError, LEGACY_ONNX_DEFAULT_MODEL_ID } from "../embedding-onnx";
import { createMonetCoreMcpServer } from "../mcp-server";

interface PinRow {
  embedder_model_id: string | null;
  embedder_pin_source: string | null;
  embedder_pinned_at: number | null;
}

/** White-box helpers, matching this codebase's established `(core as any).db` test convention
 *  (see sync.test.ts) — MonetCore has no public pin-inspection API, by design (the pin is an
 *  internal invariant the engine enforces, not something callers are meant to poke at). */
function readPin(core: MonetCore): PinRow {
  return (core as any).db.prepare(`SELECT embedder_model_id, embedder_pin_source, embedder_pinned_at FROM sync_meta WHERE singleton = 1`).get();
}

function writePin(core: MonetCore, modelId: string, source: "created" | "backfilled" | "migrated" = "backfilled"): void {
  (core as any).db
    .prepare(`UPDATE sync_meta SET embedder_model_id = ?, embedder_pin_source = ?, embedder_pinned_at = ? WHERE singleton = 1`)
    .run(modelId, source, Date.now());
}

function clearPin(core: MonetCore): void {
  (core as any).db.prepare(`UPDATE sync_meta SET embedder_model_id = NULL, embedder_pin_source = NULL, embedder_pinned_at = NULL WHERE singleton = 1`).run();
}

/** Fabricates an interrupted-migration sentinel directly (the embedder_migration singleton row) —
 *  mirrors beginEmbedderMigration's own INSERT exactly, without going through the real
 *  preflight/lock/writeMigratedEmbedderPin machinery. Used alongside writePin(..., "migrated") to
 *  reproduce "beginEmbedderMigration ran, then the process crashed before migrateEmbeddings()
 *  finished" without a real (slow, ONNX-shaped) migration run.
 *
 *  `priorPin` mirrors the stash beginEmbedderMigration now snapshots from sync_meta BEFORE
 *  overwriting it with the target (BLOCKING 2 fix) — pass the pin that was live just before this
 *  sentinel would have been written, exactly as readPin(core) would report it at that moment.
 *  Omitting it fabricates the OLDER-BINARY shape instead: a sentinel written before this stash
 *  mechanism existed, `prior_pin_captured = 0`, nothing recorded — see EmbedderMigrationRow's own
 *  doc comment (engine.ts) and EmbedderMigrationAbandonUnsupportedError.
 *
 *  `vectorsRewritten` (BLOCKING 1 fix, cold-audit round 3) defaults to 0 — "beginEmbedderMigration's
 *  own INSERT just ran, nothing has been rewritten yet" — matching every EXISTING caller's intent
 *  (a migration that is otherwise clean except for whatever the test fabricates via
 *  insertFakeObservation/insertFakeConcept). Pass 1 to fabricate either "a real write already landed"
 *  (post-fix, the PRIMARY abandon-safety signal) or the OLDER-BINARY-predates-the-marker shape (an
 *  ALTER-backfilled sentinel defaults to 1, not 0 — see this column's own migrate()-guard comment). */
function writeMigrationSentinel(
  core: MonetCore,
  targetModelId: string,
  startedAt = Date.now(),
  priorPin?: { modelId: string | null; source: "created" | "backfilled" | "migrated" | null; pinnedAt: number | null },
  vectorsRewritten: number = 0,
): void {
  (core as any).db
    .prepare(
      `INSERT INTO embedder_migration
         (singleton, target_model_id, started_at, prior_model_id, prior_pin_source, prior_pinned_at, prior_pin_captured, vectors_rewritten)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(targetModelId, startedAt, priorPin?.modelId ?? null, priorPin?.source ?? null, priorPin?.pinnedAt ?? null, priorPin ? 1 : 0, vectorsRewritten);
}

/** Fabricates a real vector of the given width directly in the evidence ledger ("write vectors
 *  directly", per the brief) — bypasses store()/embed() entirely so the test controls dimension
 *  independent of whatever embedder happens to be live. `kind` defaults to 'statement' (the
 *  column's own SQL default — genuine semantic evidence); pass 'source' to fabricate a
 *  source-connector placeholder observation (FIX G). `conceptId`, when given, links the row so
 *  concept-scoped maintenance (recomputeNativeConceptProjection and friends) can find it. */
function insertFakeObservation(core: MonetCore, dim: number, id = "fake-legacy-obs", kind = "statement", conceptId?: string, fill = 0.01): void {
  (core as any).db
    .prepare(`INSERT INTO observations (id, content, embedding, author_agent_id, kind, concept_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, "legacy content predating the embedder pin", JSON.stringify(new Array(dim).fill(fill)), "legacy-agent", kind, conceptId ?? null);
}

/** Fabricates a real concept vector directly (FIX 2's concepts fallback / FIX K's source-only
 *  shape) — minimal valid row satisfying the concepts table's NOT NULL columns. `kind` defaults to
 *  'fact' (the column's own SQL default — a native concept); pass 'source' to fabricate a
 *  staged-not-yet-recomputed source concept's placeholder (FIX K). */
function insertFakeConcept(core: MonetCore, dim: number, id = "fake-legacy-concept", kind = "fact", fill = 0.02): void {
  (core as any).db
    .prepare(`INSERT INTO concepts (id, slug, title, body, embedding, kind) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, id, "fake title", "fake body", JSON.stringify(new Array(dim).fill(fill)), kind);
}

/** Fabricates a minimal `source_chunks` row linking an existing observation, for MEDIUM 7 coverage
 *  (abandonEmbedderMigration must exclude a SUPERSEDED chunk's observation from its width
 *  comparison — see inspectMigrationAbandonWidths's own doc comment, engine.ts). Only the columns
 *  the abandon-safety query actually reads (`observation_id`, `lifecycle`) are meaningful; every
 *  other NOT NULL column gets an arbitrary placeholder value since nothing else in this file joins
 *  against them (no FK enforcement — `PRAGMA foreign_keys` is never turned on in this codebase). */
function insertFakeSourceChunk(
  core: MonetCore,
  observationId: string,
  lifecycle: "active" | "superseded" | "deleted",
  id = observationId,
  conceptId: string | null = null,
): void {
  (core as any).db
    .prepare(
      `INSERT INTO source_chunks (
         source_id, run_id, snapshot_id, config_version, binding_id, binding_generation, operation_id,
         relative_path, heading_path_json, occurrence, segment_index, document_sequence,
         content_hash, ingest_fingerprint, metadata_json, source_ref, content,
         concept_id, observation_id, predecessor_observation_id, write_state, lifecycle
       ) VALUES (
         'fake-source', ?, 'fake-snapshot', 1, ?, 1, 'fake-op-' || ?,
         'fake.md', '[]', 1, 1, 1,
         'fake-hash', 'fake-fingerprint', '{}', 'source://fake', 'fake chunk content',
         ?, ?, NULL, 'committed', ?
       )`,
    )
    .run(id, id, id, conceptId, observationId, lifecycle);
}

/** tok=1 and tok=2 diverge only on non-ASCII input — a cheap, real (no-mock) way to prove an
 *  embedder instance is genuinely tok=1, not merely modelId-labeled as one. */
function isGenuinelyTok1(embedder: { embed(text: string): Float32Array | Promise<Float32Array> }, sample: string): boolean {
  const tok2Reference = new HashingEmbeddingProvider(256, 2).embed(sample);
  const actual = embedder.embed(sample);
  if (actual instanceof Promise) throw new Error("expected a sync hashing embedder");
  return JSON.stringify(Array.from(actual)) !== JSON.stringify(Array.from(tok2Reference));
}

/**
 * Stands in for the post-swap ONNX default (Xenova/paraphrase-multilingual-MiniLM-L12-v2): a
 * real semantic model's recommendedThresholds (see OnnxEmbeddingProvider, embedding-onnx.ts —
 * tauAttach 0.72 / tauAmbiguous 0.5), WITHOUT any real model load. Used as the constructor's
 * initial `embedder` opt to reproduce "a server whose default embedder is ONNX opens a store
 * that turns out to be pinned to legacy hashing" without touching the network — the fix under
 * test (threshold re-derivation on swap) never needs this fake's embed() output to be realistic,
 * only its recommendedThresholds to be ONNX-shaped.
 */
class FakeOnnxLikeProvider implements EmbeddingProvider {
  readonly dim = 384;
  readonly recommendedThresholds: EmbeddingThresholds = { tauAttach: 0.72, tauAmbiguous: 0.5 };
  readonly modelId = "fake-onnx-like-for-threshold-test";
  embed(_text: string): Float32Array {
    return new Float32Array(this.dim); // never actually compared — every test below swaps this.embedder out before storing/searching
  }
}

function fakePinnedProvider(modelId: string, dim = 384): EmbeddingProvider {
  return { dim, modelId, embed: () => new Float32Array(dim) };
}

describe("embedder pin — fresh store (Shape 1)", () => {
  it("pins at creation (source 'created', modelId = the active embedder's), and reopening selects the same embedder without rewriting the pin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-fresh-"));
    const dbPath = join(dir, "monet.db");
    try {
      const core1 = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      const pin1 = readPin(core1);
      expect(pin1.embedder_model_id).toBe("hashing:dim=256:tok=2");
      expect(pin1.embedder_pin_source).toBe("created");
      expect(typeof pin1.embedder_pinned_at).toBe("number");

      await core1.ensureEmbedderPin(); // already satisfied at construction — must be a pure no-op
      expect(readPin(core1)).toEqual(pin1);
      core1.close();

      const core2 = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      await core2.ensureEmbedderPin();
      expect(readPin(core2)).toEqual(pin1); // reopen: pin untouched
      expect((core2 as any).embedderModelId).toBe("hashing:dim=256:tok=2"); // same embedder selected
      core2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("embedder pin — backfill on open (Shapes 2, 3, 4)", () => {
  it("Shape 2: a pre-pin store holding 384-dim vectors backfills to the legacy English ONNX default (ONNX satisfaction injected — no real load)", async () => {
    let loaderCalledWith: string | undefined;
    const core = new MonetCore(":memory:", {
      embedder: new HashingEmbeddingProvider(), // whatever was live before pin-aware code — irrelevant once a pin is inferred
      embedderLoader: async (modelId) => {
        loaderCalledWith = modelId;
        return fakePinnedProvider(modelId); // exact-identity stand-in; no real ONNX load
      },
    });
    insertFakeObservation(core, 384);
    clearPin(core); // simulate: this store predates the embedder-pin ADR entirely
    expect(readPin(core).embedder_model_id).toBeNull();

    await core.ensureEmbedderPin();

    const pin = readPin(core);
    expect(pin.embedder_model_id).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
    expect(pin.embedder_pin_source).toBe("backfilled");
    expect(typeof pin.embedder_pinned_at).toBe("number");
    expect(loaderCalledWith).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID); // enforcement actually asked the loader to satisfy the backfilled pin
    core.close();
  });

  it("Shape 3: a pre-pin store holding 256-dim vectors backfills to hashing tok=1, AND the strict loader really instantiates it (no fake)", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() }); // default tok=2
    insertFakeObservation(core, 256);
    clearPin(core);
    expect(readPin(core).embedder_model_id).toBeNull();

    await core.ensureEmbedderPin(); // no embedderLoader override — exercises the REAL instantiateEmbedderForPin

    const pin = readPin(core);
    expect(pin.embedder_model_id).toBe("hashing:dim=256:tok=1");
    expect(pin.embedder_pin_source).toBe("backfilled");
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=1"); // real swap happened

    expect(isGenuinelyTok1((core as any).embedder, "こんにちは世界")).toBe(true);
    core.close();
  });

  it("Shape 4: an empty pre-pin store (zero vectors) pins to the current live embedder, source 'backfilled', no swap needed", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    clearPin(core); // no observations ever inserted — genuinely empty
    expect(readPin(core).embedder_model_id).toBeNull();

    await core.ensureEmbedderPin();

    const pin = readPin(core);
    expect(pin.embedder_model_id).toBe("hashing:dim=256:tok=2");
    expect(pin.embedder_pin_source).toBe("backfilled");
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=2"); // already satisfied — no swap
    core.close();
  });

  it("any OTHER dimension fails closed instead of guessing", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    insertFakeObservation(core, 512); // matches neither known legacy default (384, 256)
    clearPin(core);

    let caught: unknown;
    try {
      await core.ensureEmbedderPin();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    expect((caught as Error).message).toMatch(/512/);
    expect(readPin(core).embedder_model_id).toBeNull(); // refused to write a guessed pin
    core.close();
  });
});

describe("embedder pin — steady state and legacy declined (Shapes 6, 7)", () => {
  it("Shape 6: pin already matches the provided embedder — open proceeds with no rewrite (no UPDATE fired) and an unchanged pin", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    const before = readPin(core); // written 'created' at construction

    const prepareSpy = vi.spyOn((core as any).db, "prepare");
    await core.ensureEmbedderPin();
    const wroteToPin = prepareSpy.mock.calls.some(
      ([sql]) => typeof sql === "string" && /UPDATE sync_meta SET embedder_model_id/.test(sql),
    );
    expect(wroteToPin).toBe(false);
    expect(readPin(core)).toEqual(before);
    core.close();
  });

  it("Shape 7: pin is hashing tok=1 but the provided embedder is tok=2 — open ends with a tok=1 embedder active for BOTH write and query", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() }); // tok=2 default
    writePin(core, "hashing:dim=256:tok=1", "backfilled"); // simulates an earlier open having already backfilled this (Shape 3)

    await core.ensureEmbedderPin();

    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=1");
    const pin = readPin(core);
    expect(pin.embedder_model_id).toBe("hashing:dim=256:tok=1"); // pin itself is untouched — tok=2 was DECLINED, not adopted
    expect(isGenuinelyTok1((core as any).embedder, "こんにちは世界")).toBe(true);

    // Round trip proof: write AND query both actually route through the swapped instance, not just
    // a dangling private field.
    await core.store("hello world, this is a pin round trip test", { circle: "pin-shape-7" });
    const results = await core.search("hello world round trip", { circle: "pin-shape-7" });
    expect(results.length).toBeGreaterThan(0);
    core.close();
  });
});

describe("embedder pin — unsatisfiable (Shape 9)", () => {
  // Codex review (PR #51 round 5, FIX O): fail-closed now protects a COMMITTED vector space, not
  // an unconditional refusal — an empty store has nothing to protect (see the dedicated FIX O
  // describe block below for that recovery path). Every case in THIS block is deliberately
  // NON-empty (insertFakeObservation) so it keeps demonstrating the invariant it always meant to:
  // an unsatisfiable pin over REAL data fails closed, full stop.
  it("hashing pin with an unknown tokenizer version: UnsatisfiableEmbedderError, store does not serve", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    insertFakeObservation(core, 256); // non-empty — FIX O's empty-store recovery must not apply here
    writePin(core, "hashing:dim=256:tok=99");

    let caught: unknown;
    try {
      await core.ensureEmbedderPin();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    expect((caught as UnsatisfiableEmbedderError).modelId).toBe("hashing:dim=256:tok=99");
    // The live embedder was never replaced — a failed enforcement must not leave a half-swapped state.
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=2");
    core.close();
  });

  it("an unrecognized/garbage/future pin format (no slash — FIX F widened ONNX recognition to any owner/repo shape, so a slash-containing string like 'some/garbage-future-model' is now legitimately dispatched into the ONNX path instead): UnsatisfiableEmbedderError naming a newer Monet version, store does not serve", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    insertFakeObservation(core, 256); // non-empty — FIX O's empty-store recovery must not apply here
    writePin(core, "some-garbage-future-model-no-slash");

    let caught: unknown;
    try {
      await core.ensureEmbedderPin();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    expect((caught as UnsatisfiableEmbedderError).modelId).toBe("some-garbage-future-model-no-slash");
    expect((caught as Error).message).toMatch(/newer version of monet/i);
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=2"); // unswapped
    core.close();
  });

  it("an unsatisfiable pin also stops createMonetCoreMcpServer from starting — the served-path choke point actually rejects", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    insertFakeObservation(core, 256); // non-empty — FIX O's empty-store recovery must not apply here
    writePin(core, "hashing:dim=256:tok=99");

    await expect(createMonetCoreMcpServer(core)).rejects.toThrow(UnsatisfiableEmbedderError);
    core.close();
  });
});

describe("embedder pin — graft rejection compares against the PINNED identity", () => {
  it("a graft payload whose embedderModelId doesn't match the pin still throws EmbedderMismatchError, comparing against the pin (not whatever the constructor happened to receive)", async () => {
    const source = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 2) });
    await source.store("a fact worth exporting", { circle: "c" });
    const payload = source.exportDelta(0);
    source.close();
    expect(payload.embedderModelId).toBe("hashing:dim=256:tok=2");

    const dest = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 1) }); // pins tok=1 at creation
    await dest.ensureEmbedderPin(); // steady state, no-op — confirms the pin is what graftRows will compare against

    let caught: unknown;
    try {
      dest.graftRows(payload);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedderMismatchError);
    expect((caught as EmbedderMismatchError).local).toBe("hashing:dim=256:tok=1"); // the PINNED identity
    expect((caught as EmbedderMismatchError).incoming).toBe("hashing:dim=256:tok=2");
    dest.close();
  });
});

// ---- embedder pin — threshold re-derivation on swap (post-review fix) --------------------------
//
// tauAttach/tauAmbiguous/edgeSimMin are cosine-distribution-calibrated PER embedding space (see
// EmbeddingProvider.recommendedThresholds). The constructor derives them from whichever embedder
// it's handed — but ensureEmbedderPin() can later replace that embedder entirely (Shapes 2/3/7
// above). Left unfixed, a store constructed with an ONNX-shaped default (tauAttach ~0.72) that
// turns out to be pinned to legacy hashing (whose cosine similarities saturate far lower, ~0.55)
// would keep running resolve-or-create under the WRONG embedder's thresholds: tauAttach effectively
// unreachable, so store() forks a new concept on every call instead of attaching — dedup silently
// dies. Same silent-degradation class the whole ADR exists to eliminate, one level down.
describe("embedder pin — thresholds re-derive under the swapped-in embedder (not left stale from construction)", () => {
  // Verified independently (not asserted blindly): this pair's REAL hashing-tok=1 cosine score
  // sits strictly between hashing's tauAttach (0.55) and the fake ONNX-like provider's tauAttach
  // (0.72) — the exact band the bug and the fix disagree about.
  const TEXT_A = "the database migration failed due to a lock timeout";
  const TEXT_B = "the schema migration failed because of a connection timeout";

  it("sanity: TEXT_A/TEXT_B's real tok=1 cosine score sits strictly between hashing's tauAttach (0.55) and the fake's tauAttach (0.72)", () => {
    const tok1 = new HashingEmbeddingProvider(256, 1);
    const score = cosine(tok1.embed(TEXT_A), tok1.embed(TEXT_B));
    expect(score).toBeGreaterThan(0.55);
    expect(score).toBeLessThan(0.72);
  });

  it("(a) a pair that would have forked under the stale ONNX-calibrated thresholds attaches cleanly once thresholds are re-derived for the swapped-in hashing embedder", async () => {
    const core = new MonetCore(":memory:", { embedder: new FakeOnnxLikeProvider() });
    // Pre-swap: thresholds computed from the FAKE (ONNX-shaped) embedder at construction — this is
    // the buggy-precursor state a naive "just replace this.embedder" fix would leave in place.
    expect((core as any).tauAttach).toBe(0.72);
    expect((core as any).tauAmbiguous).toBe(0.5);
    expect((core as any).edgeSimMin).toBe(0.45); // semantic branch: 0.72 >= 0.7

    writePin(core, "hashing:dim=256:tok=1", "backfilled"); // simulates an earlier open having already pinned this store to legacy hashing (Shape 3)
    await core.ensureEmbedderPin(); // real loader — swaps in a REAL HashingEmbeddingProvider(256, 1)
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=1"); // swap happened

    // Direct field assertion (reasonable accessor: this codebase's established white-box test
    // convention, e.g. `(core as any).db` throughout sync.test.ts — no public accessor exists and
    // none should, per Task 4's own design: the pin is an internal invariant, not a public knob).
    expect((core as any).tauAttach).toBe(0.55); // hashing's own recommendedThresholds — NOT the stale 0.72
    expect((core as any).tauAmbiguous).toBe(0.4);
    expect((core as any).edgeSimMin).toBe(0.4); // semantic branch flips: 0.55 < 0.7

    // Behavioral proof, not just the field read: store the pair from the sanity test above. Under
    // the corrected 0.55 threshold this ATTACHES (one concept). Under the stale 0.72/0.5 pair it
    // would have landed in the [0.5, 0.72) "ambiguous" band, which resolve-or-create forks into a
    // SEPARATE concept for non-correction evidence (engine.ts's store() branch: action="ambiguous"
    // calls this.create(), not this.attach()) — i.e. dedup would have silently broken.
    const first = await core.store(TEXT_A, { circle: "threshold-fix" });
    const second = await core.store(TEXT_B, { circle: "threshold-fix" });
    expect(second.action).toBe("attached");
    expect(second.conceptId).toBe(first.conceptId); // ONE concept — would have been two pre-fix
    expect(core.conceptCount("threshold-fix")).toBe(1);
    core.close();
  });

  it("(b) an explicit tauAttach/tauAmbiguous/edgeSimMin opt still wins after a swap — the precedence rule, not just the embedder's recommendation, survives", async () => {
    const core = new MonetCore(":memory:", {
      embedder: new FakeOnnxLikeProvider(),
      tauAttach: 0.66,
      tauAmbiguous: 0.33,
      edgeSimMin: 0.22,
    });
    expect((core as any).tauAttach).toBe(0.66); // explicit opt wins over the fake's 0.72 at construction
    expect((core as any).tauAmbiguous).toBe(0.33);
    expect((core as any).edgeSimMin).toBe(0.22);

    writePin(core, "hashing:dim=256:tok=1", "backfilled");
    await core.ensureEmbedderPin(); // triggers a real swap (fake's modelId !== the pin)
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=1"); // swap DID happen

    // ...but the explicit opts still win under the NEW embedder too — hashing's own 0.55/0.4 never
    // gets a chance to apply, because explicit opts sit ABOVE "the embedder's recommendation" in
    // the precedence chain regardless of which embedder is live.
    expect((core as any).tauAttach).toBe(0.66);
    expect((core as any).tauAmbiguous).toBe(0.33);
    expect((core as any).edgeSimMin).toBe(0.22);
    core.close();
  });

  it("(c) steady state (pin already satisfied): thresholds are byte-identical and the recompute path never runs", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() }); // pins itself at construction — already satisfied
    const before = {
      tauAttach: (core as any).tauAttach,
      tauAmbiguous: (core as any).tauAmbiguous,
      edgeSimMin: (core as any).edgeSimMin,
    };

    const recomputeSpy = vi.spyOn(core as any, "applyEmbedderDerivedThresholds");
    await core.ensureEmbedderPin(); // pin already matches the constructor-provided embedder — steady state
    expect(recomputeSpy).not.toHaveBeenCalled(); // the swap branch (and its threshold recompute) never ran — proves "no side effects", not just "same values"

    expect((core as any).tauAttach).toBe(before.tauAttach);
    expect((core as any).tauAmbiguous).toBe(before.tauAmbiguous);
    expect((core as any).edgeSimMin).toBe(before.edgeSimMin);
    core.close();
  });
});

// ---- embedder pin — review hardening: constructor-time guard + backfill closure gaps -----------
//
// Three gaps a review pass found after slice 1 landed:
//  FIX 1: "await ensureEmbedderPin() before serving" was JSDoc-only — an external consumer that
//         skipped the await ran the constructor-provided embedder against pinned-space vectors
//         with no signal anything was wrong. Closed by a synchronous constructor-time guard
//         (pinUnsatisfied) enforced at every served embed choke point (assertPinSatisfied()).
//  FIX 2: sampleStoredVectorDim only ever read `observations`, so a checkpoint-only pre-pin store
//         (workstream vectors in `concepts`, ZERO observations — saveWorkstream() never inserts
//         one) read as "empty" and false-pinned to the live embedder instead of the dimension its
//         real vectors actually carry.
//  FIX 3: sampleStoredVectorDim's old unordered LIMIT 1 blessed an arbitrary row on a store mixing
//         two vector dimensions (a real shape: createLocalEmbedder's ONNX↔hashing fallback can
//         flip-flop across restarts) — cosine() truncates silently on a dimension mismatch, so the
//         resulting mis-scoring would have been invisible. Now fails closed instead of guessing.
describe("embedder pin — constructor-time guard (review hardening, FIX 1)", () => {
  it("(a) guard arms on a mismatched reopen — store()/search() throw EmbedderPinUnsatisfiedError before ensureEmbedderPin(), then succeed under the pinned embedder after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-guard-arms-"));
    const dbPath = join(dir, "monet.db");
    try {
      // Build a store genuinely pinned to hashing tok=1 (a real prior engine instance, not fabricated SQL).
      const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
      seed.close();

      // Reopen with a DIFFERENT embedder (tok=2) and skip ensureEmbedderPin — the exact bypass this
      // fix closes (an external consumer that forgets the await).
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 2) });
      expect((core as any).pinUnsatisfied).toBe(true); // armed at construction

      let caught: unknown;
      try {
        await core.store("hello there, this must not be written under the wrong embedder");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EmbedderPinUnsatisfiedError);
      expect((caught as EmbedderPinUnsatisfiedError).pinnedModelId).toBe("hashing:dim=256:tok=1");
      expect((caught as EmbedderPinUnsatisfiedError).constructedModelId).toBe("hashing:dim=256:tok=2");
      await expect(core.search("hello")).rejects.toThrow(EmbedderPinUnsatisfiedError);
      // Nothing was actually written by the rejected store() call above.
      expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(0);

      // Await the enforcement step — the guard clears, and the SAME calls now succeed under the
      // real, pinned tok=1 embedder.
      await core.ensureEmbedderPin();
      expect((core as any).pinUnsatisfied).toBe(false);
      expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=1");
      const stored = await core.store("hello there, this attaches under the pinned embedder");
      expect(stored.conceptId).toBeTruthy();
      const found = await core.search("hello there");
      expect(found.length).toBeGreaterThan(0);
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(b) fresh writes remain immediate, while a same-width pre-pin legacy store now requires explicit identity backfill", async () => {
    // Fresh store: initSyncIdentity self-pins to the constructor embedder BEFORE the constructor's
    // guard read, so the read always finds a match — never arms.
    const fresh = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    expect((fresh as any).pinUnsatisfied).toBe(false);
    await expect(fresh.store("a fact on a fresh store, no ensureEmbedderPin call at all")).resolves.toMatchObject({ action: expect.any(String) });
    fresh.close();

    // Pre-pin legacy store: fabricate on disk (real vectors + NULL pin), then construct a FRESH
    // engine instance against that file — the constructor's guard read happens against the
    // genuinely-NULL pin AT THIS construction (not a value nulled out after an already-computed
    // flag from a prior, different-pin construction).
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-guard-inert-"));
    const dbPath = join(dir, "monet.db");
    try {
      const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      insertFakeObservation(seed, 256);
      clearPin(seed);
      seed.close();

      // Reopen with the SAME-width embedder (tok=2, still 256-dim). Width cannot distinguish tok1
      // from tok2, so an ordinary write must not infer identity from that agreement.
      const legacy = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() }); // reopen — reads the genuinely-NULL pin
      expect((legacy as any).pinUnsatisfied).toBe(false);
      await expect(legacy.store("same width is not identity")).rejects.toBeInstanceOf(EmbedderPinUnsatisfiedError);
      await legacy.ensureEmbedderPin();
      await expect(legacy.store("explicit backfill established the legacy tok1 identity")).resolves.toMatchObject({ action: expect.any(String) });
      legacy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(b2) embedder-width guard: a genuinely-unpinned store THROWS EmbedderWidthConflictError (writing nothing) when a write's width disagrees with what's already stored — the flip-flop gap (b) alone leaves open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-guard-width-conflict-"));
    const dbPath = join(dir, "monet.db");
    try {
      // Seed a NULL-pin store holding a 256-dim fake observation — same "predates the embedder-pin
      // ADR" setup as test (b) above.
      const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      insertFakeObservation(seed, 256);
      clearPin(seed);
      seed.close();

      // Reopen with an embedder producing a DIFFERENT width (384) — stands in for
      // createLocalEmbedderWithProvenance's real ONNX<->hashing flip-flop (embedding-onnx.ts) —
      // and skip ensureEmbedderPin(), the exact never-armed gap test (b) exercises for the
      // AGREEING-width case. FakeOnnxLikeProvider (declared earlier in this file) is a real,
      // reliable 384-dim provider with no network/model load — its declared dim and actual embed()
      // output always agree, matching this guard's own documented scope.
      const core = new MonetCore(dbPath, { embedder: new FakeOnnxLikeProvider() });
      expect((core as any).pinUnsatisfied).toBe(false); // NULL pin never arms the OLD (pin-string) guard

      let caught: unknown;
      try {
        await core.store("this must not silently write a 384-dim vector alongside 256-dim evidence");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(EmbedderPinUnsatisfiedError);
      // Nothing was written — the fabricated seed observation is still the ONLY row.
      expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(1);
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("embedder pin — checkpoint-only and mixed-dimension backfill (review hardening, FIX 2 + FIX 3)", () => {
  it("(c) a checkpoint-only pre-pin store (one workstream vector in concepts, ZERO observations) backfills to hashing tok=1 from the concepts fallback, not the live embedder's id", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() }); // default tok=2
    await core.saveWorkstream({ status: "active", nextSteps: ["resume later"] }, { circle: "checkpoint-only" });
    // Confirm the shape before asserting on it: saveWorkstream() really does write zero observations.
    expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(0);
    expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind='workstream'`).get().n).toBe(1);

    clearPin(core); // simulate: this store predates the embedder-pin ADR

    await core.ensureEmbedderPin();

    const pin = readPin(core);
    expect(pin.embedder_model_id).toBe("hashing:dim=256:tok=1"); // NOT "hashing:dim=256:tok=2" (the live embedder) — inferred from the real 256-dim workstream vector
    expect(pin.embedder_pin_source).toBe("backfilled");
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=1"); // swap followed the backfilled pin, same as Shape 3
    core.close();
  });

  it("(d) a store mixing 256-dim and 384-dim observations throws UnsatisfiableEmbedderError naming both dimensions and writes no pin", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    insertFakeObservation(core, 256, "obs-256");
    insertFakeObservation(core, 384, "obs-384");
    clearPin(core);

    let caught: unknown;
    try {
      await core.ensureEmbedderPin();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    expect((caught as Error).message).toMatch(/256/);
    expect((caught as Error).message).toMatch(/384/);
    expect(readPin(core).embedder_model_id).toBeNull(); // no pin written — fail closed, not a guess
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=2"); // unswapped
    core.close();
  });
});

// ---- embedder pin — Codex review (PR #51): 4 apply-now fixes ----------------------------------
describe("embedder pin — cross-store exchange guard (Codex review, PR #51, FIX A)", () => {
  it("exportDelta, graftRows, and batchDedup all throw EmbedderPinUnsatisfiedError on a mismatched reopen, and succeed once ensureEmbedderPin has run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-guard-sync-"));
    const dbPath = join(dir, "monet.db");
    try {
      const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
      seed.close();

      // Reopen with a DIFFERENT embedder and skip ensureEmbedderPin — without FIX A, exportDelta
      // would stamp the WRONG embedderModelId (poisoning whatever engine grafts the payload) and
      // graftRows would validate incoming payloads against that same wrong local identity.
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 2) });
      expect((core as any).pinUnsatisfied).toBe(true);

      expect(() => core.exportDelta(0)).toThrow(EmbedderPinUnsatisfiedError);
      expect(() => core.graftRows({} as unknown as Parameters<MonetCore["graftRows"]>[0])).toThrow(EmbedderPinUnsatisfiedError);
      // batchDedup too — reads already-grafted vectors and cosine-compares them using
      // this.tauAmbiguous, which is ALSO miscalibrated whenever pinUnsatisfied is true.
      expect(() => core.batchDedup([])).toThrow(EmbedderPinUnsatisfiedError);

      await core.ensureEmbedderPin();
      expect((core as any).pinUnsatisfied).toBe(false);

      // Now all three actually work, under the pinned embedder — exportDelta stamps the CORRECT
      // (pinned) identity, not the mismatched constructor one, and grafting the store's own export
      // back into itself is self-consistent (no EmbedderMismatchError).
      const payload = core.exportDelta(0);
      expect(payload.embedderModelId).toBe("hashing:dim=256:tok=1");
      expect(() => core.graftRows(payload)).not.toThrow();
      expect(() => core.batchDedup([])).not.toThrow();
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("embedder pin — guard arms before the loader can fail (Codex review, PR #51, FIX C)", () => {
  it("if ensureEmbedderPin's loader throws, the guard stays armed afterward — store()/search() still fail closed instead of silently proceeding", async () => {
    const core = new MonetCore(":memory:", {
      embedder: new HashingEmbeddingProvider(), // tok=2 — will need a swap once backfilled to the legacy ONNX default
      embedderLoader: async () => {
        throw new Error("simulated: offline, ONNX model unavailable");
      },
    });
    insertFakeObservation(core, 384); // backfills to LEGACY_ONNX_DEFAULT_MODEL_ID, which the injected loader always fails to satisfy
    clearPin(core);
    expect((core as any).pinUnsatisfied).toBe(false); // unarmed before ensure — pin was still NULL at construction

    await expect(core.ensureEmbedderPin()).rejects.toThrow(/simulated: offline/);
    expect((core as any).pinUnsatisfied).toBe(true); // armed the instant the mismatch was confirmed, BEFORE the loader failed — not left false by the failed await

    // A caller that (wrongly) catches the rejection above and keeps using core must NOT get an
    // unguarded operation — pre-FIX-C they would have (pinUnsatisfied stayed false all along).
    await expect(core.store("this must not silently write under the wrong embedder")).rejects.toThrow(EmbedderPinUnsatisfiedError);
    await expect(core.search("this must not silently query under the wrong embedder")).rejects.toThrow(EmbedderPinUnsatisfiedError);
    core.close();
  });
});

describe("embedder pin — loader identity is exact, canonical, and stable", () => {
  for (const [label, loadedModelId] of [
    ["blank", ""],
    ["leading whitespace", ` ${LEGACY_ONNX_DEFAULT_MODEL_ID}`],
    ["trailing whitespace", `${LEGACY_ONNX_DEFAULT_MODEL_ID} `],
    ["mismatch", "test:different-model"],
  ] as const) {
    it(`rejects ${label} loader identity without clearing the poison`, async () => {
      const core = new MonetCore(":memory:", {
        embedder: new HashingEmbeddingProvider(),
        embedderLoader: async () => ({
          dim: 384,
          modelId: loadedModelId,
          embed: () => new Float32Array(384).fill(0.25),
        }),
      });
      insertFakeObservation(core, 384, `loader-${label}`);
      clearPin(core);
      try {
        await expect(core.ensureEmbedderPin()).rejects.toBeInstanceOf(UnsatisfiableEmbedderError);
        expect(readPin(core).embedder_model_id).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
        expect((core as any).pinUnsatisfied).toBe(true);
        await expect(core.search("still poisoned")).rejects.toBeInstanceOf(EmbedderPinUnsatisfiedError);
      } finally {
        core.close();
      }
    });
  }

  it("accepts only the exact pinned identity and installs it consistently", async () => {
    const loaded = fakePinnedProvider(LEGACY_ONNX_DEFAULT_MODEL_ID);
    const core = new MonetCore(":memory:", {
      embedder: new HashingEmbeddingProvider(),
      embedderLoader: async () => loaded,
    });
    insertFakeObservation(core, 384, "loader-exact");
    clearPin(core);
    try {
      await expect(core.ensureEmbedderPin()).resolves.toBeUndefined();
      expect((core as any).embedder).toBe(loaded);
      expect((core as any).embedder.modelId).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
      expect((core as any).pinUnsatisfied).toBe(false);
    } finally {
      core.close();
    }
  });
});

describe("embedder pin — concurrent backfill race is CAS-safe (Codex review, PR #51, FIX D)", () => {
  it("a lost backfill race adopts the already-persisted (winning) pin instead of overwriting it", () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() }); // tok=2
    insertFakeObservation(core, 256); // this instance would independently compute "hashing:dim=256:tok=1"
    clearPin(core);

    // Simulate: another process/instance already won the backfill race between this instance's own
    // NULL read and its write. Pre-seed the WINNER's pin, then call backfillEmbedderPin() DIRECTLY
    // (bypassing ensureEmbedderPin's own NULL gate, which would otherwise short-circuit before ever
    // reaching the CAS write this test targets — matches the coordinator's own suggested
    // technique). backfillEmbedderPin's internal flow (sample -> compute -> CAS write) is
    // unaffected by how it's invoked, so this exercises the exact same race window a genuine
    // concurrent process would hit.
    writePin(core, LEGACY_ONNX_DEFAULT_MODEL_ID, "backfilled");

    const result = (core as any).backfillEmbedderPin() as string;
    expect(result).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID); // adopted the WINNER's pin, not its own "hashing:dim=256:tok=1" computation

    const pin = readPin(core);
    expect(pin.embedder_model_id).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID); // untouched — never overwrote the winner
    expect(pin.embedder_pin_source).toBe("backfilled"); // still the winner's original stamp, not re-stamped by the loser
    core.close();
  });
});

describe("embedder pin — a failed backfill poisons the guard (Codex review, PR #51 round 3, FIX I)", () => {
  it("a mixed-dim pre-pin store's failed ensureEmbedderPin arms the guard even though the pin stays NULL — subsequent store()/search() fail closed instead of silently proceeding", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    insertFakeObservation(core, 256, "obs-256");
    insertFakeObservation(core, 384, "obs-384");
    clearPin(core);
    expect((core as any).pinUnsatisfied).toBe(false); // unarmed before ensure — pin was still NULL at construction

    await expect(core.ensureEmbedderPin()).rejects.toThrow(UnsatisfiableEmbedderError);
    // Poisoned: pin stays NULL (backfillEmbedderPin's CAS write never ran — the throw happens
    // before it), yet the guard is now ARMED. Distinct from an ordinary never-ensured pre-pin
    // store, which stays unarmed (see Shape/FIX 1 test (b)) — THIS store has been checked and
    // proven unsafe, not merely "not checked yet".
    expect(readPin(core).embedder_model_id).toBeNull();
    expect((core as any).pinUnsatisfied).toBe(true);

    // A caller that (wrongly) catches the rejection above and keeps using core must NOT get an
    // unguarded operation — pre-FIX-I they would have (pinUnsatisfied stayed false all along).
    await expect(core.store("this must not silently write under the wrong embedder")).rejects.toThrow(EmbedderPinUnsatisfiedError);
    await expect(core.search("this must not silently query under the wrong embedder")).rejects.toThrow(EmbedderPinUnsatisfiedError);
    core.close();
  });
});

// ---- embedder pin — Codex round 2 (PR #51): 4 more apply-now fixes -----------------------------
describe("embedder pin — legacy-upgrade stores must not get a 'created' pin (Codex review, PR #51, FIX E)", () => {
  it("a store whose sync_meta row is being created for the first time, but which already holds real vectors, gets a NULL pin (not 'created') — the guard stays unarmed until ensureEmbedderPin backfills it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-legacy-upgrade-"));
    const dbPath = join(dir, "monet.db");
    try {
      // Build a store with a real 384-dim vector on disk, using the public API (simplest way to get
      // a realistic, schema-correct row) — this is NOT yet the "pre-v8 upgrade" simulation itself.
      const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      insertFakeObservation(seed, 384); // pretend this store's real historical embedder was 384-dim ONNX
      // Simulate the pre-v8-upgrade shape: DELETE the sync_meta row entirely (not just null its pin
      // columns). From initSyncIdentity's perspective — it only checks for the ROW, never whether
      // the TABLE itself pre-existed — this is indistinguishable from "the table never had this
      // row", exactly the state a genuine pre-v8 database is in on its first open under sync-aware
      // code (init()'s CREATE TABLE IF NOT EXISTS creates the table fresh, but no row has ever
      // existed for it).
      (seed as any).db.prepare(`DELETE FROM sync_meta WHERE singleton = 1`).run();
      seed.close();

      // Reopen with a DIFFERENT embedder than whatever "produced" the legacy vectors — simulating a
      // server whose default swapped since this store was last used. The backfilled pin will be
      // ONNX-shaped (384-dim legacy default), so — per the ADR's own test discipline — inject a
      // fake embedderLoader rather than let ensureEmbedderPin's swap reach the REAL loader, which
      // would attempt a genuine network/model load.
      let loaderCalledWith: string | undefined;
      const core = new MonetCore(dbPath, {
        embedder: new HashingEmbeddingProvider(), // hashing tok=2 — mismatched vs the 384-dim legacy vectors either way
        embedderLoader: async (modelId) => {
          loaderCalledWith = modelId;
          return fakePinnedProvider(modelId); // exact-identity stand-in — no real ONNX load
        },
      });
      expect(readPin(core).embedder_model_id).toBeNull(); // NOT 'created' — the legacy-vector probe caught it
      expect(readPin(core).embedder_pin_source).toBeNull();
      expect((core as any).pinUnsatisfied).toBe(false); // NULL pin never arms — nothing to be unsatisfied about until ensure runs

      // Embedder-width guard: attempting a write on this SAME mismatched, unensured core must throw
      // EmbedderWidthConflictError rather than silently writing a 256-dim hashing vector alongside
      // the 384-dim legacy evidence seeded above — the write-time half of the gap this describe
      // block's own pin-guard coverage leaves open (it never calls store() on the mismatched core).
      let writeCaught: unknown;
      try {
        await core.store("this must not silently write a 256-dim vector alongside 384-dim legacy evidence");
      } catch (e) {
        writeCaught = e;
      }
      expect(writeCaught).toBeInstanceOf(EmbedderPinUnsatisfiedError);
      expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(1); // still just the seeded legacy observation — nothing new written

      await core.ensureEmbedderPin();
      const pin = readPin(core);
      expect(pin.embedder_model_id).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
      expect(pin.embedder_pin_source).toBe("backfilled"); // NOT 'created'
      expect(loaderCalledWith).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // "existing test must keep passing" (per the brief): the fresh-store 'created'-pin case is
  // already covered by Shape 1's test above ("pins at creation (source 'created' ...") — confirmed
  // still green after this fix (see the PR's full-suite run), not duplicated here.
});

describe("embedder pin — source placeholder observations excluded from dimension inference (Codex review, PR #51, FIX G)", () => {
  it("a 256-dim source-connector placeholder alongside a genuine 384-dim native observation pins 384 (the real evidence), not a mixed-dim throw", async () => {
    // The backfilled pin will be ONNX-shaped (384-dim) — inject a fake embedderLoader (ADR test
    // discipline: real instantiation only for hashing) instead of letting the swap reach the real
    // loader, which would attempt a genuine network/model load.
    const core = new MonetCore(":memory:", {
      embedder: new HashingEmbeddingProvider(),
      embedderLoader: async (modelId) => fakePinnedProvider(modelId), // exact-identity stand-in — no real ONNX load
    });
    insertFakeObservation(core, 256, "source-placeholder-1", "source", undefined, 0); // provable all-zero placeholder
    insertFakeObservation(core, 384, "native-real-1", "statement"); // genuine semantic evidence, recomputed under ONNX
    clearPin(core);

    await core.ensureEmbedderPin();

    const pin = readPin(core);
    expect(pin.embedder_model_id).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID); // the REAL native vector's dimension, not the 256-dim source placeholder
    expect(pin.embedder_pin_source).toBe("backfilled");
    core.close();
  });

  it("a store whose ONLY observations are source placeholders falls through to the concepts fallback and pins from a genuine NATIVE concept vector there", async () => {
    const core = new MonetCore(":memory:", {
      embedder: new HashingEmbeddingProvider(),
      embedderLoader: async (modelId) => fakePinnedProvider(modelId), // exact-identity stand-in — no real ONNX load
    });
    insertFakeObservation(core, 256, "source-placeholder-only", "source", undefined, 0); // the ONLY observation row — a provable placeholder
    insertFakeConcept(core, 384); // kind='fact' (the default) — a genuine NATIVE concept vector, unaffected by FIX K's kind='source' exclusion; see the FIX K test below for the all-source-kind shape
    clearPin(core);

    await core.ensureEmbedderPin();

    const pin = readPin(core);
    expect(pin.embedder_model_id).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID); // fell through to concepts — observations held ONLY a source placeholder, which FIX G excludes
    expect(pin.embedder_pin_source).toBe("backfilled");
    core.close();
  });

  it("(FIX K) a store whose ONLY vectors are source placeholders in BOTH tables (staged observations AND not-yet-recomputed source concepts) samples empty and pins the live embedder — no throw, no guess", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() }); // default tok=2
    insertFakeObservation(core, 256, "source-obs-placeholder", "source", undefined, 0);
    insertFakeConcept(core, 256, "source-concept-placeholder", "source", 0);
    clearPin(core);

    await core.ensureEmbedderPin(); // no embedderLoader override needed — samples empty, so this is Shape 4's "pin to the live embedder" path, no swap

    const pin = readPin(core);
    expect(pin.embedder_model_id).toBe("hashing:dim=256:tok=2"); // BOTH tables sampled empty (both rows are kind='source') — pinned to the live embedder, exactly like Shape 4
    expect(pin.embedder_pin_source).toBe("backfilled");
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=2"); // already satisfied — no swap
    core.close();
  });
});

describe("embedder pin — vector-threshold comparison guard (Codex review, PR #51, FIX H)", () => {
  it("reassignCircle and mergeCircle throw EmbedderPinUnsatisfiedError on a mismatched reopen, and succeed once ensureEmbedderPin has run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-guard-vector-"));
    const dbPath = join(dir, "monet.db");
    try {
      const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
      const stored = await seed.store("a fact that will be reassigned", { circle: "source-circle" });
      seed.close();

      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 2) }); // mismatched, no ensure
      expect((core as any).pinUnsatisfied).toBe(true);

      expect(() => core.reassignCircle(stored.conceptId, "dest-circle")).toThrow(EmbedderPinUnsatisfiedError);
      await expect(core.mergeCircle("source-circle", "dest-circle")).rejects.toThrow(EmbedderPinUnsatisfiedError);
      // Neither rejected call actually reassigned/merged anything.
      expect((core as any).db.prepare(`SELECT circle FROM concepts WHERE id = ?`).get(stored.conceptId)).toEqual({ circle: "source-circle" });

      await core.ensureEmbedderPin();
      expect((core as any).pinUnsatisfied).toBe(false);

      // Now both actually work, under the pinned embedder.
      const result = core.reassignCircle(stored.conceptId, "dest-circle");
      expect(result).not.toBeNull();
      expect(["moved", "merged", "noop"]).toContain(result!.action);
      await expect(core.mergeCircle("source-circle", "dest-circle")).resolves.toBeDefined();
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restoreConcept and detach (found via the FIX H audit, not explicitly named in the review) also throw EmbedderPinUnsatisfiedError when the guard is armed", async () => {
    // White-box arm (matches this file's established convention) rather than a full mismatched-
    // reopen setup: this test's only job is confirming these two methods actually call the gate —
    // the gate's own mechanism (arms/clears correctly, blocks/permits correctly) is already proven
    // repeatedly above and in the FIX A/C round-trip tests.
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    (core as any).pinUnsatisfied = true;
    expect(() => core.restoreConcept("nonexistent-id")).toThrow(EmbedderPinUnsatisfiedError);
    await expect(core.detach("nonexistent-id", ["obs-1"])).rejects.toThrow(EmbedderPinUnsatisfiedError);
    core.close();
  });
});

// ---- embedder pin — Codex round 4 (PR #51): graph backfill deferral ----------------------------
//
// The one site FIX H's audit documented as "architecturally ungateable" (backfillGraph runs during
// migrate(), strictly before this.pinUnsatisfied is even computed) turned out to have a real
// consequence Codex found: an already-PINNED store opened by a mismatched constructor embedder,
// with the one-time graph backfill still pending (user_version < GRAPH_SCHEMA_VERSION), would run
// that backfill's bestMatches comparisons under thresholds calibrated for the WRONG embedder —
// permanently wrong/missing `related` edges, since the backfill is version-gated to run at most
// once. The fix is deferral: migrate() now only runs the backfill when the pin (or its absence)
// makes the constructor-provided thresholds trustworthy; ensureEmbedderPin() completes any deferred
// backfill once this.embedder is confirmed to satisfy the pin.
//
// Realistic trigger for "already pinned, backfill still pending": a store used with
// graphEnabled:false (migrate()'s own pre-existing comment: "a graph-disabled open must NOT consume
// the upgrade slot") gets pinned normally (initSyncIdentity runs regardless of graphEnabled), then
// is later reopened graphEnabled:true with a different embedder than whatever it was pinned to.
describe("embedder pin — graph backfill deferred until thresholds are trustworthy (Codex review, PR #51 round 4, FIX M)", () => {
  const TEXT_A = "the database migration failed due to a lock timeout";
  const TEXT_B = "the schema migration failed because of a connection timeout";

  it("(test a) a mismatched-embedder open on an already-pinned, backfill-still-pending store defers the backfill; ensureEmbedderPin completes it with an edge set matching a correctly-opened reference", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-graph-defer-a-"));
    const seedPath = join(dir, "seed.db");
    const mismatchedPath = join(dir, "mismatched.db");
    const referencePath = join(dir, "reference.db");
    try {
      // Seed: pin to hashing tok=1, graphEnabled:false so the one-time backfill's version slot is
      // NEVER consumed — the realistic way this state arises. Two lexically-related concepts (dedup
      // off, so both survive as distinct concepts for backfillGraph's neighbor search to relate)
      // give backfillGraph something to actually find.
      const seed = new MonetCore(seedPath, {
        embedder: new HashingEmbeddingProvider(256, 1),
        graphEnabled: false,
        tauAttach: 1.1,
        tauAmbiguous: 1.1, // dedup off — force two distinct concepts to compare, matches this codebase's own freshCore() convention for exercising the graph
      });
      await seed.store(TEXT_A, { circle: "c" });
      await seed.store(TEXT_B, { circle: "c" });
      seed.close();

      copyFileSync(seedPath, mismatchedPath);
      copyFileSync(seedPath, referencePath);

      // Reference: reopen with the MATCHING embedder, graph enabled — pin matches constructor
      // embedder, so migrate() does NOT defer; backfill runs normally, synchronously, in the
      // constructor (test (b)'s exact shape, used here purely as the "ground truth" comparison).
      const reference = new MonetCore(referencePath, {
        embedder: new HashingEmbeddingProvider(256, 1),
        graphEnabled: true,
        tauAttach: 1.1,
        tauAmbiguous: 1.1,
        edgeSimMin: 0.1, // low floor so the lexically-related pair reliably clears it — this test asserts EQUIVALENCE between two paths, not calibration
      });
      const referenceEdges = reference.edges();
      expect(referenceEdges.length).toBeGreaterThan(0); // sanity: there IS something to backfill
      reference.close();

      // The path this fix closes: reopen with a MISMATCHED embedder (tok=2 stands in for "an
      // ONNX-ish constructor default" — avoids real ONNX/network while still being a genuine
      // vector-space mismatch), graph enabled.
      const mismatched = new MonetCore(mismatchedPath, {
        embedder: new HashingEmbeddingProvider(256, 2),
        graphEnabled: true,
        tauAttach: 1.1,
        tauAmbiguous: 1.1,
        edgeSimMin: 0.1,
      });
      expect((mismatched as any).pinUnsatisfied).toBe(true); // mismatched — constructor-time guard confirms it independently
      expect(mismatched.edges()).toEqual([]); // construction did NOT create graph edges — deferred, not silently wrong

      await mismatched.ensureEmbedderPin(); // swaps to real hashing tok=1 (satisfies the pin), re-derives thresholds, THEN completes the deferred backfill
      expect((mismatched as any).embedderModelId).toBe("hashing:dim=256:tok=1");

      const mismatchedEdges = mismatched.edges();
      expect(mismatchedEdges.length).toBeGreaterThan(0);
      // Edge-set equivalence against the always-correctly-opened reference: both are copies of the
      // SAME seed file (same concept/observation ids, byte-identical rows), so a direct comparison
      // after sorting to a stable key is a genuine structural equality check, not a coincidence.
      const sortKey = (e: { srcId: string; dstId: string; type: string }) => `${e.srcId}\0${e.dstId}\0${e.type}`;
      const sortEdges = (edges: typeof referenceEdges) => [...edges].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
      expect(sortEdges(mismatchedEdges)).toEqual(sortEdges(referenceEdges));
      mismatched.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(test b) a MATCHING-embedder reopen of an already-pinned, backfill-still-pending store still runs the backfill normally during construction — unchanged from before this fix, no ensureEmbedderPin() call needed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-graph-defer-b-"));
    const dbPath = join(dir, "monet.db");
    try {
      const seed = new MonetCore(dbPath, {
        embedder: new HashingEmbeddingProvider(256, 1),
        graphEnabled: false,
        tauAttach: 1.1,
        tauAmbiguous: 1.1,
      });
      await seed.store(TEXT_A, { circle: "c" });
      await seed.store(TEXT_B, { circle: "c" });
      seed.close();

      // Reopen with the SAME (matching) embedder, graph now enabled — the pin already matches, so
      // this must NOT defer. No ensureEmbedderPin() call anywhere in this test — the existing
      // scripts/eval contract, exactly as before this fix.
      const core = new MonetCore(dbPath, {
        embedder: new HashingEmbeddingProvider(256, 1),
        graphEnabled: true,
        tauAttach: 1.1,
        tauAmbiguous: 1.1,
        edgeSimMin: 0.1,
      });
      expect((core as any).pinUnsatisfied).toBe(false); // matches — never armed
      expect(core.edges().length).toBeGreaterThan(0); // backfill ran DURING CONSTRUCTION — before any ensure call could have run it
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(test c) a deferred backfill that's never ensured produces no edges and no crash — the store otherwise serves per the existing guard rules, and a LATER matching-embedder open completes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-graph-defer-c-"));
    const dbPath = join(dir, "monet.db");
    try {
      const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1), graphEnabled: false, tauAttach: 1.1, tauAmbiguous: 1.1 });
      await seed.store(TEXT_A, { circle: "c" });
      await seed.store(TEXT_B, { circle: "c" });
      seed.close();

      const mismatched = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 2), graphEnabled: true });
      expect(mismatched.edges()).toEqual([]); // deferred — no crash, no edges, construction completed fine
      // Never call ensureEmbedderPin(). edges() is a read-only introspection method (not one of
      // assertPinSatisfied's gated call sites — it derives nothing, just reads memory_edge as-is),
      // so it still "serves" per the guard rules exactly as documented: gated operations would throw
      // (proven elsewhere in this file), ungated read-only ones do not.
      mismatched.close();

      // A LATER open with the MATCHING embedder completes the backfill — proving the deferral is
      // genuinely durable (user_version never got bumped past GRAPH_SCHEMA_VERSION), not a
      // one-shot loss of the upgrade slot.
      const later = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1), graphEnabled: true, tauAttach: 1.1, tauAmbiguous: 1.1, edgeSimMin: 0.1 });
      expect((later as any).pinUnsatisfied).toBe(false); // matches — completes normally, synchronously, during THIS construction
      expect(later.edges().length).toBeGreaterThan(0);
      later.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- embedder pin — Codex round 5 (PR #51): empty-store recovery from an unsatisfiable pin ------
//
// FIX O narrows fail-closed's scope: it exists to protect a vector space real data already
// committed to. An EMPTY store has no such commitment, so refusing to serve it forever over an
// unloadable pin (e.g. a 'created' pin stamped from a raw, never-warmed provider whose modelId
// string turned out to be wrong or unreachable — the constructor writes that pin as a bare string
// read off the embedder instance, with NO load attempt of any kind, so nothing catches the mistake
// until the NEXT open tries to actually satisfy it) is pure self-inflicted bricking with nothing to
// show for it. The Shape 9 tests above were updated (insertFakeObservation added) specifically
// because they used to incidentally exercise this exact empty-store case — they now assert the
// invariant they always meant to (fail-closed protects REAL data) on non-empty stores, while this
// block owns the empty-store recovery path explicitly.
describe("embedder pin — empty store with an unsatisfiable pin recovers instead of bricking (Codex review, PR #51 round 5, FIX O)", () => {
  it("(test 1) an empty store pinned to a garbage/unloadable model re-pins to the live constructor embedder on ensureEmbedderPin, and genuinely serves under it afterward", async () => {
    const core = new MonetCore(":memory:", {
      embedder: new HashingEmbeddingProvider(), // the CURRENT, WORKING embedder this store was actually constructed with (tok=2 default)
      embedderLoader: async (modelId) => {
        throw new UnsatisfiableEmbedderError(modelId, `mock: model '${modelId}' cannot be loaded`);
      },
    });
    writePin(core, "Xenova/definitely-does-not-exist-mock", "created"); // simulates the bug: an earlier raw provider's unloadable modelId, stamped with no load attempt
    expect(readPin(core).embedder_model_id).toBe("Xenova/definitely-does-not-exist-mock");

    await core.ensureEmbedderPin(); // must NOT throw — FIX O recovers instead of bricking an empty store

    const pin = readPin(core);
    expect(pin.embedder_model_id).toBe("hashing:dim=256:tok=2"); // re-pinned to the LIVE constructor embedder
    expect(pin.embedder_pin_source).toBe("backfilled");
    expect((core as any).pinUnsatisfied).toBe(false);
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=2"); // this.embedder was never swapped — still the constructor's own instance

    // Round-trip proof, not just field reads: store()/search() actually work now.
    await core.store("fix O empty store recovery round trip test", { circle: "fix-o" });
    const results = await core.search("fix O empty store recovery", { circle: "fix-o" });
    expect(results.length).toBeGreaterThan(0);
    core.close();
  });

  it("(test 2) a NON-empty store with an unsatisfiable pin still fails closed — FIX O's recovery never fires when there's real data to protect, guard stays poisoned exactly like FIX I", async () => {
    const core = new MonetCore(":memory:", {
      embedder: new HashingEmbeddingProvider(),
      embedderLoader: async (modelId) => {
        throw new UnsatisfiableEmbedderError(modelId, `mock: model '${modelId}' cannot be loaded`);
      },
    });
    insertFakeObservation(core, 256); // real data — FIX O's "nothing to protect" rationale does not apply
    writePin(core, "Xenova/definitely-does-not-exist-mock", "created");

    let caught: unknown;
    try {
      await core.ensureEmbedderPin();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    expect((core as any).pinUnsatisfied).toBe(true); // poisoned — FIX I's semantics, untouched by FIX O
    expect(readPin(core).embedder_model_id).toBe("Xenova/definitely-does-not-exist-mock"); // pin NOT rewritten

    // The guard actually gates — same round-trip pattern used throughout this file (FIX 1/FIX C).
    await expect(core.search("anything", { circle: "fix-o" })).rejects.toThrow(EmbedderPinUnsatisfiedError);
    core.close();
  });

  it("(round 9, FIX AB) an empty store pinned to garbage, opened with an ANONYMOUS (no-modelId) embedder: recovery leaves the pin NULL and permits only vector-free reads; a LATER real-id open backfills it correctly afterward", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-fix-ab-anon-recovery-"));
    const dbPath = join(dir, "monet.db");
    try {
      const anonymous: EmbeddingProvider = { dim: 256, embed: (_text: string) => new Float32Array(256) }; // no modelId — same shape as FIX W's/round-8's anonymous-provider tests
      const core = new MonetCore(dbPath, {
        embedder: anonymous,
        embedderLoader: async (modelId) => {
          throw new UnsatisfiableEmbedderError(modelId, `mock: model '${modelId}' cannot be loaded`);
        },
      });
      writePin(core, "Xenova/definitely-does-not-exist-mock", "created"); // simulates the bug: an earlier raw provider's unloadable modelId, stamped with no load attempt
      expect(readPin(core).embedder_model_id).toBe("Xenova/definitely-does-not-exist-mock");

      await core.ensureEmbedderPin(); // must NOT throw — FIX O recovers instead of bricking, AND (FIX AB) must NOT mint dim:256 doing it

      const pin = readPin(core);
      expect(pin.embedder_model_id).toBeNull(); // NOT "dim:256" — the entire point of FIX AB
      expect(pin.embedder_pin_source).toBeNull();
      expect(pin.embedder_pinned_at).toBeNull();
      expect((core as any).pinUnsatisfied).toBe(false); // no cached mismatch; operation-time identity rules still apply

      // Anonymous providers may inspect vector-free state but cannot establish its first space.
      await expect(core.store("fix AB empty store anonymous recovery round trip test", { circle: "fix-ab" }))
        .rejects.toBeInstanceOf(EmbedderIdentityRequiredError);
      const results = await core.search("fix AB empty store anonymous recovery", { circle: "fix-ab" });
      expect(results).toEqual([]);
      core.close();

      // A LATER open with a REAL-id, same-dimension embedder still backfills correctly — the
      // anonymous recovery above never poisoned the pin (it stayed NULL throughout), so the CAS
      // write here succeeds exactly as it would for any other pre-pin store with real evidence.
      const later = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
      expect((later as any).pinUnsatisfied).toBe(false);
      await later.ensureEmbedderPin();
      const laterPin = readPin(later);
      expect(laterPin.embedder_model_id).toBe("hashing:dim=256:tok=1");
      expect(laterPin.embedder_pin_source).toBe("backfilled");
      later.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(test 3) an empty store with a satisfiable pin mismatch still takes the normal swap path — FIX O's recovery branch never fires when the loader succeeds", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() }); // tok=2, empty
    writePin(core, "hashing:dim=256:tok=1", "backfilled"); // satisfiable mismatch — the loader will succeed, not throw

    await core.ensureEmbedderPin(); // real loader — succeeds normally, no failure for FIX O's catch to intercept

    const pin = readPin(core);
    expect(pin.embedder_model_id).toBe("hashing:dim=256:tok=1"); // swapped-TO identity — NOT re-pinned back to the constructor's tok=2
    expect(pin.embedder_pin_source).toBe("backfilled"); // untouched by this UPDATE — FIX O's branch never ran, this is the ORIGINAL write
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=1");
    expect((core as any).pinUnsatisfied).toBe(false);
    core.close();
  });
});

// ---- embedder pin — Codex round 5 (PR #51): adoptEmbedderPin, the operator-intent stamp ----------
//
// FIX N: scripts/migrate-file-concept.ts re-embeds a store's vectors under a CHOSEN embedder
// (--embedder onnx|hashing) but never told the pin machinery about it — so (i) a freshly-migrated
// store backfills to whatever legacy default matches its NEW vectors' dimension on its next served
// open (dimension-only inference can't distinguish the OLD default from the NEW one at the same
// dimension), and (ii) re-running the script against its OWN already-pinned output hits the
// constructor guard (the migration embedder deliberately differs from the pin) and every gated
// source-sync call throws, silently unmigrated. adoptEmbedderPin() is the fix: an explicit,
// synchronous, operator-intent primitive that stamps the CURRENT embedder as the pin by fiat.
describe("embedder pin — adoptEmbedderPin, the operator-intent migration stamp (Codex review, PR #51 round 5, FIX N)", () => {
  const TEXT_A = "the database migration failed due to a lock timeout";
  const TEXT_B = "the schema migration failed because of a connection timeout";

  it("(test 1) a pre-pin store: adoptEmbedderPin writes the pin (source 'migrated') and clears the guard, but deliberately LEAVES a deferred graph backfill pending — it completes only on a later, matching-embedder open (Codex review, PR #51 round 6, FIX R)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-adopt-pin-prepin-"));
    const dbPath = join(dir, "monet.db");
    try {
      // Seed: real content under hashing tok=1, graphEnabled:false (never consumes the one-time
      // graph-backfill upgrade slot — same realistic setup as FIX M's tests), THEN clear the pin to
      // simulate a genuinely pre-ADR store (clearPin — this file's established "predates the pin
      // entirely" convention, e.g. Shapes 2/3/4).
      const seed = new MonetCore(dbPath, {
        embedder: new HashingEmbeddingProvider(256, 1),
        graphEnabled: false,
        tauAttach: 1.1,
        tauAmbiguous: 1.1, // dedup off — two distinct concepts for the graph backfill to actually relate
      });
      await seed.store(TEXT_A, { circle: "c" });
      await seed.store(TEXT_B, { circle: "c" });
      clearPin(seed);
      seed.close();

      // Reopen graph-enabled with the SAME embedder. Pin is NULL (unknown, not "non-NULL and
      // different") so the constructor-time guard stays unarmed — but migrate()'s trustworthiness
      // check (FIX M) sees a NULL pin over a store that already holds vectors and DEFERS: inference
      // hasn't run yet, so no space is yet known-correct, even though this reopen's embedder happens
      // to match what the vectors were actually written with.
      const core = new MonetCore(dbPath, {
        embedder: new HashingEmbeddingProvider(256, 1),
        graphEnabled: true,
        tauAttach: 1.1,
        tauAmbiguous: 1.1,
        edgeSimMin: 0.1,
      });
      expect(readPin(core).embedder_model_id).toBeNull();
      expect((core as any).pinUnsatisfied).toBe(false); // NULL pin never arms the guard
      expect(core.edges()).toEqual([]); // deferred — construction created no edges

      core.adoptEmbedderPin(); // synchronous, no await

      const pin = readPin(core);
      expect(pin.embedder_model_id).toBe("hashing:dim=256:tok=1");
      expect(pin.embedder_pin_source).toBe("migrated");
      expect(typeof pin.embedder_pinned_at).toBe("number");
      expect((core as any).pinUnsatisfied).toBe(false);
      // FIX R: adopt must NOT complete the deferred backfill — at THIS moment the store's VECTORS
      // are still pre-migration (this call runs BEFORE any re-embed work, by FIX N's own design),
      // even though the EMBEDDER identity is now trustworthy. Completing it here would derive edges
      // from the OLD vector space under NEW-space thresholds and permanently consume the one-time
      // version-gated slot on garbage — the exact wrong-space bug FIX M closed, reopened one level
      // up by adopt's own former call to runGraphBackfillIfPending.
      expect(core.edges()).toEqual([]); // slot remains pending — untouched by adopt
      core.close();

      // A LATER, matching-embedder reopen completes it normally through migrate()'s own trustworthy
      // path — by then, in the real migration flow, the script's re-embed pass has already brought
      // the vectors into this same space (or, per FIX R's doc comment, the script's own per-concept
      // rederiveNativeConceptGraph pass has already made every touched concept's edges correct
      // independently of this slot at all).
      const later = new MonetCore(dbPath, {
        embedder: new HashingEmbeddingProvider(256, 1),
        graphEnabled: true,
        tauAttach: 1.1,
        tauAmbiguous: 1.1,
        edgeSimMin: 0.1,
      });
      expect((later as any).pinUnsatisfied).toBe(false);
      expect(later.edges().length).toBeGreaterThan(0); // NOW it completes
      later.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(test 2) an already-pinned store opened with a different embedder (guard armed): adoptEmbedderPin overwrites the pin to the constructor embedder, clears the guard, store()/search() work, and a later matching reopen is satisfied with no ensureEmbedderPin() call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-adopt-pin-mismatch-"));
    const dbPath = join(dir, "monet.db");
    try {
      const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) }); // pins itself 'created' to tok=1
      expect(readPin(seed).embedder_model_id).toBe("hashing:dim=256:tok=1");
      seed.close();

      // Reopen with a DIFFERENT embedder — stands in for "the migration script's --embedder choice
      // deliberately differs from whatever this store happens to be pinned to" (FIX N's exact
      // coupling: once a store IS pinned, re-running the script against its own output must not
      // silently fail under the constructor guard).
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 2) }); // tok=2 — mismatched vs the tok=1 pin
      expect((core as any).pinUnsatisfied).toBe(true); // guard armed at construction — confirms the pre-state independently

      // Prove the guard actually gates BEFORE adopting — the exact failure FIX N closes for the
      // migration script's source-sync loop (storeInternal is a gated call site).
      await expect(core.store("must not silently write under the mismatched embedder", { circle: "fix-n" })).rejects.toThrow(EmbedderPinUnsatisfiedError);

      core.adoptEmbedderPin(); // the operator (the migration script) declares tok=2 the target space

      const pin = readPin(core);
      expect(pin.embedder_model_id).toBe("hashing:dim=256:tok=2"); // overwritten to the CONSTRUCTOR embedder, not merely cleared
      expect(pin.embedder_pin_source).toBe("migrated");
      expect((core as any).pinUnsatisfied).toBe(false);

      // Round-trip proof: write and query both actually work now, not just a cleared flag.
      const stored = await core.store("adopt embedder pin round trip test", { circle: "fix-n" });
      expect(stored.action).not.toBe(undefined);
      const results = await core.search("adopt embedder pin round trip", { circle: "fix-n" });
      expect(results.length).toBeGreaterThan(0);
      core.close();

      // Subsequent reopen with the NEW-matching embedder is satisfied at construction — no
      // ensureEmbedderPin() call anywhere in this branch, proving the stamp is durable, not
      // in-memory-only.
      const later = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 2) });
      expect((later as any).pinUnsatisfied).toBe(false);
      expect(readPin(later).embedder_model_id).toBe("hashing:dim=256:tok=2");
      later.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // (test 3, per the brief — "dry-run-shaped usage absence") is deliberately NOT a new test here:
  // every pre-existing test in this file that never calls adoptEmbedderPin() is that proof already
  // — none of them observe a 'migrated' pin source or a surprise guard-clear, and the full suite
  // passing unchanged after this fix IS the assertion. Adding a redundant no-op test here would only
  // restate what the other 30+ tests in this file already demonstrate by never once calling it.
});

// ---- embedder pin — cross-table dimension mismatch (Codex review, PR #51 round 6, FIX S) --------
//
// A crash mid-re-embed (scripts/migrate-file-concept.ts's step 3: reembedConcept rewrites
// concepts.embedding, then a SEPARATE call, reembedConceptObservations, rewrites that same
// concept's observations.embedding — not atomic together) can leave ONE concept's own row in the
// NEW dimension while its own observations stay in the OLD one, or vice versa. The pre-FIX-S
// either/or sampler (observations preferred, concepts checked ONLY when observations was empty)
// never cross-checked the two tables against each other — it would silently pin whichever table it
// happened to sample, ignoring that the OTHER table disagreed. FIX S unions the distinct dimensions
// found in BOTH tables and fails closed the moment the union holds more than one.
describe("embedder pin — cross-table dimension mismatch now caught (Codex review, PR #51 round 6, FIX S)", () => {
  it("native observations at one dimension (256, alone the ONLY dim in that table) and native concepts at another (384, alone the ONLY dim in that table): UnsatisfiableEmbedderError naming both dims and both tables, no pin written", async () => {
    // Deliberately ONE dimension per table (not a mix WITHIN either table) — this is exactly the
    // shape the pre-FIX-S either/or sampler's own "prefers observations" logic would have sampled
    // as "observations: single dim 256, done" WITHOUT ever looking at concepts, silently ignoring
    // that concepts disagrees at 384. The union-based sampler now sees both and fails closed.
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    insertFakeObservation(core, 256, "fake-obs-256", "statement"); // native — NOT kind='source'
    insertFakeConcept(core, 384, "fake-concept-384", "fact"); // native — NOT kind='source'
    clearPin(core); // simulate: this store predates the embedder-pin ADR, now caught mid-crash

    let caught: unknown;
    try {
      await core.ensureEmbedderPin();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    const err = caught as UnsatisfiableEmbedderError;
    expect(err.message).toMatch(/256/);
    expect(err.message).toMatch(/384/);
    expect(err.message).toMatch(/observations/);
    expect(err.message).toMatch(/concepts/);
    expect(readPin(core).embedder_model_id).toBeNull(); // refused to guess — no pin written
    // The live embedder was never replaced — a failed enforcement must not leave a half-swapped state.
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=2");
    core.close();
  });
});

// ---- embedder pin — old-shape sync_meta table without a singleton row (Codex review, PR #51 -----
// ---- round 6, FIX T) ------------------------------------------------------------------------------
//
// A v8-era store whose sync_meta TABLE already exists (old columns — this codebase's own migrate()
// guards for applying_remote/closure_migrated/clock_mode already handle THAT evolution) but whose
// SINGLETON ROW is absent (its very first open under ANY v8+ code, or a stranded partial-init from
// a crash before the row was ever written) reaches initSyncIdentity()'s `!existing` branch BEFORE
// migrate() ever runs (constructor order: init() -> initSyncIdentity() -> ... -> migrate()). Before
// FIX T, the 3 pin columns were only guarded inside migrate(). Fault-injection-verified TWO distinct
// crash sites this bug produced, both fixed by the SAME relocation: the EMPTY-variant shape hits
// initSyncIdentity's 'created' INSERT, which names embedder_model_id explicitly, and threw "no such
// column: embedder_model_id" right there; the VECTORED-variant shape takes initSyncIdentity's OTHER
// branch (that INSERT deliberately does NOT name the pin columns — see FIX E), so it survives
// initSyncIdentity unharmed but then throws the SAME "no such column" error one step later, inside
// migrate() itself, at the FIX M-era graph-backfill-trustworthiness read (`SELECT embedder_model_id
// FROM sync_meta`). Either way the store could not be opened at all. FIX T moves the guard into
// init(), immediately after sync_meta's CREATE TABLE IF NOT EXISTS, so the columns exist before ANY
// sync_meta write or read — closing both crash sites at once, not just the more obvious one.
//
// Fabricates the OLD shape directly via raw better-sqlite3 (matching this codebase's own
// source-ledger.test.ts convention for exercising a migration path) — a genuinely fresh MonetCore
// construction can't produce "table exists, columns missing, no row" on its own, since init()'s
// CREATE TABLE IF NOT EXISTS always creates the FULL modern column set when the table doesn't exist
// yet; the bug only reproduces when the table already exists in the OLD shape from BEFORE this code
// ever touched it.
function fabricateOldShapeSyncMeta(dbPath: string, opts: { withNativeVector?: boolean } = {}): void {
  const raw = new Database(dbPath);
  try {
    // Exact pre-pin shape: every column migrate() itself already guards for (applying_remote,
    // closure_migrated, clock_mode) present, the 3 pin columns absent, NO singleton row.
    raw.exec(`
      CREATE TABLE sync_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        device_id TEXT NOT NULL,
        last_mutation_at INTEGER NOT NULL,
        applying_remote INTEGER NOT NULL DEFAULT 0,
        closure_migrated INTEGER NOT NULL DEFAULT 0,
        clock_mode TEXT NOT NULL DEFAULT 'wall' CHECK (clock_mode IN ('wall', 'logical'))
      );
    `);
    if (opts.withNativeVector) {
      // Modern observations shape (copied verbatim from init()) — only sync_meta is deliberately
      // old-shaped here; a pre-existing NATIVE vector is what should make FIX E's "legacy-upgrade,
      // don't stamp 'created'" branch fire once the store actually opens.
      raw.exec(`
        CREATE TABLE observations (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          embedding TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'statement',
          circle TEXT NOT NULL DEFAULT 'default',
          concept_id TEXT,
          superseded_by TEXT,
          superseded_at INTEGER,
          session_id TEXT,
          author_agent_id TEXT NOT NULL,
          source_refs TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          sync_revision INTEGER NOT NULL DEFAULT 1,
          sync_writer TEXT
        );
      `);
      raw
        .prepare(`INSERT INTO observations (id, content, embedding, author_agent_id) VALUES (?, ?, ?, ?)`)
        .run("legacy-obs", "pre-existing legacy content", JSON.stringify(new Array(256).fill(0.01)), "legacy-agent");
    }
  } finally {
    raw.close();
  }
}

describe("embedder pin — old-shape sync_meta table without a singleton row does not brick the store (Codex review, PR #51 round 6, FIX T)", () => {
  it("empty variant (no pre-existing vectors): open succeeds, pin gets 'created' against the live embedder — same as an ordinary fresh store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-old-sync-meta-empty-"));
    const dbPath = join(dir, "monet.db");
    try {
      fabricateOldShapeSyncMeta(dbPath); // no vectors — table exists, old shape, no row
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() }); // must not throw
      const pin = readPin(core);
      expect(pin.embedder_model_id).toBe("hashing:dim=256:tok=2");
      expect(pin.embedder_pin_source).toBe("created"); // genuinely empty — treated like a fresh store (FIX E)
      expect((core as any).pinUnsatisfied).toBe(false);
      // Round-trip proof the store is genuinely usable, not just non-throwing at construction.
      await core.store("fix T old-shape sync_meta recovery test", { circle: "fix-t" });
      const results = await core.search("fix T old-shape recovery", { circle: "fix-t" });
      expect(results.length).toBeGreaterThan(0);
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("vectored variant (a pre-existing native vector, simulating a real v8-era store with history): open succeeds, pin stays NULL per FIX E's legacy-upgrade branch — not stamped 'created'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-old-sync-meta-vectored-"));
    const dbPath = join(dir, "monet.db");
    try {
      fabricateOldShapeSyncMeta(dbPath, { withNativeVector: true });
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() }); // must not throw
      const pin = readPin(core);
      expect(pin.embedder_model_id).toBeNull(); // FIX E: legacy vectors present — NOT stamped 'created'
      expect(pin.embedder_pin_source).toBeNull();
      expect((core as any).pinUnsatisfied).toBe(false); // NULL pin never arms the guard

      // ensureEmbedderPin backfills from the pre-existing 256-dim vector, same as any other pre-pin
      // legacy store (Shape 3) — proving the store isn't just openable but genuinely recoverable.
      await core.ensureEmbedderPin();
      const pinAfter = readPin(core);
      expect(pinAfter.embedder_model_id).toBe("hashing:dim=256:tok=1");
      expect(pinAfter.embedder_pin_source).toBe("backfilled");
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- embedder pin — deferCreatedPin suppresses the fresh-store stamp (Codex review, PR #51 -------
// ---- round 7, FIX V) --------------------------------------------------------------------------
//
// scripts/migrate-file-concept.ts's report-only path constructs a MonetCore (schema auto-upgrade is
// unconditional) but promises never to WRITE anything. Against a genuinely vector-free target DB,
// the fresh-store branch would otherwise mint a 'created' pin naming the script's default embedder
// — a plain inspection permanently choosing the store's space. deferCreatedPin makes the fresh-store
// branch write the SAME legacy-shape row a pre-pin store gets, leaving the pin genuinely NULL.
describe("embedder pin — deferCreatedPin suppresses the fresh-store stamp (Codex review, PR #51 round 7, FIX V)", () => {
  it("a fresh store constructed with deferCreatedPin:true gets NULL pin instead of 'created'; guard stays unarmed; a LATER normal open pins via the ordinary empty-store backfill path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-defer-created-pin-"));
    const dbPath = join(dir, "monet.db");
    try {
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(), deferCreatedPin: true });
      const pin = readPin(core);
      expect(pin.embedder_model_id).toBeNull(); // NOT 'hashing:dim=256:tok=2'
      expect(pin.embedder_pin_source).toBeNull();
      expect(pin.embedder_pinned_at).toBeNull();
      expect((core as any).pinUnsatisfied).toBe(false); // NULL pin never arms the guard
      core.close();

      // A LATER normal open (no deferCreatedPin) pins via the SAME empty-store backfill path Shape
      // 4 already covers — source 'backfilled', not 'created', but a genuine, real pin all the same.
      const later = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() });
      expect((later as any).pinUnsatisfied).toBe(false); // still NULL at construction — unarmed
      await later.ensureEmbedderPin();
      const laterPin = readPin(later);
      expect(laterPin.embedder_model_id).toBe("hashing:dim=256:tok=2");
      expect(laterPin.embedder_pin_source).toBe("backfilled");
      later.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deferCreatedPin has no effect on an ALREADY-pinned store (initSyncIdentity's fresh-store branch never runs when the singleton row already exists) — steady state is completely unaffected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-defer-created-pin-noop-"));
    const dbPath = join(dir, "monet.db");
    try {
      const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider() }); // pins itself 'created' normally
      const before = readPin(seed);
      expect(before.embedder_model_id).toBe("hashing:dim=256:tok=2");
      seed.close();

      // Reopen the SAME (already-pinned) store with deferCreatedPin:true — the flag only ever
      // matters for a store whose singleton row doesn't exist yet; this store's does.
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(), deferCreatedPin: true });
      expect(readPin(core)).toEqual(before); // byte-identical — no rewrite of any kind
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- embedder pin — anonymous (no-modelId) providers must not mint a dim:N 'created' pin ----------
// ---- (Codex review, PR #51 round 7, FIX W) ---------------------------------------------------
//
// embedderModelId's dim:N fallback (`this.embedder.modelId ?? \`dim:${this.embedder.dim}\``) is a
// COMPARISON convenience for the graft-rejection check, never a persistable identity — any other
// anonymous provider of the SAME dimension satisfies it trivially later regardless of how
// differently it actually embeds text, making the constructor-time guard vacuously pass for exactly
// the population most likely to differ from each other in ways only their body matters.
describe("embedder pin — anonymous providers (no modelId) must not mint a dim:N 'created' pin (Codex review, PR #51 round 7, FIX W)", () => {
  it("a fresh store constructed with an anonymous (no-modelId) embedder gets NULL pin instead of a dim:N 'created' stamp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-anon-embedder-pin-"));
    const dbPath = join(dir, "monet.db");
    try {
      const anonymous: EmbeddingProvider = { dim: 256, embed: (_text: string) => new Float32Array(256) }; // no modelId — matches va-ranking-probe.test.ts's makeStubEmbedder shape
      const core = new MonetCore(dbPath, { embedder: anonymous });
      const pin = readPin(core);
      expect(pin.embedder_model_id).toBeNull(); // NOT "dim:256"
      expect(pin.embedder_pin_source).toBeNull();
      expect((core as any).pinUnsatisfied).toBe(false); // NULL pin never arms the guard
      core.close();

      // Later opened with a REAL-id provider (same dim): ordinary empty-store backfill semantics
      // apply — pins to the live embedder's own real id, source 'backfilled', not the anonymous
      // provider's ephemeral dim:256 label (which was never persisted in the first place).
      const later = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
      expect((later as any).pinUnsatisfied).toBe(false);
      await later.ensureEmbedderPin();
      const laterPin = readPin(later);
      expect(laterPin.embedder_model_id).toBe("hashing:dim=256:tok=1");
      expect(laterPin.embedder_pin_source).toBe("backfilled");
      later.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(round 8, closes a finding flagged during this same round) an ALREADY pre-pin, empty store opened with an anonymous embedder: ensureEmbedderPin leaves the pin NULL and permits only vector-free reads — a LATER real-id embedder still backfills correctly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-anon-embedder-backfill-"));
    const dbPath = join(dir, "monet.db");
    try {
      // Build a genuinely pre-pin, empty store (clearPin simulates "predates the ADR entirely" —
      // this file's established convention, e.g. Shapes 2/3/4) using an anonymous embedder. This
      // exercises backfillEmbedderPin's dim===null branch directly via ensureEmbedderPin, distinct
      // from the fresh-store 'created' path the test above covers.
      const anonymous: EmbeddingProvider = { dim: 256, embed: (_text: string) => new Float32Array(256) };
      const core = new MonetCore(dbPath, { embedder: anonymous });
      clearPin(core);
      expect(readPin(core).embedder_model_id).toBeNull();
      expect((core as any).pinUnsatisfied).toBe(false); // NULL pin never arms the guard

      await core.ensureEmbedderPin(); // hits backfillEmbedderPin's dim===null branch — MUST NOT throw, MUST NOT write

      const pinAfter = readPin(core);
      expect(pinAfter.embedder_model_id).toBeNull(); // STILL NULL — nothing weak (dim:256) was persisted
      expect(pinAfter.embedder_pin_source).toBeNull();
      expect(pinAfter.embedder_pinned_at).toBeNull();
      expect((core as any).pinUnsatisfied).toBe(false); // no cached mismatch; operation-time identity rules still apply

      // Vector-free reads remain supported; persistence needs a stable identity.
      await expect(core.store("round 8 empty-store anonymous-embedder backfill test", { circle: "r8" }))
        .rejects.toBeInstanceOf(EmbedderIdentityRequiredError);
      const results = await core.search("round 8 empty-store anonymous", { circle: "r8" });
      expect(results).toEqual([]);
      core.close();

      // A LATER open with a REAL-id, same-dimension embedder still backfills correctly — the
      // anonymous open above never poisoned the pin (it stayed NULL throughout), so the CAS write
      // here succeeds exactly as it would for any other pre-pin store with real evidence.
      const later = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
      expect((later as any).pinUnsatisfied).toBe(false);
      await later.ensureEmbedderPin();
      const laterPin = readPin(later);
      expect(laterPin.embedder_model_id).toBe("hashing:dim=256:tok=1");
      expect(laterPin.embedder_pin_source).toBe("backfilled");
      later.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- embedder pin — satisfied-pin validation (Codex review, PR #51 round 8, FIX AA) --------------
//
// "The pin's modelId string matches the constructor embedder's modelId string" is an identity
// claim, not a capability claim — embedderModelId is a bare string read off the embedder instance
// at construction, with no load attempt of any kind. A raw, never-warmed provider (or any custom
// async provider) whose model can't actually load would satisfy that string comparison trivially.
// ensureEmbedderPin's satisfied branch now runs a real validation embed before clearing the guard,
// exactly mirroring what the swap branch already gets for free via instantiateEmbedderForPin's own
// warmup. The existing steady-state coverage — "(c) steady state (pin already satisfied): thresholds
// are byte-identical and the recompute path never runs" (this file, threshold re-derivation describe
// block) — already proves the working-provider case is unaffected: it spies on
// applyEmbedderDerivedThresholds specifically, a DIFFERENT method than the one FIX AA adds a call
// to, so it keeps passing for the right reason, not by accident.
describe("embedder pin — satisfied-pin validation (Codex review, PR #51 round 8, FIX AA)", () => {
  it("a satisfied pin (modelId matches the constructor embedder) whose embedder fails to actually produce a vector: ensureEmbedderPin rejects, the guard is poisoned, and the pin itself stays untouched — NOT re-pinned, since FIX O's recovery deliberately does not apply here", async () => {
    const brokenButMatching: EmbeddingProvider = {
      dim: 384,
      modelId: "broken-but-matching-model",
      embed: async (_text: string) => {
        throw new Error("model session crashed");
      },
    };
    // Genuinely EMPTY store (:memory:, zero store() calls ever) — deliberately the exact shape FIX
    // O recovers for a SWAP failure, to prove that recovery does NOT extend to this branch: the
    // live embedder itself is the one that just failed, so there is nothing safe to fall back to.
    const core = new MonetCore(":memory:", { embedder: brokenButMatching });
    // Fresh store pins itself 'created' to this SAME modelId at construction (a real modelId, so
    // FIX W's anonymous-provider check doesn't apply either) — pinnedModelId === this.embedderModelId
    // is trivially true inside ensureEmbedderPin, taking the satisfied branch.
    expect(readPin(core).embedder_model_id).toBe("broken-but-matching-model");
    expect((core as any).pinUnsatisfied).toBe(false); // matches by construction — guard starts unarmed

    let caught: unknown;
    try {
      await core.ensureEmbedderPin();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    expect((caught as UnsatisfiableEmbedderError).modelId).toBe("broken-but-matching-model");
    expect((caught as Error).message).toMatch(/matches the constructor-provided/i);
    expect((caught as UnsatisfiableEmbedderError).cause).toBeInstanceOf(Error);
    expect((caught as { cause: Error }).cause.message).toMatch(/model session crashed/);
    expect((core as any).pinUnsatisfied).toBe(true); // poisoned — guard now armed even though the PIN never changed

    // Not re-pinned (no FIX O recovery here) — the persisted value is exactly what it was before
    // this call, proving this is a validation failure, not a re-pin decision.
    const pinAfter = readPin(core);
    expect(pinAfter.embedder_model_id).toBe("broken-but-matching-model");
    expect(pinAfter.embedder_pin_source).toBe("created");

    // The guard actually gates — same round-trip pattern used throughout this file.
    await expect(core.search("anything", { circle: "fix-aa" })).rejects.toThrow(EmbedderPinUnsatisfiedError);
    core.close();
  });

  it("the served-path choke point actually rejects too: createMonetCoreMcpServer fails to start when the satisfied-pin validation fails", async () => {
    const brokenButMatching: EmbeddingProvider = {
      dim: 384,
      modelId: "broken-but-matching-model-2",
      embed: async (_text: string) => {
        throw new Error("model session crashed");
      },
    };
    const core = new MonetCore(":memory:", { embedder: brokenButMatching });
    await expect(createMonetCoreMcpServer(core)).rejects.toThrow(UnsatisfiableEmbedderError);
    core.close();
  });

  // The genuinely-WORKING-provider case (steady state must stay completely unaffected) is
  // deliberately NOT a new test here — see this describe block's own header comment: "(c) steady
  // state (pin already satisfied): thresholds are byte-identical and the recompute path never
  // runs" (this file's threshold re-derivation describe block, above) already proves it, spying on
  // applyEmbedderDerivedThresholds specifically — a method FIX AA's validation embed never calls —
  // so it keeps passing for the right reason, not by accident. Adding a redundant test here would
  // only restate what that test already demonstrates.
});

// ---- embedder pin — dim-sized vector writes are gated too (Codex review, PR #51 round 9, --------
// ---- FIX AC) --------------------------------------------------------------------------------
//
// recomputeNativeConceptProjection's empty-observation branch writes `new Float32Array(this.
// embedder.dim)` directly into concepts.embedding, with no embed() call for any existing gate to
// catch. A wrong-dimension write from an unensured mismatched core corrupts that row for every
// FUTURE cosine comparison against it, not just the write itself — the FIX H audit's threshold-
// comparison lens correctly found no bestMatches/cosine call in this method and moved on, missing
// that a dim-sized WRITE is its own hazard. Gated at the method's own top (assertPinSatisfied),
// covering all 4 callers: resolveContradiction and supersedeObservation (newly protected here),
// restoreConcept and graftRows (already independently gated for their own reasons).
describe("embedder pin — dim-sized vector writes are gated too (Codex review, PR #51 round 9, FIX AC)", () => {
  it("a pinned store's ONLY observation, terminally superseded by an UNENSURED core with a GENUINELY DIFFERENT dimension: supersedeObservation throws EmbedderPinUnsatisfiedError BEFORE writing a wrong-dimension zero vector — the whole operation is atomic (supersedeObservation's own pre-existing db.transaction wrapper also covers the now-gated recomputeNativeConceptProjection call), so nothing is left half-mutated; after ensureEmbedderPin, the identical call succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-fix-ac-dim-write-"));
    const dbPath = join(dir, "monet.db");
    try {
      const seed = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
      const stored = await seed.store("a lone fact whose only observation will be terminally superseded", { circle: "fix-ac" });
      seed.close();

      // Reopen with a MISMATCHED, UNENSURED embedder of a GENUINELY DIFFERENT DIMENSION (384, not
      // 256) — guard armed at construction, ensureEmbedderPin never called. A real dim delta (not
      // just a different tokenizer version at the same dim) is deliberate here: it makes the
      // "wrong-dimension write" hazard this fix closes unambiguous under fault injection (below) —
      // a corrupted write is provably 384-long against a store pinned to 256, not just "some other
      // vector space at the same length."
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(384, 1) });
      expect((core as any).pinUnsatisfied).toBe(true);

      // Terminal supersession of this concept's ONLY observation drives its active-observation
      // count to zero, reaching recomputeNativeConceptProjection's empty-observation branch — the
      // exact dim-sized zero-vector write FIX AC gates.
      expect(() => core.supersedeObservation(stored.observationId, null)).toThrow(EmbedderPinUnsatisfiedError);

      // The WHOLE operation rolled back — confirmed directly, not assumed: supersedeObservation's
      // own body (engine.ts) is wrapped in ONE db.transaction() that also covers the now-gated
      // recomputeNativeConceptProjection call, so the earlier UPDATE observations SET
      // superseded_by/superseded_at never committed either.
      const obsRow = (core as any).db.prepare(`SELECT superseded_by, superseded_at FROM observations WHERE id = ?`).get(stored.observationId) as {
        superseded_by: string | null;
        superseded_at: number | null;
      };
      expect(obsRow.superseded_by).toBeNull();
      expect(obsRow.superseded_at).toBeNull();

      // The concept's embedding is UNTOUCHED too — still 256-long (the original, correctly-pinned
      // vector), not overwritten with a 384-long zero vector from the mismatched core.
      const conceptRow = (core as any).db.prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(stored.conceptId) as { embedding: string };
      expect((JSON.parse(conceptRow.embedding) as number[]).length).toBe(256);

      await core.ensureEmbedderPin(); // swaps this.embedder to the real, pin-satisfying dim=256/tok=1
      expect((core as any).pinUnsatisfied).toBe(false);

      const result = core.supersedeObservation(stored.observationId, null); // the IDENTICAL call now succeeds
      expect(result.terminal).toBe(true);
      expect(result.alreadySuperseded).toBe(false);
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- embedder-width guard slice: inspectEmbeddingWidths, assertWriteWidthSatisfied, ------------
// ---- abandonEmbedderMigration -------------------------------------------------------------------
//
// The pin guard above (assertPinSatisfied) is never armed by a NULL pin — see test (b)'s own
// comment. That leaves a genuinely-unpinned store free to accept writes of ANY width until
// ensureEmbedderPin() is finally awaited, which is exactly the createLocalEmbedderWithProvenance
// ONNX<->hashing flip-flop failure mode (embedding-onnx.ts). This section covers: (1)
// inspectEmbeddingWidths(), a public non-throwing width inventory (never unions native/source, never
// throws on the mixed case it exists to describe); (2) assertWriteWidthSatisfied's population
// scoping (native vs source checked independently); (3) abandonEmbedderMigration(), the recovery
// path for an interrupted migration whose sentinel+pin were stamped before any vector was rewritten.
describe("embedder pin — inspectEmbeddingWidths, a non-throwing width inventory (embedder-width guard slice, task 1)", () => {
  it("reports an empty store as all-empty arrays", () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    expect(core.inspectEmbeddingWidths()).toEqual({
      observationDims: [],
      conceptDims: [],
      sourceObservationDims: [],
      sourceConceptDims: [],
      malformed: {
        nativeObservations: { count: 0, sampleIds: [] },
        nativeConcepts: { count: 0, sampleIds: [] },
        sourceObservations: { count: 0, sampleIds: [] },
        sourceConcepts: { count: 0, sampleIds: [] },
      },
    });
    core.close();
  });

  it("rejects a malformed-only unpinned legacy store before pin CAS and leaves the pin unchanged", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    clearPin(core);
    insertFakeConcept(core, 256, "malformed-only", "fact");
    (core as any).db.prepare(`UPDATE concepts SET embedding='[null]' WHERE id='malformed-only'`).run();
    await expect(core.ensureEmbedderPin()).rejects.toBeInstanceOf(MalformedEmbeddingStoreError);
    expect(readPin(core)).toEqual({ embedder_model_id: null, embedder_pin_source: null, embedder_pinned_at: null });
    core.close();
  });

  it("reports native and source vector widths SEPARATELY, in both directions, and never throws on the exact mixed-width shape sampleStoredVectorDim refuses to look at", () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    // Native evidence at TWO different widths (the exact shape sampleStoredVectorDim throws on) —
    // inspectEmbeddingWidths must report BOTH, not throw, and not touch the pin.
    insertFakeObservation(core, 256, "native-256", "statement");
    insertFakeObservation(core, 384, "native-384", "statement");
    // Source evidence at a SINGLE, DIFFERENT width — proving native/source are reported separately,
    // not unioned (a union would contaminate one population's array with the other's width).
    insertFakeObservation(core, 512, "source-obs-512", "source");
    insertFakeConcept(core, 512, "source-concept-512", "source");

    const widths = core.inspectEmbeddingWidths();
    // Asserted in the order the interface documents (ascending, via the query's own `ORDER BY dim`)
    // — NOT re-sorted first, which would defeat the very guarantee this test is meant to confirm.
    expect(widths.observationDims).toEqual([256, 384]);
    expect(widths.conceptDims).toEqual([]);
    expect(widths.sourceObservationDims).toEqual([512]);
    expect(widths.sourceConceptDims).toEqual([512]);
    expect(widths.malformed).toEqual({
      nativeObservations: { count: 0, sampleIds: [] },
      nativeConcepts: { count: 0, sampleIds: [] },
      sourceObservations: { count: 0, sampleIds: [] },
      sourceConcepts: { count: 0, sampleIds: [] },
    });
    // Never throws (unlike sampleStoredVectorDim on this exact native shape), and never writes a
    // pin — a pure read.
    expect(readPin(core).embedder_model_id).toBe("hashing:dim=256:tok=2"); // untouched — still the 'created' pin from construction
    core.close();
  });

  it("reports every malformed live role without throwing and makes read, write, and graft proofs fail closed", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(), tauAttach: 1.1 });
    const native = await core.store("native malformed-vector fixture", { resolution: "forceNew" });
    insertFakeConcept(core, 256, "malformed-live-source-concept", "source");
    insertFakeObservation(core, 256, "malformed-live-source-observation", "source", "malformed-live-source-concept");
    insertFakeSourceChunk(core, "malformed-live-source-observation", "active", "malformed-live-source-chunk", "malformed-live-source-concept");
    const db = (core as any).db;
    db.prepare(`UPDATE observations SET embedding=? WHERE id=?`).run(`{"not":"an array"}`, native.observationId);
    db.prepare(`UPDATE concepts SET embedding=? WHERE id=?`).run(`[1,null]`, native.conceptId);
    db.prepare(`UPDATE observations SET embedding=? WHERE id=?`).run(`[1,"2"]`, "malformed-live-source-observation");
    db.prepare(`UPDATE concepts SET embedding=? WHERE id=?`).run(`not-json`, "malformed-live-source-concept");

    try {
      const inventory = core.inspectEmbeddingWidths();
      expect(inventory.malformed).toEqual({
        nativeObservations: { count: 1, sampleIds: [native.observationId] },
        nativeConcepts: { count: 1, sampleIds: [native.conceptId] },
        sourceObservations: { count: 1, sampleIds: ["malformed-live-source-observation"] },
        sourceConcepts: { count: 1, sampleIds: ["malformed-live-source-concept"] },
      });
      await expect(core.search("must diagnose before reading")).rejects.toBeInstanceOf(MalformedEmbeddingStoreError);
      await expect(core.store("must diagnose before writing", { resolution: "forceNew" })).rejects.toBeInstanceOf(MalformedEmbeddingStoreError);

      const peer = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
      try {
        await peer.store("valid peer graft row", { resolution: "forceNew" });
        expect(() => core.graftRows(peer.exportDelta(0))).toThrow(MalformedEmbeddingStoreError);
      } finally {
        peer.close();
      }
    } finally {
      core.close();
    }
  });

  it("excludes malformed dead source residue from diagnostics and live width proof", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(), tauAttach: 1.1 });
    insertFakeConcept(core, 256, "dead-source-concept", "source");
    insertFakeObservation(core, 256, "dead-source-observation", "source", "dead-source-concept");
    insertFakeSourceChunk(core, "dead-source-observation", "superseded", "dead-source-chunk", "dead-source-concept");
    const db = (core as any).db;
    db.prepare(`UPDATE concepts SET status='retired', embedding='not-json' WHERE id='dead-source-concept'`).run();
    db.prepare(`UPDATE observations SET embedding='[null]' WHERE id='dead-source-observation'`).run();
    try {
      expect(core.inspectEmbeddingWidths().malformed).toEqual({
        nativeObservations: { count: 0, sampleIds: [] },
        nativeConcepts: { count: 0, sampleIds: [] },
        sourceObservations: { count: 0, sampleIds: [] },
        sourceConcepts: { count: 0, sampleIds: [] },
      });
      await expect(core.store("live write ignores proven-dead source residue", { resolution: "forceNew" })).resolves.toMatchObject({
        action: "created",
      });
      await expect(core.search("live read ignores proven-dead source residue")).resolves.toBeDefined();
    } finally {
      core.close();
    }
  });
});

describe("embedder pin — ordinary writes arbitrate one live semantic vector space", () => {
  it("an unpinned native 256 store rejects its first source 384 write, and pin backfill cannot bless the resulting mixed native/source shape", async () => {
    const core = new MonetCore(":memory:", { embedder: new FakeOnnxLikeProvider() });
    insertFakeObservation(core, 256, "native-256", "statement");
    clearPin(core);

    let caught: unknown;
    try {
      await core.storeSource("the first source chunk", { sourceRefs: ["source://embedder-width-guard-test"] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedderPinUnsatisfiedError);
    expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE kind = 'source'`).get().n).toBe(0);
    expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'source'`).get().n).toBe(0);

    // Fabricate the damage an old binary could already have left. Backfill must union native and
    // live source evidence and fail closed rather than blessing either half.
    insertFakeObservation(core, 384, "source-384", "source");
    await expect(core.ensureEmbedderPin()).rejects.toBeInstanceOf(UnsatisfiableEmbedderError);
    expect(readPin(core).embedder_model_id).toBeNull();
    core.close();
  });

  it("NIT coverage — a genuinely-unpinned store with NO existing evidence for the relevant population accepts the write and establishes the ambient width, rather than throwing on an empty comparison set", async () => {
    // Fresh store pins itself 'created' to the live embedder at construction — clear it to simulate
    // a genuinely pre-pin store, exactly as the shared-space test above does. Unlike that test,
    // this store holds NO evidence in EITHER population yet: `existing.size === 0` inside
    // assertWriteWidthSatisfied, previously uncovered by any test.
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    clearPin(core);
    expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(0);
    expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM concepts`).get().n).toBe(0);

    const stored = await core.store("the very first write to a genuinely empty, genuinely unpinned store");
    expect(stored.conceptId).toBeTruthy();
    expect(readPin(core).embedder_model_id).toBe("hashing:dim=256:tok=2");
    core.close();
  });
});

describe("embedder pin — durable write arbitration across live instances", () => {
  it("a stale 384 instance fails closed after another instance pins the empty store to hashing tok1/256", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-stale-instance-"));
    const dbPath = join(dir, "monet.db");
    try {
      const stale = new MonetCore(dbPath, { embedder: new FakeOnnxLikeProvider(), deferCreatedPin: true });
      const winner = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(256, 1) });
      await winner.store("the hashing writer establishes the empty store");
      expect(readPin(winner).embedder_model_id).toBe("hashing:dim=256:tok=1");

      await expect(stale.store("the stale 384 writer must not commit")).rejects.toBeInstanceOf(EmbedderPinUnsatisfiedError);
      expect((stale as any).pinUnsatisfied).toBe(true);
      expect((winner as any).db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(1);
      stale.close();
      winner.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes two file-backed first writers with different widths so at most one commits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-pin-width-race-"));
    const dbPath = join(dir, "monet.db");
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const provider = (modelId: string, dim: number): EmbeddingProvider => ({
      modelId,
      dim,
      async embed(): Promise<Float32Array> {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
        return new Float32Array(dim).fill(0.25);
      },
    });
    try {
      const first = new MonetCore(dbPath, { embedder: provider("race:384", 384), deferCreatedPin: true });
      const second = new MonetCore(dbPath, { embedder: provider("race:256", 256), deferCreatedPin: true });
      const results = await Promise.allSettled([
        first.store("first racing write"),
        second.store("second racing write"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejection).toBeDefined();
      expect(
        rejection!.reason instanceof EmbedderPinUnsatisfiedError || rejection!.reason instanceof EmbedderWidthConflictError,
      ).toBe(true);
      const db = (first as any).db;
      expect(db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(1);
      const persistedWidth = db.prepare(`SELECT json_array_length(embedding) AS dim FROM observations`).get().dim;
      const pin = readPin(first).embedder_model_id;
      expect([256, 384]).toContain(persistedWidth);
      expect(pin).toBe(persistedWidth === 256 ? "race:256" : "race:384");
      first.close();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a committed operation receipt before pin validation or embedding after drift", async () => {
    const embedder = new HashingEmbeddingProvider(256, 1);
    const embedSpy = vi.spyOn(embedder, "embed");
    const core = new MonetCore(":memory:", { embedder });
    const first = await core.store("idempotent receipt", { operationId: "width-guard-receipt" });
    expect(embedSpy).toHaveBeenCalledTimes(1);
    writePin(core, "different:384", "migrated");

    await expect(core.store("ignored retry body", { operationId: "width-guard-receipt" })).resolves.toEqual(first);
    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(1);
    core.close();
  });
});

describe("embedder pin — already-mixed stores reject every ordinary write", () => {
  for (const attemptedWidth of [256, 384]) {
    it(`rejects a ${attemptedWidth}-dimensional write against live {256,384} evidence, even though it matches one member`, async () => {
      const core = new MonetCore(":memory:", {
        embedder: attemptedWidth === 256 ? new HashingEmbeddingProvider(256, 1) : new FakeOnnxLikeProvider(),
      });
      insertFakeObservation(core, 384, "native-384");
      insertFakeObservation(core, 256, "native-256");
      clearPin(core);

      let caught: unknown;
      try {
        await core.store(`ordinary ${attemptedWidth}-dimensional write`);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(EmbedderPinUnsatisfiedError);
      expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(2);
      core.close();
    });
  }
});

describe("embedder pin — recomputeNativeConceptProjection uses the actual projection width", () => {
  it("a nonempty unpinned store refuses even a same-width centroid rewrite until identity is explicitly established", async () => {
    // Genuinely unpinned (the constructor's cached mismatch flag stays clear), live embedder
    // 384-dim, but ALL stored native evidence is 256-dim. The operation-time durable gate must
    // still reject this exact "NULL pin, drifted embedder" shape.
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(384, 1) });
    clearPin(core);
    insertFakeConcept(core, 256, "c1", "fact");
    insertFakeObservation(core, 256, "obs-a", "statement", "c1");
    insertFakeObservation(core, 256, "obs-b", "statement", "c1"); // TWO active observations

    expect(() => core.supersedeObservation("obs-a", null)).toThrow(EmbedderPinUnsatisfiedError);
    const obs = (core as any).db.prepare(`SELECT superseded_by, superseded_at FROM observations WHERE id = 'obs-a'`).get();
    expect(obs).toMatchObject({ superseded_by: null, superseded_at: null });
    core.close();
  });

  it("(regression guard) the SAME drifted store still correctly throws EmbedderWidthConflictError when it genuinely reaches the empty-observation branch — proving the fix narrows the gate rather than removing it", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(384, 1) });
    clearPin(core);
    insertFakeConcept(core, 256, "c1", "fact");
    insertFakeObservation(core, 256, "obs-a", "statement", "c1"); // the ONLY observation

    let caught: unknown;
    try {
      // Terminal supersession of the ONLY observation drives active-observation count to zero —
      // recomputeNativeConceptProjection's EMPTY-observation branch, which DOES introduce a new
      // width (this.embedder.dim = 384) and must still be gated.
      core.supersedeObservation("obs-a", null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedderPinUnsatisfiedError);
    // Nothing mutated: the whole operation rolled back inside supersedeObservation's own transaction.
    const obsRow = (core as any).db.prepare(`SELECT superseded_by, superseded_at FROM observations WHERE id = ?`).get("obs-a") as {
      superseded_by: string | null;
      superseded_at: number | null;
    };
    expect(obsRow.superseded_by).toBeNull();
    expect(obsRow.superseded_at).toBeNull();
    core.close();
  });
});

describe("embedder pin — MAJOR 6 fix: width-guard coverage for the two remaining gate sites (saveWorkstream, recomputeSourceConceptBody) — 'exactly these four sites' was load-bearing and previously unenforced by any test", () => {
  it("saveWorkstream throws EmbedderWidthConflictError on a genuinely-unpinned store whose existing native evidence disagrees with the live embedder's width", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(384, 1) });
    insertFakeObservation(core, 256, "native-obs", "statement"); // disagrees with the live 384-dim embedder
    clearPin(core);

    let caught: unknown;
    try {
      await core.saveWorkstream({ status: "active", nextSteps: ["should never be written"] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedderPinUnsatisfiedError);
    // Nothing was written by the rejected write.
    expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind = 'workstream'`).get().n).toBe(0);
    core.close();
  });

  it("recomputeSourceConceptBody revalidates the shared width inside its write transaction", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(384, 1) });
    insertFakeConcept(core, 256, "source-concept", "source");
    insertFakeObservation(core, 256, "source-obs", "source", "source-concept");
    insertFakeSourceChunk(core, "source-obs", "active", "source-chunk", "source-concept");
    clearPin(core);

    let caught: unknown;
    try {
      await core.recomputeSourceConceptBody("source-concept");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedderPinUnsatisfiedError);
    core.close();
  });
});

describe("embedder pin — complete ordinary semantic-mutation closure", () => {
  it("rejects same-width identity drift on a nonempty unpinned store until ensureEmbedderPin backfills and loads the known legacy identity", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 2) });
    insertFakeObservation(core, 256, "legacy-tok1");
    clearPin(core);

    await expect(core.store("tok2 must not be inferred safe merely because it is also 256-dimensional"))
      .rejects.toBeInstanceOf(EmbedderPinUnsatisfiedError);
    expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(1);

    await core.ensureEmbedderPin();
    expect(readPin(core).embedder_model_id).toBe("hashing:dim=256:tok=1");
    await expect(core.store("the explicitly backfilled tok1 identity may now write")).resolves.toBeTruthy();
    core.close();
  });

  for (const population of ["native", "source"] as const) {
    it(`rejects ${population} provider output whose actual width disagrees with declared dim before semantic mutation`, async () => {
      const malformed: EmbeddingProvider = {
        modelId: `test:malformed:${population}`,
        dim: 256,
        async embed() { return new Float32Array(384).fill(0.25); },
      };
      const core = new MonetCore(":memory:", { embedder: malformed });
      const write = population === "native"
        ? core.store("malformed native output")
        : core.storeSource("malformed source output", { sourceRefs: ["source://malformed-output"] });

      let caught: unknown;
      try { await write; } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(EmbedderOutputDimensionError);
      expect((caught as EmbedderOutputDimensionError).declaredWidth).toBe(256);
      expect((caught as EmbedderOutputDimensionError).actualWidth).toBe(384);
      expect((caught as EmbedderOutputDimensionError).population).toBe(population);
      expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(0);
      expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM concepts`).get().n).toBe(0);
      core.close();
    });
  }

  it("detach rejects a directly mixed live store at its final transactional mutation boundary", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    insertFakeConcept(core, 256, "detach-src");
    insertFakeObservation(core, 256, "detach-256", "statement", "detach-src");
    insertFakeObservation(core, 384, "detach-384", "statement", "detach-src");

    await expect(core.detach("detach-src", ["detach-384"])).rejects.toBeInstanceOf(EmbedderWidthConflictError);
    expect((core as any).db.prepare(`SELECT concept_id FROM observations WHERE id = 'detach-384'`).get().concept_id).toBe("detach-src");
    expect(core.inspectEmbeddingWidths().observationDims).toEqual([256, 384]);
    core.close();
  });

  it("reassign merge rejects a directly mixed live store before blending or deleting either concept", () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    insertFakeConcept(core, 256, "merge-src");
    insertFakeConcept(core, 256, "merge-target");
    (core as any).db.prepare(`UPDATE concepts SET circle = 'destination' WHERE id = 'merge-target'`).run();
    insertFakeObservation(core, 256, "merge-src-obs", "statement", "merge-src");
    insertFakeObservation(core, 384, "merge-mixed-obs", "statement", "merge-target");

    expect(() => core.reassignCircle("merge-src", "destination")).toThrow(EmbedderWidthConflictError);
    expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE id IN ('merge-src', 'merge-target')`).get().n).toBe(2);
    expect(core.inspectEmbeddingWidths().observationDims).toEqual([256, 384]);
    core.close();
  });

  it("detach rechecks after a competing connection commits between its outer gate and BEGIN IMMEDIATE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-detach-width-race-"));
    const dbPath = join(dir, "monet.db");
    try {
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(), graphEnabled: false });
      const first = await core.store("detach race first observation", { resolution: "forceNew" });
      const second = await core.store("detach race second observation", { attachTo: first.conceptId });
      const port = (core as any).db;
      const originalImmediate = port.immediateTransaction.bind(port);
      let injected = false;
      port.immediateTransaction = (fn: (...args: any[]) => any) => (...args: any[]) => {
        if (!injected) {
          injected = true;
          const external = new Database(dbPath);
          try {
            external.prepare(
              `INSERT INTO observations (id, content, embedding, author_agent_id, kind)
               VALUES ('detach-race-384', 'racing corruption', ?, 'other-process', 'statement')`,
            ).run(JSON.stringify(new Array(384).fill(0.01)));
          } finally {
            external.close();
          }
        }
        return originalImmediate(fn)(...args);
      };

      await expect(core.detach(first.conceptId, [second.observationId])).rejects.toBeInstanceOf(EmbedderWidthConflictError);
      expect(port.prepare(`SELECT concept_id FROM observations WHERE id = ?`).get(second.observationId).concept_id).toBe(first.conceptId);
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reassign merge rechecks after a competing connection commits between scoring and BEGIN IMMEDIATE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-reassign-width-race-"));
    const dbPath = join(dir, "monet.db");
    try {
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(), graphEnabled: false });
      const source = await core.store("identical merge race body", { circle: "source", resolution: "forceNew" });
      const target = await core.store("identical merge race body", { circle: "destination", resolution: "forceNew" });
      const port = (core as any).db;
      const originalImmediate = port.immediateTransaction.bind(port);
      let injected = false;
      port.immediateTransaction = (fn: (...args: any[]) => any) => (...args: any[]) => {
        if (!injected) {
          injected = true;
          const external = new Database(dbPath);
          try {
            external.prepare(
              `INSERT INTO observations (id, content, embedding, author_agent_id, kind)
               VALUES ('reassign-race-384', 'racing corruption', ?, 'other-process', 'statement')`,
            ).run(JSON.stringify(new Array(384).fill(0.01)));
          } finally {
            external.close();
          }
        }
        return originalImmediate(fn)(...args);
      };

      expect(() => core.reassignCircle(source.conceptId, "destination")).toThrow(EmbedderWidthConflictError);
      expect(port.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE id IN (?, ?)`).get(source.conceptId, target.conceptId).n).toBe(2);
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses one full inventory across steady-state writes and rechecks after a second connection commits relevant corruption", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-width-proof-cache-"));
    const dbPath = join(dir, "monet.db");
    try {
      const core = new MonetCore(dbPath, { embedder: new HashingEmbeddingProvider(), graphEnabled: false });
      const inventory = vi.spyOn(core, "inspectEmbeddingWidths");
      for (let i = 0; i < 12; i++) {
        await core.store(`steady-state write ${i}`, { resolution: "forceNew" });
      }
      expect(inventory).toHaveBeenCalledTimes(1);

      const external = new Database(dbPath);
      try {
        external.prepare(
          `INSERT INTO observations (id, content, embedding, author_agent_id, kind)
           VALUES ('external-384', 'external corruption', ?, 'other-process', 'statement')`,
        ).run(JSON.stringify(new Array(384).fill(0.01)));
      } finally {
        external.close();
      }

      await expect(core.store("must revalidate after another connection commits"))
        .rejects.toBeInstanceOf(EmbedderWidthConflictError);
      expect(inventory).toHaveBeenCalledTimes(2);
      expect((core as any).db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE id != 'external-384'`).get().n).toBe(12);
      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("embedder pin — abandonEmbedderMigration, the recovery path for an interrupted migration (embedder-width guard slice, task 4)", () => {
  it("throws a plain Error when no migration is in progress — nothing to abandon", () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    expect(() => core.abandonEmbedderMigration()).toThrow(/no embedder migration is in progress/i);
    core.close();
  });

  it("restoring a captured NULL prior pin keeps same-width tok2 poisoned until ensureEmbedderPin proves and loads tok1", async () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 2) });
    insertFakeObservation(core, 256, "pre-pin-tok1-evidence");
    clearPin(core);
    writeMigrationSentinel(core, LEGACY_ONNX_DEFAULT_MODEL_ID, Date.now(), {
      modelId: null,
      source: null,
      pinnedAt: null,
    });
    writePin(core, LEGACY_ONNX_DEFAULT_MODEL_ID, "migrated");

    expect(() => core.abandonEmbedderMigration()).not.toThrow();
    expect(readPin(core).embedder_model_id).toBeNull();
    await expect(core.store("same width but wrong tokenizer identity")).rejects.toBeInstanceOf(EmbedderPinUnsatisfiedError);

    await core.ensureEmbedderPin();
    expect(readPin(core).embedder_model_id).toBe("hashing:dim=256:tok=1");
    expect((core as any).embedderModelId).toBe("hashing:dim=256:tok=1");
    await expect(core.store("now proven under tok1")).resolves.toMatchObject({ conceptId: expect.any(String) });
    core.close();
  });

  it("BLOCKING 2 fix — safe abandon RESTORES the exact stashed prior pin (not NULL, not re-derived): clears the sentinel, and the store genuinely serves again with no ensureEmbedderPin() call needed", async () => {
    // Real evidence under hashing tok=1 (256-dim) — this store's genuine, pre-migration identity.
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 1) }); // pins itself 'created' to tok=1
    insertFakeObservation(core, 256, "surviving-obs-1");
    insertFakeObservation(core, 256, "surviving-obs-2");
    const priorPin = readPin(core);
    expect(priorPin.embedder_model_id).toBe("hashing:dim=256:tok=1");
    expect(priorPin.embedder_pin_source).toBe("created");

    // Simulate an interrupted migration to ONNX: beginEmbedderMigration now STASHES the pin that was
    // live (captured here as `priorPin`, exactly as beginEmbedderMigration itself would read it)
    // BEFORE overwriting sync_meta with the target — reproduced directly (not via a real, slow
    // migrateEmbeddings() run) since NOT ONE vector has actually been touched yet in this scenario.
    writeMigrationSentinel(core, LEGACY_ONNX_DEFAULT_MODEL_ID, Date.now(), {
      modelId: priorPin.embedder_model_id,
      source: priorPin.embedder_pin_source as "created" | "backfilled" | "migrated",
      pinnedAt: priorPin.embedder_pinned_at,
    });
    writePin(core, LEGACY_ONNX_DEFAULT_MODEL_ID, "migrated");
    (core as any).pinUnsatisfied = true; // mirrors what a FRESH open of this same store would compute (sentinel present — see the constructor)

    // Confirm the stuck state first: this store cannot serve at all right now — "re-run the same
    // target" is the only advertised way out, and ONNX is (in this scenario) unavailable.
    expect(() => (core as any).assertPinSatisfied()).toThrow(EmbedderMigrationIncompleteError);

    core.abandonEmbedderMigration();

    expect((core as any).readEmbedderMigration()).toBeUndefined(); // sentinel cleared
    const pinAfter = readPin(core);
    // Restored to the EXACT stashed prior identity — NOT null (the pre-fix behavior), and NOT
    // re-derived via backfillEmbedderPin (which would be indistinguishable from correct HERE, since
    // tok=1 is the one value its 256-dim branch hardcodes — see the shipped-default test below for
    // the case where re-deriving would have silently produced the WRONG model).
    expect(pinAfter.embedder_model_id).toBe("hashing:dim=256:tok=1");
    expect(pinAfter.embedder_pin_source).toBe("created");
    expect(pinAfter.embedder_pinned_at).toBe(priorPin.embedder_pinned_at);
    // Restored pin matches this instance's OWN live embedder (never swapped away) — satisfied
    // immediately, no ensureEmbedderPin() call required to reconcile anything.
    expect((core as any).pinUnsatisfied).toBe(false);

    await core.store("store works again after abandon", { circle: "abandon-test" });
    const results = await core.search("store works again");
    expect(results.length).toBeGreaterThan(0);
    core.close();
  });

  it("BLOCKING 2 fix — the shipped DEFAULT hashing embedder (tok=2) is restored EXACTLY, never silently swapped for the width-matching tok=1 backfillEmbedderPin's inference would have guessed", async () => {
    // The SHIPPED DEFAULT (HASHING_TOKENIZER_VERSION = 2, embedding.ts) — not a constructed tok=1
    // instance the way this file's other tests deliberately use. This is the exact value
    // backfillEmbedderPin's 256-dim branch does NOT name (`new HashingEmbeddingProvider(256, 1)`),
    // so re-deriving instead of restoring would silently produce a DIFFERENT, wrong model at the
    // SAME width — no throw, no sentinel, no pin mismatch, nothing to say so (BLOCKING 2).
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider() });
    insertFakeObservation(core, 256, "native-obs-1");
    insertFakeConcept(core, 256, "native-concept-1");
    const priorPin = readPin(core);
    expect(priorPin.embedder_model_id).toBe("hashing:dim=256:tok=2"); // this store's TRUE identity

    writeMigrationSentinel(core, LEGACY_ONNX_DEFAULT_MODEL_ID, Date.now(), {
      modelId: priorPin.embedder_model_id,
      source: priorPin.embedder_pin_source as "created" | "backfilled" | "migrated",
      pinnedAt: priorPin.embedder_pinned_at,
    });
    writePin(core, LEGACY_ONNX_DEFAULT_MODEL_ID, "migrated");

    core.abandonEmbedderMigration();

    const pinAfter = readPin(core);
    // The EXACT prior model (tok=2) — never tok=1, which is what the pre-fix null-then-re-derive
    // path would have silently produced for this same 256-dim evidence.
    expect(pinAfter.embedder_model_id).toBe("hashing:dim=256:tok=2");
    expect((core as any).pinUnsatisfied).toBe(false); // matches this instance's own live (tok=2) embedder

    // Not just a label check: the live embedder genuinely tokenizes as tok=2 (diverges from tok=1 on
    // non-ASCII input — see isGenuinelyTok1's own doc comment).
    expect(isGenuinelyTok1((core as any).embedder, "café résumé")).toBe(false);
    await core.store("store works again after abandon", { circle: "abandon-test" });
    core.close();
  });

  it("BLOCKING 2 fix — refuses with EmbedderMigrationAbandonUnsupportedError (touching nothing) when the sentinel predates prior-pin capture, rather than falling back to backfillEmbedderPin's unsafe pre-pin-only inference", () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 1) });
    insertFakeObservation(core, 256, "surviving-obs"); // single consistent width — the mixed-width check alone would NOT refuse this
    // No priorPin arg: fabricates the OLDER-BINARY shape — prior_pin_captured = 0, nothing stashed.
    writeMigrationSentinel(core, LEGACY_ONNX_DEFAULT_MODEL_ID);
    writePin(core, LEGACY_ONNX_DEFAULT_MODEL_ID, "migrated");

    let caught: unknown;
    try {
      core.abandonEmbedderMigration();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedderMigrationAbandonUnsupportedError);
    expect((caught as EmbedderMigrationAbandonUnsupportedError).targetModelId).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);

    // No silent half-abandon, and no silent fallback to guessing: sentinel AND pin both untouched.
    expect((core as any).readEmbedderMigration()).toEqual({
      target_model_id: LEGACY_ONNX_DEFAULT_MODEL_ID,
      started_at: expect.any(Number),
      prior_model_id: null,
      prior_pin_source: null,
      prior_pinned_at: null,
      prior_pin_captured: 0,
      vectors_rewritten: 0,
    });
    expect(readPin(core).embedder_model_id).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
    expect(readPin(core).embedder_pin_source).toBe("migrated");
    core.close();
  });

  it("BLOCKING 1 fix — refuses when NATIVE is fully rewritten to the target width and SOURCE is fully still at the old width, even though EACH POPULATION is internally consistent on its own — the cross-POPULATION split migrateEmbeddings' native-then-source phase order produces on an interruption between the two", () => {
    // migrateEmbeddings rewrites ALL native concepts+observations (phases "native-concepts",
    // "native-observations") BEFORE touching ANY source concept/observation (phases
    // "source-concepts", "source-chunk-observations") — one sentinel, one target pin, covering BOTH
    // populations (see migrateEmbeddings itself). An interruption between "native-observations" and
    // "source-concepts" leaves the ENTIRE native population at the target width while the ENTIRE
    // source population is untouched, still fully at the old width — each POPULATION, checked in
    // isolation (nativeDims.size === 1, sourceDims.size === 1), looks clean. Only unioning ALL FOUR
    // arrays together (native AND source) reveals the split.
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 1) });
    insertFakeObservation(core, 384, "native-obs-done", "statement"); // native-observations phase already completed — new-space
    insertFakeConcept(core, 384, "native-concept-done", "fact"); // native-concepts phase already completed — new-space
    insertFakeObservation(core, 256, "source-obs-not-yet", "source"); // source-chunk-observations phase never ran — still old-space
    insertFakeConcept(core, 256, "source-concept-not-yet", "source"); // source-concepts phase never ran — still old-space
    writeMigrationSentinel(core, LEGACY_ONNX_DEFAULT_MODEL_ID);
    writePin(core, LEGACY_ONNX_DEFAULT_MODEL_ID, "migrated");

    let caught: unknown;
    try {
      core.abandonEmbedderMigration();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedderMigrationAbandonRefusedError);
    expect((caught as EmbedderMigrationAbandonRefusedError).targetModelId).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
    // Each POPULATION's own union has length 1 (native: {384}, source: {256}) — proving this case is
    // invisible to a per-population-only check; only the ALL-FOUR union ({256, 384}) catches it.
    expect((caught as EmbedderMigrationAbandonRefusedError).widths.observationDims).toEqual([384]);
    expect((caught as EmbedderMigrationAbandonRefusedError).widths.conceptDims).toEqual([384]);
    expect((caught as EmbedderMigrationAbandonRefusedError).widths.sourceObservationDims).toEqual([256]);
    expect((caught as EmbedderMigrationAbandonRefusedError).widths.sourceConceptDims).toEqual([256]);

    // No silent half-abandon: the sentinel AND the pin are both exactly as they were before the call.
    expect((core as any).readEmbedderMigration()).toEqual({
      target_model_id: LEGACY_ONNX_DEFAULT_MODEL_ID,
      started_at: expect.any(Number),
      prior_model_id: null,
      prior_pin_source: null,
      prior_pinned_at: null,
      prior_pin_captured: 0,
      vectors_rewritten: 0,
    });
    expect(readPin(core).embedder_model_id).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
    expect(readPin(core).embedder_pin_source).toBe("migrated");
    core.close();
  });

  it("refuses (EmbedderMigrationAbandonRefusedError) and touches NOTHING when vectors were already partially rewritten into the target space — abandoning would strand exactly the mixed-width store this whole slice exists to prevent", () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 1) }); // pins itself 'created' to tok=1
    insertFakeObservation(core, 256, "not-yet-rewritten"); // surviving OLD-space evidence
    insertFakeObservation(core, 384, "already-rewritten"); // simulates ONE row migrateEmbeddings already re-embedded into the 384-dim target before the crash
    writeMigrationSentinel(core, LEGACY_ONNX_DEFAULT_MODEL_ID);
    writePin(core, LEGACY_ONNX_DEFAULT_MODEL_ID, "migrated");

    let caught: unknown;
    try {
      core.abandonEmbedderMigration();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedderMigrationAbandonRefusedError);
    expect((caught as EmbedderMigrationAbandonRefusedError).targetModelId).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
    // Ascending order (MINOR 5 fix, cold-audit round 3): inspectMigrationAbandonWidths now carries
    // the same `ORDER BY dim` guarantee as the public inspectEmbeddingWidths, so the two error
    // classes' `.widths` never disagree despite sharing the EmbeddingWidthInventory type. Happens to
    // also be insertion order here (256 was inserted before 384), but the guarantee is ascending, not
    // insertion order.
    expect((caught as EmbedderMigrationAbandonRefusedError).widths.observationDims).toEqual([256, 384]);

    // No silent half-abandon: the sentinel AND the pin are both exactly as they were before the call.
    expect((core as any).readEmbedderMigration()).toEqual({
      target_model_id: LEGACY_ONNX_DEFAULT_MODEL_ID,
      started_at: expect.any(Number),
      prior_model_id: null,
      prior_pin_source: null,
      prior_pinned_at: null,
      prior_pin_captured: 0,
      vectors_rewritten: 0,
    });
    expect(readPin(core).embedder_model_id).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
    expect(readPin(core).embedder_pin_source).toBe("migrated");
    core.close();
  });

  it("(cross-table split) refuses when native CONCEPTS and native OBSERVATIONS disagree, even though EACH TABLE is internally consistent on its own — the exact shape migrateEmbeddings' native-concepts-then-native-observations phase order produces on an interruption between the two", () => {
    // migrateEmbeddings rewrites ALL native concepts (reembedConcept, phase "native-concepts") in
    // one full pass over nativeIds BEFORE rewriting ANY native observation (reembedConceptObservations,
    // phase "native-observations") — two SEPARATE `for (const id of nativeIds)` loops, not one
    // per-concept interleaved pass (verified by reading migrateEmbeddings itself). An interruption
    // between those two loops leaves EVERY native concept already at the target width while EVERY
    // native observation is STILL at the old width — each table individually holds only ONE distinct
    // width, so a check that only looks at observationDims.length/conceptDims.length IN ISOLATION
    // would wrongly see this as "clean" and let the abandon proceed, stranding exactly the cross-table
    // split sampleStoredVectorDim's own doc comment names as a real crashed-migration shape.
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 1) }); // pins itself 'created' to tok=1
    insertFakeObservation(core, 256, "obs-not-yet-rewritten"); // native-observations phase never ran — still old-space
    insertFakeConcept(core, 384, "concept-already-rewritten"); // native-concepts phase already completed — new-space
    writeMigrationSentinel(core, LEGACY_ONNX_DEFAULT_MODEL_ID);
    writePin(core, LEGACY_ONNX_DEFAULT_MODEL_ID, "migrated");

    let caught: unknown;
    try {
      core.abandonEmbedderMigration();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedderMigrationAbandonRefusedError);
    expect((caught as EmbedderMigrationAbandonRefusedError).targetModelId).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
    // Each table's OWN array has length 1 — proving this case is invisible to a per-table-only check.
    expect((caught as EmbedderMigrationAbandonRefusedError).widths.observationDims).toEqual([256]);
    expect((caught as EmbedderMigrationAbandonRefusedError).widths.conceptDims).toEqual([384]);

    // No silent half-abandon: the sentinel AND the pin are both exactly as they were before the call.
    expect((core as any).readEmbedderMigration()).toEqual({
      target_model_id: LEGACY_ONNX_DEFAULT_MODEL_ID,
      started_at: expect.any(Number),
      prior_model_id: null,
      prior_pin_source: null,
      prior_pinned_at: null,
      prior_pin_captured: 0,
      vectors_rewritten: 0,
    });
    expect(readPin(core).embedder_model_id).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
    expect(readPin(core).embedder_pin_source).toBe("migrated");
    core.close();
  });

  it("(cross-table split, source) refuses when source CONCEPTS and source OBSERVATIONS disagree, even though EACH TABLE is internally consistent on its own — the same interruption shape is reachable via migrateEmbeddings' source-concepts-then-source-chunk-observations phase order", () => {
    // Mirrors the native case above: reembedSourceConcept (phase "source-concepts") runs in a full
    // pass over sourceIds BEFORE reembedSourceChunkObservations (phase "source-chunk-observations")
    // runs in its own separate pass — verified by reading migrateEmbeddings itself, same two-loop
    // shape as the native phases.
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 1) });
    insertFakeObservation(core, 256, "source-obs-not-yet-rewritten", "source"); // source-chunk-observations phase never ran
    insertFakeConcept(core, 384, "source-concept-already-rewritten", "source"); // source-concepts phase already completed
    writeMigrationSentinel(core, LEGACY_ONNX_DEFAULT_MODEL_ID);
    writePin(core, LEGACY_ONNX_DEFAULT_MODEL_ID, "migrated");

    let caught: unknown;
    try {
      core.abandonEmbedderMigration();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedderMigrationAbandonRefusedError);
    expect((caught as EmbedderMigrationAbandonRefusedError).widths.sourceObservationDims).toEqual([256]);
    expect((caught as EmbedderMigrationAbandonRefusedError).widths.sourceConceptDims).toEqual([384]);

    expect((core as any).readEmbedderMigration()).toEqual({
      target_model_id: LEGACY_ONNX_DEFAULT_MODEL_ID,
      started_at: expect.any(Number),
      prior_model_id: null,
      prior_pin_source: null,
      prior_pinned_at: null,
      prior_pin_captured: 0,
      vectors_rewritten: 0,
    });
    expect(readPin(core).embedder_model_id).toBe(LEGACY_ONNX_DEFAULT_MODEL_ID);
    core.close();
  });

  it("MEDIUM 7 fix — a PERMANENT superseded source-chunk residue (from a prior, already-completed migration) never blocks a later, otherwise-clean abandon: reembedSourceChunkObservations only ever rewrites lifecycle='active' chunks, so a superseded chunk's old-width observation is expected residue, not evidence of a partial rewrite", () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 1) });
    // Everything CURRENTLY relevant (native evidence, and the active half of source evidence) is a
    // single consistent width — the store this migration is running against is clean.
    insertFakeObservation(core, 256, "native-obs", "statement");
    insertFakeConcept(core, 256, "native-concept", "fact");
    insertFakeConcept(core, 256, "source-concept-active", "source");
    insertFakeObservation(core, 256, "source-obs-active", "source");
    insertFakeSourceChunk(core, "source-obs-active", "active");
    // PERMANENT residue: a source-chunk observation from a PREVIOUS migration this store already
    // completed, superseded since (a real edit, or a classification-affecting version bump) —
    // reembedSourceChunkObservations (engine.ts) only ever re-embeds lifecycle='active' chunks, so
    // this row's width was NEVER rewritten and never will be by any future migration either. Left
    // unfiltered, this alone would make sourceObservationDims = [128, 256] forever, permanently
    // tripping the mixed-width refusal on every future migration attempt regardless of its own health.
    insertFakeObservation(core, 128, "source-obs-superseded-residue", "source");
    insertFakeSourceChunk(core, "source-obs-superseded-residue", "superseded");
    const priorPin = readPin(core);
    writeMigrationSentinel(core, LEGACY_ONNX_DEFAULT_MODEL_ID, Date.now(), {
      modelId: priorPin.embedder_model_id,
      source: priorPin.embedder_pin_source as "created" | "backfilled" | "migrated",
      pinnedAt: priorPin.embedder_pinned_at,
    });
    writePin(core, LEGACY_ONNX_DEFAULT_MODEL_ID, "migrated");

    // Must NOT throw: the residue is excluded from the comparison, so the store reads as a single
    // consistent width (256) and the abandon proceeds normally.
    expect(() => core.abandonEmbedderMigration()).not.toThrow();
    expect((core as any).readEmbedderMigration()).toBeUndefined();
    core.close();
  });

  it("BLOCKING 1 fix (cold-audit round 3) — a SAME-WIDTH migration interrupted after ONE row was rewritten must REFUSE, even though every population's width stays a single consistent 256 throughout (hashing tok=1 -> tok=2 — the normal VOLUNTARY re-embed path; see embedding.ts's own HASHING_TOKENIZER_VERSION comment)", async () => {
    // The width-only proof is USELESS for this scenario by construction: tok=1 and tok=2 vectors are
    // numerically different but byte-length identical (both 256-dim), so nothing about
    // json_array_length(embedding) can ever distinguish "rewritten" from "not yet rewritten" here.
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 1) }); // prior identity: tok=1
    insertFakeConcept(core, 256, "c1", "fact"); // will be "rewritten" by the simulated migration's first write
    insertFakeConcept(core, 256, "c2", "fact"); // never reached — proves PARTIAL (not total) rewrite still refuses
    const priorPin = readPin(core);

    // beginEmbedderMigration's own stamp: sentinel to tok=2 (SAME 256-dim width), prior pin captured,
    // vectors_rewritten defaults to 0 — mirrors the real INSERT this method performs before ANY vector
    // is rewritten.
    writeMigrationSentinel(core, "hashing:dim=256:tok=2", Date.now(), {
      modelId: priorPin.embedder_model_id,
      source: priorPin.embedder_pin_source as "created" | "backfilled" | "migrated",
      pinnedAt: priorPin.embedder_pinned_at,
    });
    writePin(core, "hashing:dim=256:tok=2", "migrated");

    // Simulate the one atomic commit a real owned helper performs. Async-scoped migration
    // capabilities are deliberately unforgeable, so this crash-shape fixture writes the durable
    // row+marker state directly instead of impersonating the private owner.
    const target = new HashingEmbeddingProvider(256, 2);
    const db = (core as any).db;
    db.transaction(() => {
      db.prepare(`UPDATE concepts SET embedding = ? WHERE id = 'c1'`).run(JSON.stringify(Array.from(target.embed("body-c1"))));
      db.prepare(`UPDATE embedder_migration SET vectors_rewritten = 1 WHERE singleton = 1`).run();
    })();

    // Confirm the trap is real: width evidence alone still shows a SINGLE consistent width (256) —
    // the OLD width-only proof would see this as "clean" and let the abandon proceed.
    const widths = core.inspectEmbeddingWidths();
    expect(new Set([...widths.conceptDims, ...widths.observationDims])).toEqual(new Set([256]));

    let caught: unknown;
    try {
      core.abandonEmbedderMigration();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmbedderMigrationAbandonRefusedError);
    expect((caught as EmbedderMigrationAbandonRefusedError).targetModelId).toBe("hashing:dim=256:tok=2");

    // No silent half-abandon: the sentinel AND the pin are both exactly as they were before the call.
    expect((core as any).readEmbedderMigration()).toMatchObject({
      target_model_id: "hashing:dim=256:tok=2",
      vectors_rewritten: 1, // stamped by reembedConcept's own transaction, in the SAME commit as its write
    });
    expect(readPin(core).embedder_model_id).toBe("hashing:dim=256:tok=2");
    core.close();
  });

  it("BLOCKING 1 fix (cold-audit round 3) — an OLDER-BINARY sentinel (predates the vectors_rewritten marker) is treated as UNKNOWN and refuses, never as 'clean', even when every width is single and consistent and the prior pin WAS captured", () => {
    const core = new MonetCore(":memory:", { embedder: new HashingEmbeddingProvider(256, 1) });
    insertFakeObservation(core, 256, "surviving-obs"); // single consistent width — the OLD width-only check alone would NOT refuse this
    const priorPin = readPin(core);
    // vectorsRewritten = 1 fabricates the ALTER-backfilled default an older-binary sentinel would
    // carry (this column's own migrate()-guard comment) — indistinguishable, by design, from "a real
    // write already landed"; both must refuse identically.
    writeMigrationSentinel(
      core,
      LEGACY_ONNX_DEFAULT_MODEL_ID,
      Date.now(),
      { modelId: priorPin.embedder_model_id, source: priorPin.embedder_pin_source as "created" | "backfilled" | "migrated", pinnedAt: priorPin.embedder_pinned_at },
      1,
    );
    writePin(core, LEGACY_ONNX_DEFAULT_MODEL_ID, "migrated");

    expect(() => core.abandonEmbedderMigration()).toThrow(EmbedderMigrationAbandonRefusedError);
    expect((core as any).readEmbedderMigration()).toBeDefined(); // untouched — no silent half-abandon
    core.close();
  });
});
