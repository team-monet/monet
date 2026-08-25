/**
 * THE MEASUREMENT HEADER'S TWO SAFETY CHECKS (scripts/measure-header.ts).
 *
 * The module is a dev-script helper, not shipped surface, so it is tested only where getting it
 * wrong would corrupt a measurement silently — which is both of the behaviours below. Everything
 * else it does is formatting.
 *
 *   WIDTH MISMATCH WITHOUT A PIN. `cosine()` (src/embedding.ts) reduces over
 *   `Math.min(a.length, b.length)`: a 384-dim probe scored against 1024-dim stored vectors returns
 *   a dot product over the first 384 components. No throw, no NaN, a plausible number. The check
 *   therefore cannot be gated on the store carrying a pin — an unpinned store has nothing ELSE to
 *   catch it, which makes it the case that needs the warning most.
 *
 *   SPLIT DIMENSION. scripts/reembed-store.ts rewrites observations and segments into a candidate
 *   space and deliberately leaves concepts and `sync_meta` alone ("IT DOES NOT TOUCH CONCEPT
 *   VECTORS", its own header). A header that sampled one population and stopped would report the
 *   pin's space for a store whose scored population is in another.
 *
 * The reader is a hand-built stub rather than a real database: these are pure functions over a
 * `prepare(...).get()` shape, and driving them with SQL would test better-sqlite3.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  printEmbedderHeader, printStoreHeader, printStoredOnlySection, readStoreSpace,
  requireTrustableSpace, scoredSpaceIdentity,
} from "../../scripts/measure-header";

type Row = { e: string } | { m: string | null } | Record<string, unknown> | undefined;

/**
 * A store stub: `concepts`/`observations` widths, and a pin that may be absent or unreadable.
 *
 * `sourceDim` models the shape scripts/reembed-store.ts produces — it re-embeds
 * `WHERE kind != 'source'` and leaves source rows on the old model — by serving a DIFFERENT width
 * to a query that does NOT filter source rows out. A sampler that forgets the filter reads this
 * value; one that remembers reads the native width. That is the whole difference the test turns on.
 */
function stubReader(opts: {
  conceptDim?: number | null;
  observationDim?: number | null;
  sourceDim?: number;
  pin?: string | null;
  syncMetaMissing?: boolean;
  /** `sync_meta.embedder_pinned_at`. A value later than a marker's completion supersedes it. */
  pinnedAt?: number | null;
  /** Rows in the engine's `embedder_migration` sentinel => an official migration is unfinished. */
  migrationRows?: number;
  /** Omit the table entirely (old schema) rather than reporting zero rows. */
  migrationTableMissing?: boolean;
  /** MAX(created_at, updated_at) over scored observations; `null` => the query cannot be answered. */
  latestRowWriteAt?: number | null;
  /** Present => the copy carries scripts/reembed-store.ts's marker. Absent => no such table. */
  reembed?: {
    candidate_model_id: string | null; requested_model: string; pooling?: string | null;
    dtype?: string | null; measured_dim: number;
    /** Omitted => completed. `null` => the preparation was interrupted and never published. */
    completed_at?: number | null;
    /** The row-write baseline the preparation observed. Omitted => the stub's default clean value. */
    rows_max_at?: number | null;
  };
}) {
  const vec = (n: number): string => JSON.stringify(new Array(n).fill(0.1));
  const nativeOnly = (sql: string): boolean => sql.includes("kind != 'source'");
  return {
    prepare(sql: string) {
      return {
        get(): Row {
          if (sql.includes("reembed_provenance")) {
            // The normal case is that this table does not exist at all, and the reader must treat
            // that as "no candidate rewrite", not as a fault.
            if (opts.reembed === undefined) throw new Error("no such table: reembed_provenance");
            return {
              candidate_model_id: opts.reembed.candidate_model_id,
              requested_model: opts.reembed.requested_model,
              pooling: opts.reembed.pooling ?? null,
              dtype: opts.reembed.dtype ?? null,
              measured_dim: opts.reembed.measured_dim,
              populations: "observations+segments where kind != 'source'; concepts and sync_meta UNTOUCHED",
              started_at: 1756000000000,
              completed_at: opts.reembed.completed_at === undefined ? 1756000060750 : opts.reembed.completed_at,
              // Default baseline == the stub's default current row max, i.e. nothing has been
              // written since the preparation. Tests move one side or the other to break that.
              rows_max_at: opts.reembed.rows_max_at === undefined ? 1755000000000 : opts.reembed.rows_max_at,
            };
          }
          if (sql.includes("embedder_migration")) {
            if (opts.migrationTableMissing) throw new Error("no such table: embedder_migration");
            return { n: opts.migrationRows ?? 0 };
          }
          if (sql.includes("MAX(created_at)")) {
            if (opts.latestRowWriteAt === null) throw new Error("no such column: created_at");
            return { t: opts.latestRowWriteAt ?? 1755000000000 }; // default: older than any marker below
          }
          if (sql.includes("sync_meta")) {
            if (opts.syncMetaMissing) throw new Error("no such table: sync_meta");
            // Default pin time sits BEFORE any marker below, so a fixture is clean unless a test
            // deliberately moves it. `null` models a store carrying no pin timestamp at all.
            return { m: opts.pin ?? null, at: opts.pinnedAt === undefined ? 1754000000000 : opts.pinnedAt };
          }
          // An unfiltered scan can land on a stale source row; a filtered one cannot.
          if (opts.sourceDim !== undefined && !nativeOnly(sql)) return { e: vec(opts.sourceDim) };
          if (sql.includes("FROM concepts")) {
            return opts.conceptDim == null ? undefined : { e: vec(opts.conceptDim) };
          }
          return opts.observationDim == null ? undefined : { e: vec(opts.observationDim) };
        },
      };
    },
  };
}

const captured = (fn: () => void): string => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => { lines.push(args.join(" ")); });
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join("\n");
};

describe("measure-header — width mismatch is checked without a pin", () => {
  it("warns when the loaded embedder's width differs from the stored vectors', on an UNPINNED store", () => {
    const space = readStoreSpace(stubReader({ conceptDim: 1024, observationDim: 1024, pin: null }), "/tmp/x.db");
    expect(space.pin).toBeNull();
    expect(space.pinReadable).toBe(true); // sync_meta exists, the column is just NULL
    const out = captured(() => printEmbedderHeader(space, { modelId: "some/model", dim: 384 }, "against-stored-vectors"));
    expect(out).toMatch(/WARNING/);
    expect(out).toContain("384-dim");
    expect(out).toContain("1024-dim");
    // The message must not assert a migration it has no pin to corroborate.
    expect(out).not.toMatch(/mid-migration/);
    expect(out).toContain("no pin to corroborate");
    // And it must name what actually happens, since nothing else will signal it.
    expect(out).toMatch(/truncates to the SHORTER/);
  });

  it("warns on a store whose sync_meta is absent entirely", () => {
    const space = readStoreSpace(stubReader({ observationDim: 1024, syncMetaMissing: true }), "/tmp/x.db");
    expect(space.pinReadable).toBe(false);
    const out = captured(() => printEmbedderHeader(space, { modelId: "some/model", dim: 384 }, "against-stored-vectors"));
    expect(out).toMatch(/WARNING/);
  });

  it("stays silent on width when the run RE-EMBEDS everything — nothing stored is scored", () => {
    const space = readStoreSpace(stubReader({ observationDim: 1024, pin: null }), "/tmp/x.db");
    const out = captured(() => printEmbedderHeader(space, { modelId: "some/model", dim: 384 }, "replaces-stored-vectors"));
    expect(out).not.toMatch(/WARNING/);
  });

  it("stays silent when the widths agree", () => {
    const space = readStoreSpace(stubReader({ conceptDim: 1024, observationDim: 1024, pin: "m" }), "/tmp/x.db");
    const out = captured(() => printEmbedderHeader(space, { modelId: "m", dim: 1024 }, "against-stored-vectors"));
    expect(out).not.toMatch(/WARNING/);
  });
});

describe("measure-header — concepts and observations are sampled separately", () => {
  it("reports ONE dimension when both populations agree", () => {
    const space = readStoreSpace(stubReader({ conceptDim: 1024, observationDim: 1024, pin: "m" }), "/tmp/x.db");
    expect(space.dimSplit).toBe(false);
    expect(space.dim).toBe(1024);
    const out = captured(() => printStoreHeader(stubReader({ conceptDim: 1024, observationDim: 1024, pin: "m" }), "/tmp/x.db"));
    expect(out).toContain("dim=1024 (concepts + observations)");
    expect(out).not.toMatch(/NOTE/);
  });

  it("reports BOTH and flags the split on a partial re-embed (concepts old, observations new)", () => {
    const reader = stubReader({ conceptDim: 384, observationDim: 1024, pin: "Xenova/bge-small-en-v1.5" });
    const space = readStoreSpace(reader, "/tmp/x.db");
    expect(space.dimSplit).toBe(true);
    expect(space.conceptDim).toBe(384);
    expect(space.observationDim).toBe(1024);
    // `dim` is the side these scripts actually score — the observation side, which is also the side
    // reembed-store.ts rewrites. Preferring concepts here would report the retired space.
    expect(space.dim).toBe(1024);
    const out = captured(() => printStoreHeader(reader, "/tmp/x.db"));
    expect(out).toContain("dim=concepts=384 observations=1024");
    expect(out).toMatch(/NOTE: this store holds TWO embedding spaces/);
  });

  it("names which population a lone dimension came from, rather than implying both", () => {
    const obsOnly = captured(() => printStoreHeader(stubReader({ observationDim: 1024, pin: "m" }), "/tmp/x.db"));
    expect(obsOnly).toContain("1024 (observations; concepts hold none)");
    const conceptOnly = captured(() => printStoreHeader(stubReader({ conceptDim: 384, pin: "m" }), "/tmp/x.db"));
    expect(conceptOnly).toContain("384 (concepts; observations hold none)");
  });

  it("says no stored vectors rather than guessing a width, on an empty store", () => {
    const space = readStoreSpace(stubReader({ pin: "m" }), "/tmp/x.db");
    expect(space.dim).toBeNull();
    expect(space.dimSplit).toBe(false);
    const out = captured(() => printStoreHeader(stubReader({ pin: "m" }), "/tmp/x.db"));
    expect(out).toContain("(no stored vectors)");
  });

  it("samples the SCORED rows on a reembed-prepped store — old-space source rows must not mask the split", () => {
    // reembed-store.ts's exact output shape: native observations rewritten to 1024, source
    // observations left at 384, concepts untouched at 384, pin still naming the old model.
    const reader = stubReader({
      conceptDim: 384, observationDim: 1024, sourceDim: 384, pin: "Xenova/bge-small-en-v1.5",
    });
    const space = readStoreSpace(reader, "/tmp/prepped.db");
    // An unfiltered sampler would read 384 from a source row here, agree with concepts' 384, and
    // report a tidy uniform store — hiding the very split this NOTE exists for.
    expect(space.observationDim).toBe(1024);
    expect(space.conceptDim).toBe(384);
    expect(space.dimSplit).toBe(true);
    expect(space.dim).toBe(1024); // the side the replays score
    const out = captured(() => printStoreHeader(reader, "/tmp/prepped.db"));
    expect(out).toMatch(/NOTE: this store holds TWO embedding spaces/);
    expect(out).toContain("dim=concepts=384 observations=1024");
  });

  it("compares the mismatch warning against the SCORED width, not the stale source width", () => {
    const space = readStoreSpace(
      stubReader({ conceptDim: 384, observationDim: 1024, sourceDim: 384, pin: "Xenova/bge-small-en-v1.5" }),
      "/tmp/prepped.db",
    );
    // A 1024-dim model against this store is CORRECT for the scored population. Sampling a source
    // row would have made 384 the reference and fired a warning at the right configuration.
    const ok = captured(() => printEmbedderHeader(space, { modelId: "Xenova/bge-m3:cls:q8", dim: 1024 }, "against-stored-vectors"));
    expect(ok).not.toMatch(/WARNING: this embedder produces/);
  });
});

describe("measure-header — declared width vs measured width", () => {
  it("prefers the MEASURED width and names the declared one when they disagree", () => {
    // OnnxEmbeddingProvider.dim is `opts.dim ?? profile?.dim ?? 384` and embedding-onnx.ts calls it
    // "declarative only": an unprofiled checkpoint embedding at 1024 still reports 384.
    const space = readStoreSpace(stubReader({ observationDim: 1024, pin: "m" }), "/tmp/x.db");
    const out = captured(() =>
      printEmbedderHeader(space, { modelId: "some/unprofiled", dim: 384 }, "against-stored-vectors", 1024));
    expect(out).toMatch(/1024 \(MEASURED/);
    expect(out).toContain("DECLARES 384");
    // And the width check must use 1024, so this correctly-matched run raises nothing.
    expect(out).not.toMatch(/WARNING: this embedder produces/);
  });

  it("fires the width warning on the MEASURED width when that is what actually mismatches", () => {
    const space = readStoreSpace(stubReader({ observationDim: 384, pin: null }), "/tmp/x.db");
    // Declared 384 would have matched the store and stayed silent; the model really emits 1024.
    const out = captured(() =>
      printEmbedderHeader(space, { modelId: "some/unprofiled", dim: 384 }, "against-stored-vectors", 1024));
    expect(out).toMatch(/WARNING: this embedder produces 1024-dim/);
  });

  it("says the width is unmeasured rather than presenting a declared value as observed", () => {
    const space = readStoreSpace(stubReader({ observationDim: 384, pin: "m" }), "/tmp/x.db");
    const out = captured(() => printEmbedderHeader(space, { modelId: "m", dim: 384 }, "against-stored-vectors"));
    expect(out).toContain("384 (declared by the profile; no vector measured yet)");
  });

  it("marks a stored-only section as the stored vectors' own space, whatever model is loaded", () => {
    const space = readStoreSpace(stubReader({ observationDim: 1024, pin: "Xenova/bge-m3:cls:q8" }), "/tmp/x.db");
    const out = captured(() => printStoredOnlySection(space));
    expect(out).toMatch(/stored-vector section/);
    expect(out).toContain("Xenova/bge-m3:cls:q8");
    expect(out).toMatch(/applies elsewhere, not to this section/);
  });
});

/**
 * THE SAME-WIDTH CANDIDATE SWAP — the state no width check can see.
 *
 * scripts/reembed-store.ts can rewrite every observation and segment vector with a different
 * 384-dim model, or with the SAME checkpoint at a different pooling or dtype, and leave the file
 * otherwise identical: same pin, same row counts, same sampled dimension, no split. Its own header
 * names this exact hazard — "same file name, same row counts, same pin". The marker it now writes
 * into the copy is the only thing that can distinguish the two files.
 */
describe("measure-header — candidate provenance on a same-width re-embed", () => {
  const SWAP = {
    pin: "Xenova/bge-small-en-v1.5",
    conceptDim: 384,
    observationDim: 384, // SAME width — the whole point
    reembed: { candidate_model_id: "Xenova/bge-base-en-v1.5", requested_model: "Xenova/bge-base-en-v1.5", measured_dim: 384 },
  };

  it("names the CANDIDATE for the scored side and does not report agreement with the stale pin", () => {
    const space = readStoreSpace(stubReader(SWAP), "/tmp/swap.db");
    expect(space.dimSplit).toBe(false);        // width sees nothing, by construction
    expect(space.reembed?.candidateModelId).toBe("Xenova/bge-base-en-v1.5");
    expect(scoredSpaceIdentity(space)).toMatchObject({ id: "Xenova/bge-base-en-v1.5", source: "reembed-marker" });

    const out = captured(() => printStoreHeader(stubReader(SWAP), "/tmp/swap.db"));
    expect(out).toMatch(/prepared by scripts\/reembed-store\.ts/);
    expect(out).toContain("observations + segments -> Xenova/bge-base-en-v1.5");
    expect(out).toContain("concepts + sync_meta    -> Xenova/bge-small-en-v1.5");
  });

  it("clears a run whose loaded model IS the candidate — the pin alone would have called it a mismatch", () => {
    const space = readStoreSpace(stubReader(SWAP), "/tmp/swap.db");
    const out = captured(() =>
      printEmbedderHeader(space, { modelId: "Xenova/bge-base-en-v1.5", dim: 384 }, "against-stored-vectors", 384));
    expect(out).not.toMatch(/WARNING/);
  });

  it("flags a run loaded with the PIN's model — which the stale pin would have waved through", () => {
    const space = readStoreSpace(stubReader(SWAP), "/tmp/swap.db");
    const out = captured(() =>
      printEmbedderHeader(space, { modelId: "Xenova/bge-small-en-v1.5", dim: 384 }, "against-stored-vectors", 384));
    expect(out).toMatch(/WARNING: loaded embedder 'Xenova\/bge-small-en-v1\.5' does NOT match/);
    expect(out).toContain("the candidate this copy was re-embedded with");
  });

  it("says the space cannot be compared for an OFF-PROFILE candidate rather than guessing either way", () => {
    const offProfile = {
      ...SWAP,
      reembed: { candidate_model_id: null, requested_model: "some/local-checkpoint", measured_dim: 384, pooling: "cls", dtype: "q8" },
    };
    const space = readStoreSpace(stubReader(offProfile), "/tmp/swap.db");
    expect(scoredSpaceIdentity(space)).toMatchObject({ known: false, source: "reembed-marker" });
    const out = captured(() =>
      printEmbedderHeader(space, { modelId: "Xenova/bge-small-en-v1.5", dim: 384 }, "against-stored-vectors", 384));
    expect(out).toMatch(/cannot be established here/);
    // Pooling and dtype are part of the space, so they travel with the label.
    expect(out).toContain("pooling=cls, dtype=q8");
  });

  it("a width that disagrees with the marker invalidates the fixture like anything else does", () => {
    const stale = { ...SWAP, observationDim: 1024 };
    const space = readStoreSpace(stubReader(stale), "/tmp/swap.db");
    expect(space.attribution).toMatchObject({ state: "fixture-invalid" });
    const out = captured(() => printStoreHeader(stubReader(stale), "/tmp/swap.db"));
    expect(out).toMatch(/not a valid fixture — rebuild it with reembed-store\.ts/);
    expect(out).toMatch(/384-dim rewrite but the observations sample 1024-dim/);
  });

  it("attributes the CONCEPT population to the pin and the OBSERVATION population to the candidate, on one store", () => {
    // measure-fork-and-edge-bands.ts is the script that does both: segments for tauAmbiguous,
    // concept pairs for edgeSimMin. reembed-store.ts rewrote only the first.
    const space = readStoreSpace(stubReader(SWAP), "/tmp/swap.db");
    expect(scoredSpaceIdentity(space, "observations")).toMatchObject({
      id: "Xenova/bge-base-en-v1.5", source: "reembed-marker",
    });
    expect(scoredSpaceIdentity(space, "concepts")).toMatchObject({
      id: "Xenova/bge-small-en-v1.5", source: "pin",
    });

    const obsSection = captured(() => printStoredOnlySection(space, "observations"));
    expect(obsSection).toContain("observation and segment vectors");
    expect(obsSection).toContain("Xenova/bge-base-en-v1.5");

    const conceptSection = captured(() => printStoredOnlySection(space, "concepts"));
    expect(conceptSection).toContain("concepts.embedding");
    expect(conceptSection).toContain("Xenova/bge-small-en-v1.5");
    expect(conceptSection).toMatch(/did NOT rewrite these vectors/);
    expect(conceptSection).toMatch(/PINNED space/);
    // The two sections must not be given the same answer.
    expect(conceptSection).not.toContain("bge-base");
  });

  it("MARKER ABSENT: behaviour is exactly what it was — the pin is the identity", () => {
    const plain = { pin: "Xenova/bge-m3:cls:q8", conceptDim: 1024, observationDim: 1024 };
    const space = readStoreSpace(stubReader(plain), "/tmp/plain.db");
    expect(space.reembed).toBeNull();
    expect(scoredSpaceIdentity(space)).toMatchObject({ id: "Xenova/bge-m3:cls:q8", source: "pin" });
    const header = captured(() => printStoreHeader(stubReader(plain), "/tmp/plain.db"));
    expect(header).toContain("store space: pin=Xenova/bge-m3:cls:q8  dim=1024 (concepts + observations)");
    expect(header).not.toMatch(/NOTE/);
    const match = captured(() =>
      printEmbedderHeader(space, { modelId: "Xenova/bge-m3:cls:q8", dim: 1024 }, "against-stored-vectors", 1024));
    expect(match).not.toMatch(/WARNING/);
    const mismatch = captured(() =>
      printEmbedderHeader(space, { modelId: "Xenova/bge-small-en-v1.5", dim: 384 }, "against-stored-vectors", 384));
    expect(mismatch).toMatch(/does NOT match the store pin 'Xenova\/bge-m3:cls:q8'/);
    // Concepts resolve to the same pin when nothing rewrote anything — no spurious divergence.
    expect(scoredSpaceIdentity(space, "concepts")).toMatchObject({ id: "Xenova/bge-m3:cls:q8", source: "pin" });
  });
});

/**
 * AN INTERRUPTED PREPARATION — the state the first marker could not represent.
 *
 * reembed-store.ts publishes provenance only when the rewrite finishes. Before this, a rerun that
 * died partway left the PREVIOUS run's row standing over a half-rewritten store, reading as
 * authoritative; on a same-width swap nothing else in the file disagreed with it. The marker is now
 * opened before the first vector moves and completed after the last, so `completed_at IS NULL` is
 * the store saying "I am two spaces at once" — which is not a space, and must not be attributed.
 */
describe("measure-header — interrupted preparation", () => {
  const INTERRUPTED = {
    pin: "Xenova/bge-small-en-v1.5",
    conceptDim: 384,
    observationDim: 384,
    reembed: {
      candidate_model_id: "Xenova/bge-base-en-v1.5", requested_model: "Xenova/bge-base-en-v1.5",
      measured_dim: 384, completed_at: null,
    },
  };

  it("reports the space as NOT TRUSTABLE rather than naming either side", () => {
    const space = readStoreSpace(stubReader(INTERRUPTED), "/tmp/half.db");
    expect(space.reembed?.completedAt).toBeNull();
    const identity = scoredSpaceIdentity(space);
    expect(identity.trustable).toBe(false);
    expect(identity.known).toBe(false);
    expect(identity.id).toBeNull();
    expect(identity.source).toBe("reembed-interrupted");
    // The concept side is poisoned too — a half-rewritten observations table is not something the
    // "concepts were untouched" reasoning can be read beside.
    expect(scoredSpaceIdentity(space, "concepts").trustable).toBe(false);
  });

  it("emits the interrupted/mixed STOP, and NOT the ordinary split NOTE", () => {
    const out = captured(() => printStoreHeader(stubReader(INTERRUPTED), "/tmp/half.db"));
    expect(out).toMatch(/STOP: scripts\/reembed-store\.ts began preparing this copy and never finished/);
    expect(out).toMatch(/MIX of that candidate's space and the pinned/);
    expect(out).toMatch(/no completion recorded/);
    // The completed-copy NOTE would imply a clean two-population split, which this is not.
    expect(out).not.toMatch(/NOTE: this copy was prepared/);
  });

  it("keeps the interrupted state DISTINCT from the stale-width warning", () => {
    // Same store, but the rows are also a different width than the marker claims. The interrupted
    // state subsumes it: a half-rewritten table legitimately holds both widths, so reporting a
    // stale marker on top would describe the symptom as if it were a second, separate fault.
    const out = captured(() => printStoreHeader(stubReader({ ...INTERRUPTED, observationDim: 1024 }), "/tmp/half.db"));
    expect(out).toMatch(/STOP:/);
    expect(out).not.toMatch(/marker records a .*-dim rewrite but the observations sampled/);
  });

  it("refuses to attribute a loaded embedder instead of declaring a match or a mismatch", () => {
    const space = readStoreSpace(stubReader(INTERRUPTED), "/tmp/half.db");
    // Loading the very candidate the preparation was heading toward still gets no clearance.
    const out = captured(() =>
      printEmbedderHeader(space, { modelId: "Xenova/bge-base-en-v1.5", dim: 384 }, "against-stored-vectors", 384));
    expect(out).toMatch(/REFUSING TO ATTRIBUTE/);
    expect(out).toMatch(/INTERRUPTED fixture preparation/);
    expect(out).toMatch(/not a question\n!! with an answer/);
    expect(out).not.toMatch(/does NOT match/);
  });

  it("stays quiet for a run that re-embeds everything — it never reads the mixed rows", () => {
    const space = readStoreSpace(stubReader(INTERRUPTED), "/tmp/half.db");
    const out = captured(() =>
      printEmbedderHeader(space, { modelId: "Xenova/bge-base-en-v1.5", dim: 384 }, "replaces-stored-vectors", 384));
    expect(out).not.toMatch(/REFUSING/);
    expect(out).not.toMatch(/WARNING/);
  });
});

/**
 * THE ENGINE'S OWN INTERRUPTED MIGRATION — a store that reads as coherent and is not.
 *
 * `beginEmbedderMigration` inserts the `embedder_migration` sentinel and then IMMEDIATELY calls
 * `writeMigratedEmbedderPin`, so `sync_meta` names the TARGET before any vector has been rewritten;
 * `completeEmbedderMigration` deletes the sentinel as its last act. Rows present therefore means:
 * the pin is the target, the vectors are partly the old model's, and nothing else disagrees.
 */
describe("measure-header — interrupted OFFICIAL migration", () => {
  const MIGRATING = { pin: "Xenova/bge-m3:cls:q8", conceptDim: 384, observationDim: 384, migrationRows: 1 };

  it("STOPs for BOTH populations and says it is the engine's migration, not a fixture preparation", () => {
    const space = readStoreSpace(stubReader(MIGRATING), "/tmp/migrating.db");
    expect(space.migrationInterrupted).toBe(true);
    expect(space.attribution.state).toBe("official-migration-interrupted");
    for (const population of ["observations", "concepts"] as const) {
      const identity = scoredSpaceIdentity(space, population);
      expect(identity.trustable).toBe(false);
      expect(identity.source).toBe("engine-migration-interrupted");
    }
    const out = captured(() => printStoreHeader(stubReader(MIGRATING), "/tmp/migrating.db"));
    expect(out).toMatch(/STOP: this store's embedder_migration sentinel is SET/);
    expect(out).toMatch(/OFFICIAL migration started and\n!! never completed/);
    expect(out).toMatch(/the pin above is the migration's TARGET, written at its START/i);
    // Distinct from the fixture message, which names reembed-store.ts.
    expect(out).not.toMatch(/reembed-store\.ts began preparing/);
  });

  it("outranks a fixture marker — the engine's own half-finished migration is the bigger fact", () => {
    const space = readStoreSpace(
      stubReader({ ...MIGRATING, reembed: { candidate_model_id: "x/y", requested_model: "x/y", measured_dim: 384 } }),
      "/tmp/both.db",
    );
    expect(space.attribution.state).toBe("official-migration-interrupted");
  });

  it("advises the migration remedy, not 'rebuild the copy', when refusing attribution", () => {
    const space = readStoreSpace(stubReader(MIGRATING), "/tmp/migrating.db");
    const out = captured(() =>
      printEmbedderHeader(space, { modelId: "Xenova/bge-m3:cls:q8", dim: 1024 }, "against-stored-vectors", 1024));
    expect(out).toMatch(/REFUSING TO ATTRIBUTE/);
    expect(out).toMatch(/monet doctor/);
    expect(out).not.toMatch(/rebuild the copy\./);
  });

  it("a sentinel table that does not exist is NOT read as a clean store", () => {
    const space = readStoreSpace(stubReader({ pin: "m", observationDim: 384, migrationTableMissing: true }), "/tmp/old.db");
    expect(space.migrationInterrupted).toBeNull();
    // Unknown here degrades to the pin rather than to a STOP: an old schema predates the sentinel
    // entirely, so its absence is genuinely uninformative rather than alarming. With NO marker there
    // is no fixture claim to invalidate, so the pin stands on its own as it always has.
    expect(space.attribution.state).toBe("pin");
  });
});

/**
 * ONE INVALID STATE, MANY REASONS.
 *
 * A completed marker is trusted only when EVERY checkable signal is clean. Each failure below used
 * to be its own state with its own message; they collapse here because they end in one instruction.
 * What each test pins is that the reason survives the collapse — the state is shared, the diagnosis
 * is not.
 */
describe("measure-header — fixture-invalid subsumes every way a marker stops describing the copy", () => {
  const PREPARED_AT = 1756000060750; // the stub's completed_at — note the MILLISECONDS
  const STARTED_AT = 1756000000000;  // the stub's started_at
  const BASE = {
    pin: "Xenova/bge-small-en-v1.5",
    conceptDim: 384,
    observationDim: 384,
    reembed: { candidate_model_id: "Xenova/bge-base-en-v1.5", requested_model: "Xenova/bge-base-en-v1.5", measured_dim: 384 },
  };
  const reasonOf = (opts: Parameters<typeof stubReader>[0]): string => {
    const a = readStoreSpace(stubReader(opts), "/tmp/f.db").attribution;
    expect(a.state).toBe("fixture-invalid");
    return (a as { state: "fixture-invalid"; reason: string }).reason;
  };

  it("a pin written AT OR AFTER the preparation started invalidates — whatever wrote it", () => {
    // migrate, adopt and backfill all stamp embedder_pinned_at and are indistinguishable afterward,
    // so the check is on the timestamp alone. `>=` because a pin write DURING the rewrite is at
    // least as damaging as one after it.
    expect(reasonOf({ ...BASE, pinnedAt: STARTED_AT })).toMatch(/at or after this preparation started/);
    expect(reasonOf({ ...BASE, pinnedAt: STARTED_AT + 1 })).toMatch(/at or after this preparation started/);
    expect(reasonOf({ ...BASE, pinnedAt: PREPARED_AT + 60_000 })).toMatch(/migration, adopt or backfill/);
    // Strictly before the start is the only clean case.
    expect(readStoreSpace(stubReader({ ...BASE, pinnedAt: STARTED_AT - 1 }), "/tmp/f.db").attribution.state)
      .toBe("candidate");
  });

  /**
   * A FRESHLY PREPARED FIXTURE ON A HEALTHY STORE MUST BE VALID.
   *
   * On a copy with `applying_remote = 0` — the normal, non-latched state — reembed-store's own
   * `UPDATE observations SET embedding = ...` fires `sync_observations_update`, whose body advances
   * `sync_meta.last_mutation_at` to wall-clock now and stamps `updated_at` from it. Every row the
   * preparation touched therefore carries a timestamp from milliseconds before `completed_at`.
   * Comparing that against a clock-derived cutoff invalidated the fixture the instant it was built.
   *
   * The baseline is read AFTER those writes, so it contains them, and only a LATER write exceeds it.
   */
  it("HEALTHY STORE: a fresh preparation whose own trigger-advanced writes land in the completion second is VALID", () => {
    // Rows stamped 200ms before completion (the trigger firing on the preparation's own UPDATEs),
    // and the baseline observed right after them — the shape reembed-store actually produces.
    const triggerAdvanced = PREPARED_AT - 200;
    const fresh = {
      ...BASE,
      latestRowWriteAt: triggerAdvanced,
      reembed: { ...BASE.reembed, rows_max_at: triggerAdvanced },
    };
    const space = readStoreSpace(stubReader(fresh), "/tmp/fresh.db");
    expect(space.attribution.state).toBe("candidate");
    expect(scoredSpaceIdentity(space, "observations")).toMatchObject({ trustable: true });
    expect(() => requireTrustableSpace(space)).not.toThrow();
  });

  it("catches an engine write that lands AFTER the baseline, even by one millisecond", () => {
    // The sync trigger's `MAX(last_mutation_at + 1, now)` is monotonic, so the next engine write
    // stamps strictly above the baseline even inside the same second.
    const triggerAdvanced = PREPARED_AT - 200;
    const written = {
      ...BASE,
      latestRowWriteAt: triggerAdvanced + 1,
      reembed: { ...BASE.reembed, rows_max_at: triggerAdvanced },
    };
    expect(reasonOf(written)).toMatch(/an observation has been written since the preparation/);
    expect(reasonOf(written)).toMatch(/baseline recorded at preparation/);
  });

  it("still catches a plainly later write", () => {
    expect(reasonOf({ ...BASE, latestRowWriteAt: PREPARED_AT + 5_000 })).toMatch(/has been written since the preparation/);
  });

  it("a marker with no recorded baseline cannot be verified", () => {
    expect(reasonOf({ ...BASE, reembed: { ...BASE.reembed, rows_max_at: null } }))
      .toMatch(/records no row-write baseline/);
  });

  it("UNREADABILITY invalidates too — an unchecked signal is not a passed one", () => {
    expect(reasonOf({ ...BASE, latestRowWriteAt: null })).toMatch(/no observation timestamp could be read/);
    expect(reasonOf({ ...BASE, pinnedAt: null })).toMatch(/carries no embedder_pinned_at/);
    expect(reasonOf({ ...BASE, syncMetaMissing: true })).toMatch(/sync_meta could not be read/);
    expect(reasonOf({ ...BASE, migrationTableMissing: true })).toMatch(/embedder_migration sentinel could not be read/);
  });

  it("gives every one of them the SAME instruction and the same state", () => {
    for (const opts of [
      { ...BASE, pinnedAt: PREPARED_AT + 1 },
      { ...BASE, latestRowWriteAt: PREPARED_AT }, // written after the baseline
      { ...BASE, latestRowWriteAt: null },
      { ...BASE, observationDim: 1024 },
    ]) {
      const space = readStoreSpace(stubReader(opts), "/tmp/f.db");
      expect(space.attribution.state).toBe("fixture-invalid");
      // Neither population is attributed, and both carry the one instruction.
      for (const population of ["observations", "concepts"] as const) {
        const identity = scoredSpaceIdentity(space, population);
        expect(identity.trustable).toBe(false);
        expect(identity.source).toBe("fixture-invalid");
        expect(identity.label).toContain("not a valid fixture — rebuild it with reembed-store.ts");
      }
      expect(captured(() => printStoreHeader(stubReader(opts), "/tmp/f.db")))
        .toMatch(/PREPARE -> MEASURE -> DISCARD/);
    }
  });

  it("a CLEAN fixture still passes, and says the contract is what keeps it sound", () => {
    const space = readStoreSpace(stubReader(BASE), "/tmp/clean.db");
    expect(space.attribution.state).toBe("candidate");
    expect(scoredSpaceIdentity(space, "observations")).toMatchObject({ id: "Xenova/bge-base-en-v1.5", trustable: true });
    const out = captured(() => printStoreHeader(stubReader(BASE), "/tmp/clean.db"));
    expect(out).toMatch(/VALID AS OF THIS READ/);
    // The undetectable case is stated on the PASSING path too — that is the whole point of a contract
    // term: it governs where the check cannot reach.
    expect(out).toMatch(/a segment rewrite leaves no timestamp to check/);
  });
});

/**
 * THE REFUSAL HAS TEETH.
 *
 * Every state above already printed a STOP, and a printed STOP is worth exactly the reader's
 * attention — which is nil when the figure is read off the bottom of an eighteen-second run. The
 * measurement must not happen at all.
 */
describe("measure-header — requireTrustableSpace aborts rather than decorating", () => {
  const BASE = {
    pin: "Xenova/bge-small-en-v1.5", conceptDim: 384, observationDim: 384,
    reembed: { candidate_model_id: "Xenova/bge-base-en-v1.5", requested_model: "Xenova/bge-base-en-v1.5", measured_dim: 384 },
  };
  const INVALID = { ...BASE, latestRowWriteAt: 1756000065000 };
  const MIGRATING = { pin: "m", observationDim: 384, migrationRows: 1 };
  const INTERRUPTED = { ...BASE, reembed: { ...BASE.reembed, completed_at: null } };

  afterEach(() => { delete process.env.MEASURE_ALLOW_MIXED; });

  it("throws on every untrustable state, naming the state and the escape hatch", () => {
    for (const opts of [INVALID, MIGRATING, INTERRUPTED]) {
      const space = readStoreSpace(stubReader(opts), "/tmp/x.db");
      expect(() => requireTrustableSpace(space)).toThrow(/Refusing to measure/);
      expect(() => requireTrustableSpace(space)).toThrow(/MEASURE_ALLOW_MIXED=1/);
    }
  });

  it("names the specific rebuild instruction when the fixture is merely invalid", () => {
    const space = readStoreSpace(stubReader(INVALID), "/tmp/x.db");
    expect(() => requireTrustableSpace(space)).toThrow(/not a valid fixture — rebuild it with reembed-store\.ts/);
  });

  it("proceeds — loudly — when MEASURE_ALLOW_MIXED=1", () => {
    process.env.MEASURE_ALLOW_MIXED = "1";
    const space = readStoreSpace(stubReader(INVALID), "/tmp/x.db");
    const out = captured(() => expect(() => requireTrustableSpace(space)).not.toThrow());
    expect(out).toMatch(/MEASURE_ALLOW_MIXED=1 — proceeding/);
    expect(out).toMatch(/deliberately unattributed/);
  });

  it("only '1' opens the hatch — any other value still aborts", () => {
    process.env.MEASURE_ALLOW_MIXED = "true";
    const space = readStoreSpace(stubReader(INVALID), "/tmp/x.db");
    expect(() => requireTrustableSpace(space)).toThrow(/Refusing to measure/);
  });

  it("passes silently for a clean fixture and for an ordinary pinned store", () => {
    for (const opts of [BASE, { pin: "m", observationDim: 1024, conceptDim: 1024 }]) {
      const space = readStoreSpace(stubReader(opts), "/tmp/x.db");
      const out = captured(() => expect(() => requireTrustableSpace(space)).not.toThrow());
      expect(out).toBe("");
    }
  });

  it("accepts null — a script that builds its own in-memory store has nothing to refuse", () => {
    const out = captured(() => expect(() => requireTrustableSpace(null)).not.toThrow());
    expect(out).toBe("");
  });
});
