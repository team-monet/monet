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
 */

/** Minimal structural reader — same shape convention as src/embedding-state.ts's, so this module
 *  needs no better-sqlite3 type import and works against any prepared-statement handle. */
interface HeaderReader {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

export interface StoreSpace {
  /** The path the script actually resolved, whatever env var it read to get there. */
  dbPath: string;
  /** `sync_meta.embedder_model_id`; null when the store is unpinned or has no sync_meta. */
  pin: string | null;
  /** Whether `sync_meta` could be read at all — an unpinned store and an absent table differ. */
  pinReadable: boolean;
  /** Width of one sampled stored vector; null when the store holds none. */
  dim: number | null;
  /** Which population the sample came from, so a reader can go look at the same row. */
  dimSource: "concepts" | "observations" | null;
}

function sampleDimension(db: HeaderReader): { dim: number | null; source: StoreSpace["dimSource"] } {
  for (const source of ["concepts", "observations"] as const) {
    try {
      const row = db.prepare(
        `SELECT embedding AS e FROM ${source} WHERE embedding IS NOT NULL LIMIT 1`,
      ).get() as { e: string } | undefined;
      if (row === undefined) continue;
      const parsed = JSON.parse(row.e) as unknown;
      if (Array.isArray(parsed)) return { dim: parsed.length, source };
    } catch {
      // A missing table or an unparseable vector is not this header's business to diagnose —
      // `monet doctor` owns that. Fall through and report the dimension as unavailable.
    }
  }
  return { dim: null, source: null };
}

export function readStoreSpace(db: HeaderReader, dbPath: string): StoreSpace {
  let pin: string | null = null;
  let pinReadable = true;
  try {
    pin = (db.prepare(`SELECT embedder_model_id AS m FROM sync_meta`).get() as { m: string | null } | undefined)?.m ?? null;
  } catch {
    pinReadable = false;
  }
  const { dim, source } = sampleDimension(db);
  return { dbPath, pin, pinReadable, dim, dimSource: source };
}

/**
 * Read the store's space and print it. Returns the space so a script that also LOADS an embedder
 * can hand it to printEmbedderHeader below and have the mismatch checked for it.
 */
export function printStoreHeader(db: HeaderReader, dbPath: string): StoreSpace {
  const space = readStoreSpace(db, dbPath);
  const pin = space.pinReadable ? (space.pin ?? "(no pin)") : "(unavailable)";
  const dim = space.dim === null ? "(no stored vectors)" : `${space.dim} (sampled from ${space.dimSource})`;
  console.log(`db=${dbPath}`);
  console.log(`store space: pin=${pin}  dim=${dim}`);
  return space;
}

/**
 * The header for a script that builds its own in-memory store instead of reading one. There is no
 * pin and no persisted vector to sample, and saying so is the record — a blank where the space
 * should be is what this whole module exists to stop.
 */
export function printSyntheticStoreHeader(note: string): void {
  console.log(`db=:memory: (built by this run — ${note})`);
  console.log(`store space: pin=(n/a — synthetic fixture)  dim=(n/a — each measurement below names its own embedder)`);
}

/**
 * The embedder this run actually loaded, and — the reason this function exists — whether it matches
 * the store it is about to read. A loaded model different from the store's pin means every cosine
 * below compares a freshly-embedded probe against vectors from a different space, which is not a
 * measurement of anything. It is a WARNING rather than a refusal: re-embedding a store deliberately
 * under a candidate model is a legitimate experiment, and these scripts are how it gets run.
 */
export function printEmbedderHeader(
  space: StoreSpace | null,
  embedder: { modelId?: string; dim: number },
): void {
  const modelId = embedder.modelId ?? "(no modelId)";
  console.log(`loaded embedder: model=${modelId}  dim=${embedder.dim}`);
  if (space === null || !space.pinReadable || space.pin === null) return;
  if (space.pin !== modelId) {
    console.log(
      `!! WARNING: loaded embedder '${modelId}' does NOT match the store pin '${space.pin}'.\n` +
      `!! Probes are embedded by the loaded model and compared against vectors written by the pinned\n` +
      `!! one, so every figure below is a cross-space comparison. Fix the MODEL env var, or read the\n` +
      `!! output as a deliberate swap experiment — it is not a measurement of either space alone.`,
    );
  } else if (space.dim !== null && space.dim !== embedder.dim) {
    console.log(
      `!! WARNING: model id matches the pin but the stored vectors are ${space.dim}-dim and this\n` +
      `!! embedder produces ${embedder.dim}-dim. The store is mid-migration or corrupt; run monet doctor.`,
    );
  }
}
