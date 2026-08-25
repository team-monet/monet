/**
 * THE SPACE A MEASUREMENT WAS TAKEN IN — printed by every measure-* script before it measures.
 *
 * WHY THIS EXISTS. Most of these scripts import no embedder: they read whatever vectors the
 * database they are pointed at already holds, so the embedding space is an accident of an env var
 * rather than a declared input. Nothing in the output said which space that was, and the cost came
 * due on 2026-08-24, when monet-hq migrated from `Xenova/bge-small-en-v1.5` (384-dim) to
 * `Xenova/bge-m3:cls:q8` (1024-dim): two shipped derivation comments — LEXICAL_BOOST in
 * src/lexical-overlap.ts and the attach-precision sweep in src/embedding.ts — had already recorded
 * bge-small runs under a bge-m3 label, and a third (tauMargin, src/embedding-onnx.ts) sits on a
 * profile it was never measured in. Every one of those is the same missing field.
 *
 * So the header is not decoration. A run whose output is pasted into a comment carries its own
 * provenance, and a constant derived from it can be checked against the space it governs.
 *
 * IT REPORTS UNAVAILABLE RATHER THAN GUESSING. An unpinned store prints `(no pin)`; a store with no
 * `sync_meta` at all prints `(unavailable)`; a store holding no vectors prints `(no stored
 * vectors)`. Those are three different facts and collapsing them into one would reintroduce exactly
 * the ambiguity this file exists to remove.
 *
 * CONCEPTS AND OBSERVATIONS ARE SAMPLED SEPARATELY, because a store in this repo's own workflow can
 * legitimately hold two spaces at once. scripts/reembed-store.ts — the documented prep path for the
 * nomination replays — rewrites observations and segments into a candidate space and says of itself:
 * "IT DOES NOT TOUCH CONCEPT VECTORS, and a measurement that reads them will silently answer about
 * the OLD space while every count looks healthy". It leaves `sync_meta` on the old pin too. A header
 * that sampled one population and stopped would report the pin's space for a store whose scored
 * population is in another, which is this module's own failure mode wearing a fix's clothes.
 */

/** Minimal structural reader — same shape convention as src/embedding-state.ts's, so this module
 *  needs no better-sqlite3 type import and works against any prepared-statement handle. */
interface HeaderReader {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/** Which population a script's cosines actually meet — the fact that decides what a mismatch means. */
export type ScoringSide =
  /** Freshly-embedded probes are compared against vectors READ FROM THE STORE. */
  | "against-stored-vectors"
  /** Every scored vector is re-embedded by the loaded model first; the store supplies only text. */
  | "replaces-stored-vectors";

export interface StoreSpace {
  /** The path the script actually resolved, whatever env var it read to get there. */
  dbPath: string;
  /** `sync_meta.embedder_model_id`; null when the store is unpinned or has no sync_meta. */
  pin: string | null;
  /** Whether `sync_meta` could be read at all — an unpinned store and an absent table differ. */
  pinReadable: boolean;
  /** Width of ONE sampled `concepts.embedding`; null when none is readable. */
  conceptDim: number | null;
  /** Width of ONE sampled `observations.embedding`; null when none is readable. */
  observationDim: number | null;
  /**
   * The width a vector-scoring run will actually meet. Observations first: every script here that
   * scores stored vectors scores the observation/segment population (the concept centroid is read
   * by the engine, not by these replays), and that is also the side reembed-store.ts rewrites.
   */
  dim: number | null;
  /** True when the two populations are BOTH known and DISAGREE — a partial re-embed or a half-migration. */
  dimSplit: boolean;
}

/**
 * ONE row per population. A LIMIT 1 sample proves what that row is, not what every row is: a store
 * with mixed widths INSIDE one table reads as uniform here. That is deliberate — `monet doctor` and
 * src/embedding-state.ts own the full census, and duplicating a scan into a header would make every
 * measurement pay for it. What this catches is the cross-population split, which is the one these
 * scripts produce for themselves.
 */
function sampleDimension(db: HeaderReader, table: "concepts" | "observations"): number | null {
  try {
    const row = db.prepare(
      `SELECT embedding AS e FROM ${table} WHERE embedding IS NOT NULL LIMIT 1`,
    ).get() as { e: string } | undefined;
    if (row === undefined) return null;
    const parsed = JSON.parse(row.e) as unknown;
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    // A missing table or an unparseable vector is not this header's business to diagnose —
    // `monet doctor` owns that. Report the dimension as unavailable.
    return null;
  }
}

export function readStoreSpace(db: HeaderReader, dbPath: string): StoreSpace {
  let pin: string | null = null;
  let pinReadable = true;
  try {
    pin = (db.prepare(`SELECT embedder_model_id AS m FROM sync_meta`).get() as { m: string | null } | undefined)?.m ?? null;
  } catch {
    pinReadable = false;
  }
  const conceptDim = sampleDimension(db, "concepts");
  const observationDim = sampleDimension(db, "observations");
  return {
    dbPath,
    pin,
    pinReadable,
    conceptDim,
    observationDim,
    dim: observationDim ?? conceptDim,
    dimSplit: conceptDim !== null && observationDim !== null && conceptDim !== observationDim,
  };
}

/** How the two sampled populations read as one line. */
function describeDim(space: StoreSpace): string {
  if (space.dimSplit) return `concepts=${space.conceptDim} observations=${space.observationDim}`;
  if (space.observationDim !== null && space.conceptDim !== null) return `${space.dim} (concepts + observations)`;
  if (space.observationDim !== null) return `${space.observationDim} (observations; concepts hold none)`;
  if (space.conceptDim !== null) return `${space.conceptDim} (concepts; observations hold none)`;
  return "(no stored vectors)";
}

/**
 * Read the store's space and print it. Returns the space so a script that also LOADS an embedder
 * can hand it to printEmbedderHeader below and have the mismatch checked for it.
 */
export function printStoreHeader(db: HeaderReader, dbPath: string): StoreSpace {
  const space = readStoreSpace(db, dbPath);
  const pin = space.pinReadable ? (space.pin ?? "(no pin)") : "(unavailable)";
  console.log(`db=${dbPath}`);
  console.log(`store space: pin=${pin}  dim=${describeDim(space)}`);
  if (space.dimSplit) {
    console.log(
      `!! NOTE: this store holds TWO embedding spaces — concepts at ${space.conceptDim}-dim, observations\n` +
      `!! at ${space.observationDim}-dim. That is the signature of a partial re-embed (scripts/reembed-store.ts\n` +
      `!! rewrites observations and segments and leaves concepts and the pin alone) or an interrupted\n` +
      `!! migration. The nomination replays score the OBSERVATION side, so the pin above may name\n` +
      `!! neither the space they measure nor the one the concept vectors are in.`,
    );
  }
  return space;
}

/**
 * The header for a script that builds its own in-memory store instead of reading one. There is no
 * pin and no persisted vector to sample, and saying so is the record — a blank where the space
 * should be is what this whole module exists to stop. Each measurement below still names its own
 * provider via printProviderIdentity.
 */
export function printSyntheticStoreHeader(note: string): void {
  console.log(`db=:memory: (built by this run — ${note})`);
  console.log(`store space: pin=(n/a — synthetic fixture)  dim=(n/a — each measurement below names its own provider)`);
}

/**
 * A provider's SPACE IDENTITY, for the runs that have no pin to name one.
 *
 * `modelId` is that identity where it exists, and it is complete: HashingEmbeddingProvider builds
 * `hashing:dim=${dim}:tok=${tokenizerVersion}` from exactly the two parameters that determine its
 * vectors, and embedding.ts's own standing note says "The version number IS the vector space's
 * identity". An ONNX provider loaded off-profile can have none, and then the honest line names the
 * width and says the rest is unidentified rather than inventing an id — the same call
 * scripts/reembed-store.ts already makes for its own log.
 */
export function embedderIdentity(embedder: { modelId?: string; dim: number }): string {
  return embedder.modelId ?? `(no modelId — dim=${embedder.dim}, nothing here names this space)`;
}

/** Name the provider one measurement is about to run under, beside that measurement's own label. */
export function printProviderIdentity(label: string, embedder: { modelId?: string; dim: number }): void {
  console.log(`  provider space: ${embedderIdentity(embedder)}  dim=${embedder.dim}   [${label}]`);
}

/**
 * The embedder this run actually loaded, and whether it is compatible with the store beside it.
 *
 * TWO INDEPENDENT CHECKS, because they fail for different reasons and one used to hide the other.
 *
 *  - WIDTH runs whenever both widths are known, PINNED OR NOT. `cosine()` (src/embedding.ts) is
 *    `const n = Math.min(a.length, b.length)` — it silently scores the shorter prefix of a mismatched
 *    pair and returns a plausible number. There is no throw and no NaN to notice, so an unpinned
 *    store compared against a wider model produces a full sweep of quiet nonsense. Gating this
 *    behind a readable pin, as the first version did, withheld the check from precisely the stores
 *    that have nothing else to catch it.
 *  - IDENTITY needs a pin to compare against, so it stays gated on one.
 *
 * `scoring` is what makes the identity message accurate. A run that RE-EMBEDS every candidate is a
 * deliberate candidate-model experiment whose results are wholly in the loaded space — calling that
 * a cross-space comparison would be a false alarm. A run that scores freshly-embedded probes against
 * STORED vectors under a different model is the real defect. The call site knows which it is; this
 * function cannot infer it.
 */
export function printEmbedderHeader(
  space: StoreSpace | null,
  embedder: { modelId?: string; dim: number },
  scoring: ScoringSide,
): void {
  const modelId = embedder.modelId ?? "(no modelId)";
  console.log(`loaded embedder: model=${modelId}  dim=${embedder.dim}`);

  // WIDTH — independent of the pin. Compare against the population this run will actually meet.
  if (space !== null && scoring === "against-stored-vectors" && space.dim !== null && space.dim !== embedder.dim) {
    const pinNote = space.pinReadable && space.pin !== null
      ? `The store pin is '${space.pin}'.`
      : `The store carries no pin to corroborate which space its vectors are in.`;
    console.log(
      `!! WARNING: this embedder produces ${embedder.dim}-dim vectors and the stored vectors this run\n` +
      `!! scores against are ${space.dim}-dim${space.dimSplit ? ` (observations; concepts are ${space.conceptDim}-dim)` : ""}. ${pinNote}\n` +
      `!! cosine() truncates to the SHORTER of the two widths — it does not throw and does not return\n` +
      `!! NaN — so every figure below is a dot product over a prefix, not a similarity. Do not read it.`,
    );
  }

  // IDENTITY — needs a pin.
  if (space === null || !space.pinReadable || space.pin === null) return;
  if (space.pin === modelId) return;
  if (scoring === "against-stored-vectors") {
    console.log(
      `!! WARNING: loaded embedder '${modelId}' does NOT match the store pin '${space.pin}'.\n` +
      `!! Probes are embedded by the loaded model and compared against vectors written by the pinned\n` +
      `!! one, so every figure below is a cross-space comparison. Fix the MODEL env var, or read the\n` +
      `!! output as a deliberate swap experiment — it is not a measurement of either space alone.`,
    );
  } else {
    console.log(
      `   (candidate-model run: '${modelId}' differs from the store pin '${space.pin}', but every scored\n` +
      `   vector below is re-embedded by the loaded model, so the results are wholly in '${modelId}'\n` +
      `   space. The pin names what the STORE holds, which this run does not measure.)`,
    );
  }
}
