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
import { describe, it, expect, vi } from "vitest";
import {
  printEmbedderHeader, printStoreHeader, printStoredOnlySection, readStoreSpace, scoredSpaceIdentity,
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
  /** Present => the copy carries scripts/reembed-store.ts's marker. Absent => no such table. */
  reembed?: {
    candidate_model_id: string | null; requested_model: string; pooling?: string | null;
    dtype?: string | null; measured_dim: number;
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
              rewritten_at: 1756000000000,
            };
          }
          if (sql.includes("sync_meta")) {
            if (opts.syncMetaMissing) throw new Error("no such table: sync_meta");
            return { m: opts.pin ?? null };
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
    expect(out).toMatch(/applies to the earlier section, not to this one/);
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
    expect(out).toContain("scored side (observations + segments) -> Xenova/bge-base-en-v1.5");
    expect(out).toContain("concepts + sync_meta                  -> Xenova/bge-small-en-v1.5");
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

  it("warns when the marker's recorded width disagrees with the rows — something rewrote them after", () => {
    const stale = { ...SWAP, observationDim: 1024 };
    const out = captured(() => printStoreHeader(stubReader(stale), "/tmp/swap.db"));
    expect(out).toMatch(/marker records a 384-dim rewrite but the observations sampled/);
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
  });
});
