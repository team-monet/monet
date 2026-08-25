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
 *
 * ── THE FIXTURE CONTRACT: PREPARE -> MEASURE -> DISCARD ────────────────────────────────────────
 *
 * A copy prepared by reembed-store.ts is valid for ONE measurement session and is then thrown away.
 * Anything that touches it in between — an engine write, a migration, a second preparation, a manual
 * edit — voids it. The checks below catch most of that, and `requireTrustableSpace` refuses to run
 * when they fire.
 *
 * THEY CANNOT CATCH ALL OF IT, and the contract rather than the checks is what makes the fixture
 * sound. `observation_segments` carries NO timestamp of any kind (engine.ts: its primary key is
 * `(observation_id, segment_index)` and it holds only content and embedding — it inherits liveness
 * from its observation and is written in the same transaction). So a segment rewritten after the
 * preparation is undetectable here, permanently and by construction. Adding a column to the engine
 * to close that would be tail-wagging: segments are engine state, this is measurement scaffolding,
 * and the scaffolding does not get to shape the thing it measures. The rule is therefore a contract
 * term, stated in the header output on both the valid and the invalid path: do not touch the copy
 * between preparing it and measuring it, whether or not anything here would notice.
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

/**
 * What scripts/reembed-store.ts recorded about a copy it prepared, when it prepared one.
 *
 * The row exists precisely because width cannot answer this. A same-width candidate swap — another
 * 384-dim model, or the same checkpoint at a different pooling or dtype — rewrites every observation
 * and segment vector and leaves the file otherwise identical: same pin, same row counts, same
 * sampled dimension, no split. Without this row a header reports uniform agreement with a pin that
 * no longer describes the vectors these scripts score.
 */
export interface ReembedProvenance {
  /** The candidate's own id; NULL when the checkpoint is off-profile and nothing names its space. */
  candidateModelId: string | null;
  /** What was asked for — always known, even when no id names the resulting space. */
  requestedModel: string;
  pooling: string | null;
  dtype: string | null;
  /** The width that run actually produced, measured from a real vector. */
  measuredDim: number;
  populations: string;
  /**
   * The newest observation row timestamp AS THE PREPARATION LEFT IT — read after its own writes, so
   * it already contains them. The header invalidates on a current max that EXCEEDS this, which is
   * why the preparation's own trigger-advanced `updated_at` values cannot invalidate the fixture
   * they belong to. Null only on a marker written before this column existed.
   */
  rowsMaxAt: number | null;
  startedAt: number;
  /**
   * When the rewrite finished. NULL means it did NOT — the process is still running or it died
   * partway, and the vectors are a MIX of the old space and the candidate's. Nothing about such a
   * store can be attributed to either.
   */
  completedAt: number | null;
}

/**
 * Which stored population a section is about to score. They are not interchangeable on a copy
 * scripts/reembed-store.ts prepared: it rewrites observations and segments and leaves concepts in
 * the pinned space, so one script reading both — measure-fork-and-edge-bands.ts scores segments for
 * tauAmbiguous and concept pairs for edgeSimMin — has two answers, not one.
 */
export type ScoredPopulation = "observations" | "concepts";

/**
 * THE ONE RESOLVED ANSWER to "what space is this store in", computed once in readStoreSpace.
 *
 * FIVE STATES, AND THE SHRINK IS THE POINT. Earlier drafts of this module grew one state per way a
 * fixture could go wrong — superseded by a re-pin, partially overwritten, undateable — each with its
 * own message and its own remedy. That was the wrong axis. A measurement fixture is either something
 * a number may be attributed to or it is not, and every one of those distinctions ended in the same
 * instruction: rebuild the copy. So they collapse into `fixture-invalid`, which carries the failed
 * check as its reason rather than as its identity.
 *
 * The two STOP states stay separate because their REMEDIES differ: an unfinished engine migration is
 * fixed with `monet doctor` on a real store, an unfinished fixture preparation by rebuilding a
 * scratch copy. Nothing else here has a remedy of its own.
 *
 *   official-migration-interrupted  the ENGINE's own migration died partway. `sync_meta` already
 *                                   names the TARGET (the pin is written at migration START), so
 *                                   the store looks coherent and is not.
 *   fixture-interrupted             reembed-store.ts began a preparation and never published it.
 *   fixture-invalid                 a completed marker that no longer describes the copy, or whose
 *                                   description could not be confirmed. One state, many reasons.
 *   candidate                       a completed marker that passed every check.
 *   pin                             no fixture marker; the pin is the identity. The common case.
 */
export type SpaceAttribution =
  | { state: "official-migration-interrupted" }
  | { state: "fixture-interrupted" }
  | { state: "fixture-invalid"; reason: string }
  | { state: "candidate" }
  | { state: "pin" };

/** What a reader is told to do about a fixture that cannot be trusted. One sentence, everywhere. */
const REBUILD = "this copy is not a valid fixture — rebuild it with reembed-store.ts";

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
  /** scripts/reembed-store.ts's marker, when this copy was prepared by it; null otherwise. */
  reembed: ReembedProvenance | null;
  /**
   * `sync_meta.embedder_pinned_at`. The engine stamps this on every pin write — creation, backfill,
   * and `writeMigratedEmbedderPin` — so a value later than a fixture marker's completion means an
   * official migration has since rewritten the vectors that marker described.
   */
  pinnedAt: number | null;
  /**
   * True when the engine's `embedder_migration` sentinel has a row: an OFFICIAL migration is running
   * or died. Null when the table could not be read at all (an old schema), which is not the same as
   * knowing there is none.
   */
  migrationInterrupted: boolean | null;
  /**
   * Newest write across the populations these scripts score, or null when it could not be read.
   * See readLatestRowWrite for which columns are trustworthy and which are not.
   */
  latestRowWriteAt: number | null;
  /** The single resolved verdict. Every consumer reads this rather than re-deriving it. */
  attribution: SpaceAttribution;
}

/**
 * WHICH IDENTITY GOVERNS THE VECTORS THESE SCRIPTS SCORE.
 *
 * Not always the pin. Every consumer here scores the observation/segment population, and that is
 * exactly the population reembed-store.ts rewrites while leaving `sync_meta` alone — so on a
 * prepped copy the pin names the CONCEPT side and the marker names the scored side.
 *
 * Returns `id: null` with `known: false` for an off-profile candidate: the run happened, the space
 * changed, and nothing names it. That is a third answer, and collapsing it into either "matches" or
 * "does not match" is the kind of guess this module exists to refuse.
 */
export function scoredSpaceIdentity(space: StoreSpace, population: ScoredPopulation = "observations"): {
  id: string | null;
  known: boolean;
  /** False when the store is in a state no single identity describes — see SpaceAttribution. */
  trustable: boolean;
  source:
    | "reembed-marker" | "pin"
    | "reembed-interrupted" | "engine-migration-interrupted" | "fixture-invalid";
  label: string;
} {
  const r = space.reembed;
  const pinIdentity = (): { id: string | null; known: boolean; trustable: boolean; source: "pin"; label: string } =>
    space.pinReadable && space.pin !== null
      ? { id: space.pin, known: true, trustable: true, source: "pin", label: space.pin }
      : { id: null, known: false, trustable: true, source: "pin", label: space.pinReadable ? "(no pin)" : "(unavailable)" };
  const untrustable = (
    source: "reembed-interrupted" | "engine-migration-interrupted" | "fixture-invalid",
    label: string,
  ): { id: null; known: false; trustable: false; source: typeof source; label: string } =>
    ({ id: null, known: false, trustable: false, source, label });

  switch (space.attribution.state) {
    // BOTH POPULATIONS ARE POISONED by an interrupted rewrite, not just the one being written: some
    // rows are in the new space and some in the old, so even the concept side's "untouched, therefore
    // the pin" reasoning describes only part of the store. Refuse to name a space.
    case "official-migration-interrupted":
      return untrustable(
        "engine-migration-interrupted",
        `INTERRUPTED OFFICIAL MIGRATION toward ${space.pin ?? "(unreadable target)"} — vectors are a MIX of spaces`,
      );
    case "fixture-interrupted":
      return untrustable(
        "reembed-interrupted",
        `INTERRUPTED fixture preparation toward ${r?.candidateModelId ?? r?.requestedModel ?? "(unknown)"} — vectors are a MIX of spaces`,
      );
    // ONE ANSWER FOR EVERY WAY A FIXTURE GOES BAD. Neither population is attributed: the reasons
    // differ in what they invalidate, but not in what the reader must do about it.
    case "fixture-invalid":
      return untrustable("fixture-invalid", `${REBUILD} (${space.attribution.reason})`);
    case "pin":
      return pinIdentity();
    case "candidate":
      break;
  }

  // CONCEPTS ARE NOT REWRITTEN by that script — its own marker says so — so their identity is the
  // pin even on a prepped copy. Attributing a concept-scoring section to the candidate is the same
  // class of error as attributing an observation-scoring one to the pin.
  if (population === "concepts") return pinIdentity();

  const detail = [r!.pooling ? `pooling=${r!.pooling}` : null, r!.dtype ? `dtype=${r!.dtype}` : null]
    .filter((x) => x !== null).join(", ");
  const suffix = detail === "" ? "" : ` [${detail}]`;
  if (r!.candidateModelId !== null) {
    return { id: r!.candidateModelId, known: true, trustable: true, source: "reembed-marker", label: `${r!.candidateModelId}${suffix}` };
  }
  return {
    id: null, known: false, trustable: true, source: "reembed-marker",
    label: `${r!.requestedModel} (off-profile: no id names this space)${suffix}`,
  };
}

/**
 * ONE row per population, FROM THE ROWS THE CONSUMERS ACTUALLY SCORE.
 *
 * `kind != 'source'` is not a tidiness filter, it is the difference between a right and a wrong
 * answer. scripts/reembed-store.ts re-embeds `WHERE kind != 'source'` (its own query) and leaves
 * source observations on the old model, so a prepped copy holds BOTH widths in one table. An
 * unqualified `LIMIT 1` can land on either — and landing on a source row reports the retired width,
 * which agrees with the untouched concepts and therefore suppresses the split NOTE and inverts the
 * width warning, on exactly the store shape this module was extended to catch. Every consumer here
 * filters `o.kind != 'source'` and `c.kind != 'source'`, so the sampler matches them.
 *
 * A LIMIT 1 sample still proves what that row is, not what every row is: a store with mixed widths
 * inside one KIND reads as uniform. That is deliberate — `monet doctor` and src/embedding-state.ts
 * own the full census, and duplicating a scan into a header would make every measurement pay for
 * it. What this catches is the cross-population split, which is the one these scripts produce for
 * themselves.
 */
function sampleDimension(db: HeaderReader, table: "concepts" | "observations"): number | null {
  try {
    const row = db.prepare(
      `SELECT embedding AS e FROM ${table} WHERE embedding IS NOT NULL AND kind != 'source' LIMIT 1`,
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

/** The marker, or null on any store that was not prepared by reembed-store.ts (the common case). */
function readReembedProvenance(db: HeaderReader): ReembedProvenance | null {
  try {
    const row = db.prepare(
      // A marker written by an older build lacks `rows_max_at`, so this SELECT throws and the catch
      // below reports "no marker" — the copy degrades to an ordinary pinned store rather than being
      // half-read. That is the same safe degrade the column additions before it relied on.
      `SELECT candidate_model_id, requested_model, pooling, dtype, measured_dim, populations,
              started_at, completed_at, rows_max_at
         FROM reembed_provenance WHERE singleton = 1`,
    ).get() as {
      candidate_model_id: string | null; requested_model: string; pooling: string | null;
      dtype: string | null; measured_dim: number; populations: string;
      started_at: number; completed_at: number | null; rows_max_at: number | null;
    } | undefined;
    if (row === undefined) return null;
    return {
      candidateModelId: row.candidate_model_id,
      requestedModel: row.requested_model,
      pooling: row.pooling,
      dtype: row.dtype,
      measuredDim: row.measured_dim,
      populations: row.populations,
      rowsMaxAt: row.rows_max_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  } catch {
    // No such table is the NORMAL case — every store not prepared by reembed-store.ts. Absence is
    // not a fault to report, it just means the pin is the only identity available.
    return null;
  }
}

/**
 * Is the ENGINE's own migration sentinel set? Rows present = a migration started and has not
 * completed; `completeEmbedderMigration` deletes the row as its last act (engine.ts), and the
 * findings' §1 verification reads `COUNT(*) = 0` as proof of completion.
 *
 * This matters more than it looks, because `beginEmbedderMigration` calls `writeMigratedEmbedderPin`
 * IMMEDIATELY after inserting the sentinel — the pin names the TARGET model from the moment the
 * migration starts, before a single vector has been rewritten. A store in this state therefore reads
 * as perfectly coherent: a pin, a uniform sampled width, no split. It is not coherent; its vectors
 * are partly the old model's and partly the target's.
 *
 * Returns null when the table cannot be read, which is an old schema rather than a clean store.
 */
function readMigrationInterrupted(db: HeaderReader): boolean | null {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM embedder_migration`).get() as { n: number } | undefined;
    return row === undefined ? null : row.n > 0;
  } catch {
    return null;
  }
}

/**
 * The newest engine write across the scored populations — the cutoff a fixture marker is dated
 * against.
 *
 * WHICH COLUMNS CAN BE BELIEVED. `created_at` is a SCHEMA DEFAULT (`DEFAULT (unixepoch() * 1000)`,
 * engine.ts) and the local ingest path omits the column, so SQLite stamps it on every insert
 * unconditionally. `updated_at` shares that default but is MAINTAINED by the sync triggers, which
 * are gated `WHEN ... (SELECT applying_remote FROM sync_meta ...) = 0` — and `applying_remote` can
 * sit latched at 1 (findings §3.2), in which case the trigger never fires and `updated_at` stays at
 * its insert value. MAX over both is therefore safe in the direction that matters: it can only
 * UNDER-report a mutation, never invent one.
 *
 * Two other known under-reports, stated rather than papered over: a grafted row carries the ORIGIN's
 * `created_at`, so a recent sync of old evidence dates as old; and `observation_segments` has no
 * timestamps at all (it inherits liveness from its observation and is written in the same
 * transaction), so the observation row's stamp stands in for its segments.
 */
function readLatestRowWrite(db: HeaderReader): number | null {
  try {
    const row = db.prepare(
      `SELECT MAX(MAX(created_at), MAX(updated_at)) AS t FROM observations WHERE kind != 'source'`,
    ).get() as { t: number | null } | undefined;
    return row?.t ?? null;
  } catch {
    return null;
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Resolve the ONE state.
 *
 * The two STOP states come first because they have their own remedies. Everything after them is a
 * yes/no on the SAME question — "may a number be attributed to this copy?" — so every failure and
 * every unreadable signal lands in `fixture-invalid` with the failed check as its reason. There is
 * no partial credit: a fixture is valid or it is rebuilt.
 */
function resolveAttribution(
  reembed: ReembedProvenance | null,
  migrationInterrupted: boolean | null,
  pinReadable: boolean,
  pinnedAt: number | null,
  latestRowWriteAt: number | null,
  observationDim: number | null,
): SpaceAttribution {
  if (migrationInterrupted === true) return { state: "official-migration-interrupted" };
  if (reembed === null) return { state: "pin" };
  if (reembed.completedAt === null) return { state: "fixture-interrupted" };

  const invalid = (reason: string): SpaceAttribution => ({ state: "fixture-invalid", reason });

  if (migrationInterrupted === null) {
    return invalid("the embedder_migration sentinel could not be read, so an unfinished official migration cannot be ruled out");
  }
  if (!pinReadable) {
    return invalid("sync_meta could not be read, so a pin write during or after the preparation cannot be ruled out");
  }
  if (pinnedAt === null) {
    return invalid("sync_meta carries no embedder_pinned_at, so a pin write during or after the preparation cannot be ruled out");
  }
  // ANY pin write from `startedAt` onward invalidates, and the SOURCE of it is deliberately not
  // distinguished: migrate, adopt and backfill all stamp this same column, they are indistinguishable
  // after the fact, and all three mean the space was rewritten or re-declared under the preparation.
  // Dated from startedAt rather than completedAt because a pin write DURING the rewrite is at least
  // as bad as one after it.
  if (pinnedAt >= reembed.startedAt) {
    return invalid(
      `the store was pinned at ${iso(pinnedAt)}, at or after this preparation started (${iso(reembed.startedAt)}) — ` +
      `a migration, adopt or backfill has rewritten or re-declared the space since`,
    );
  }
  if (latestRowWriteAt === null) {
    return invalid("no observation timestamp could be read, so engine writes after the preparation cannot be ruled out");
  }
  if (reembed.rowsMaxAt === null) {
    return invalid("the marker records no row-write baseline, so engine writes after the preparation cannot be ruled out");
  }
  // OBSERVED VALUE vs OBSERVED VALUE, and STRICTLY greater. The baseline was read after the
  // preparation's own writes, so it already contains them — including the `updated_at` values its
  // own UPDATEs caused `sync_observations_update` to advance to wall-clock-now on a healthy copy.
  // An earlier draft compared that against a floored `completed_at` instead and declared every
  // freshly built fixture stale; nothing caught it because every store copy on this machine
  // inherits `applying_remote = 1`, which switches those triggers off entirely.
  if (latestRowWriteAt > reembed.rowsMaxAt) {
    return invalid(
      `an observation has been written since the preparation ` +
      `(newest row ${iso(latestRowWriteAt)}, baseline recorded at preparation ${iso(reembed.rowsMaxAt)})`,
    );
  }
  if (observationDim !== null && observationDim !== reembed.measuredDim) {
    return invalid(
      `the marker records a ${reembed.measuredDim}-dim rewrite but the observations sample ${observationDim}-dim`,
    );
  }
  return { state: "candidate" };
}

export function readStoreSpace(db: HeaderReader, dbPath: string): StoreSpace {
  let pin: string | null = null;
  let pinReadable = true;
  let pinnedAt: number | null = null;
  try {
    const row = db.prepare(
      `SELECT embedder_model_id AS m, embedder_pinned_at AS at FROM sync_meta`,
    ).get() as { m: string | null; at: number | null } | undefined;
    pin = row?.m ?? null;
    pinnedAt = row?.at ?? null;
  } catch {
    pinReadable = false;
  }
  const conceptDim = sampleDimension(db, "concepts");
  const observationDim = sampleDimension(db, "observations");
  const reembed = readReembedProvenance(db);
  const migrationInterrupted = readMigrationInterrupted(db);
  const latestRowWriteAt = readLatestRowWrite(db);
  return {
    dbPath,
    pin,
    pinReadable,
    conceptDim,
    observationDim,
    dim: observationDim ?? conceptDim,
    dimSplit: conceptDim !== null && observationDim !== null && conceptDim !== observationDim,
    reembed,
    pinnedAt,
    migrationInterrupted,
    latestRowWriteAt,
    attribution: resolveAttribution(
      reembed, migrationInterrupted, pinReadable, pinnedAt, latestRowWriteAt, observationDim,
    ),
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
  const r = space.reembed;
  const a = space.attribution;
  // ONE BRANCH PER RESOLVED STATE. Exhaustive over SpaceAttribution so a new state cannot be added
  // without deciding what the header says about it, and so two of these can never print at once.
  switch (a.state) {
    case "official-migration-interrupted":
      // The ENGINE's migration, not the fixture script's — a different fault with a different fix,
      // so a different message. `sync_meta` above already names the TARGET model because
      // beginEmbedderMigration writes the pin before rewriting any vector, which is exactly why this
      // store reads as coherent and is not.
      console.log(
        `!! STOP: this store's embedder_migration sentinel is SET — an OFFICIAL migration started and\n` +
        `!! never completed (the engine deletes that row as the last act of a successful one).\n` +
        `!! The pin above is the migration's TARGET, written at its START, so it names a space the\n` +
        `!! vectors are only PARTLY in: some rows were rewritten before the interruption and some were\n` +
        `!! not. Nothing here can tell which. Run 'monet doctor' and finish or abandon the migration\n` +
        `!! before taking any measurement against this store.`,
      );
      break;
    case "fixture-interrupted":
      // Deliberately not a variant of the stale-width warning: that one says "the marker names the
      // wrong space", this one says there is no single space to name.
      console.log(
        `!! STOP: scripts/reembed-store.ts began preparing this copy and never finished.\n` +
        `!!   started: ${new Date(r!.startedAt).toISOString()}  (no completion recorded)\n` +
        `!!   toward:  ${r!.candidateModelId ?? r!.requestedModel}, ${r!.measuredDim}-dim\n` +
        `!! Its observation and segment vectors are a MIX of that candidate's space and the pinned\n` +
        `!! one, in proportions nothing here can determine. No identity describes this store and no\n` +
        `!! measurement taken against it is interpretable. Rebuild the copy from the source store and\n` +
        `!! re-run the preparation before reading anything below.`,
      );
      break;
    case "fixture-invalid":
      console.log(
        `!! STOP: ${REBUILD}.\n` +
        `!!   reason: ${a.reason}\n` +
        `!!   prepared toward: ${r!.candidateModelId ?? r!.requestedModel}, ${r!.measuredDim}-dim\n` +
        `!! The fixture contract is PREPARE -> MEASURE -> DISCARD. Anything that touches the copy\n` +
        `!! between those two points voids it, and not every such touch leaves a trace (see the\n` +
        `!! module header on segments). A number taken here cannot be attributed to any one model.`,
      );
      break;
    case "candidate": {
      const scored = scoredSpaceIdentity(space, "observations");
      const concepts = scoredSpaceIdentity(space, "concepts");
      // THE SPLIT THE PIN CANNOT SHOW. Announced whether or not the widths differ — a same-width
      // swap is the case with no other symptom, and is the reason this marker exists at all.
      console.log(
        `!! NOTE: this copy was prepared by scripts/reembed-store.ts, so its two populations are in\n` +
        `!! DIFFERENT spaces and the pin above describes only one of them:\n` +
        `!!   observations + segments -> ${scored.label}, ${r!.measuredDim}-dim measured\n` +
        `!!   concepts + sync_meta    -> ${concepts.label} (untouched by that rewrite)\n` +
        `!!   rewrote: ${r!.populations}\n` +
        `!!   prepared: ${new Date(r!.completedAt!).toISOString()}\n` +
        `!! A measurement below is in whichever of those two its population belongs to — sections that\n` +
        `!! read concept vectors are still in the PIN's space. Attribute each one accordingly.\n` +
        `!! VALID AS OF THIS READ. The contract is PREPARE -> MEASURE -> DISCARD: every check that\n` +
        `!! could be made passed, but a segment rewrite leaves no timestamp to check, so anything\n` +
        `!! touching this copy after its preparation voids it whether or not this header can see it.`,
      );
      break;
    }
    case "pin":
      break; // the common case: the pin line above already said everything there is to say
  }
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

/** Set to "1" to run a measurement against a store this module refuses to attribute. */
const ALLOW_MIXED_ENV = "MEASURE_ALLOW_MIXED";

/**
 * ABORT unless the store is one a number may be attributed to.
 *
 * A WARNING THAT SCROLLS PAST IS NOT A REFUSAL. Every state below already printed a STOP, and a
 * printed STOP is exactly as effective as the reader's attention — which is nil when the run takes
 * eighteen seconds and the figure gets pasted into a comment from the bottom of the output. The
 * whole defect class this module was built for is measurements attributed to the wrong space, so
 * the honest form of the refusal is a nonzero exit, not a decoration on a result that should not
 * exist.
 *
 * `null` is the in-memory case: a script that builds its own store read nothing and has nothing to
 * refuse. It is accepted rather than rejected so that every measure-* script can call this in the
 * same place, whatever kind of store it uses.
 *
 * The escape hatch exists because deliberately measuring a mixed store is a legitimate thing to do
 * ONCE you know it is mixed — and it is named in the error, so taking it is a decision rather than
 * a discovery.
 */
export function requireTrustableSpace(space: StoreSpace | null): void {
  if (space === null) return;
  const a = space.attribution;
  if (a.state === "candidate" || a.state === "pin") return;
  const detail = a.state === "fixture-invalid" ? `${REBUILD} (${a.reason})` : a.state;
  if (process.env[ALLOW_MIXED_ENV] === "1") {
    console.log(
      `!! ${ALLOW_MIXED_ENV}=1 — proceeding against a store this header refuses to attribute\n` +
      `!! (${detail}). Every figure below is deliberately unattributed. Do not paste it into a\n` +
      `!! derivation comment without saying so.`,
    );
    return;
  }
  throw new Error(
    `Refusing to measure: this store's embedding space cannot be attributed (${a.state}).\n` +
    `  ${detail}\n` +
    `  See the header above for what is wrong and how to fix it.\n` +
    `  To measure anyway, knowing the result belongs to no single model, re-run with ` +
    `${ALLOW_MIXED_ENV}=1.`,
  );
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

/**
 * THE WIDTH TO REPORT, and why the provider's own field is not automatically it.
 *
 * `OnnxEmbeddingProvider.dim` is `opts.dim ?? profile?.dim ?? 384` (embedding-onnx.ts), and that
 * file says of the field: "it is declarative only". `embed()` never consults it — it returns
 * `Float32Array.from(output.data)`, the checkpoint's real output width. So an UNPROFILED candidate
 * model with no explicit `dim` reports 384 while producing 768 or 1024, and a header that trusted
 * the field would stamp the wrong width on the run that most needs the right one: the one
 * evaluating a model no profile describes yet.
 *
 * `measured` is the length of a vector this run actually produced. It wins where it exists, and the
 * line says which it is rather than quietly presenting one as the other. scripts/reembed-store.ts
 * already logs `dim=${warmup.length}` for the same reason.
 */
function describeWidth(declared: number, measured?: number): string {
  if (measured === undefined) return `${declared} (declared by the profile; no vector measured yet)`;
  if (measured === declared) return `${measured} (measured)`;
  return `${measured} (MEASURED — the provider DECLARES ${declared}, a profile fallback that does not describe this checkpoint)`;
}

/** Name the provider one measurement is about to run under, beside that measurement's own label. */
export function printProviderIdentity(
  label: string,
  embedder: { modelId?: string; dim: number },
  measuredDim?: number,
): void {
  console.log(`  provider space: ${embedderIdentity(embedder)}  dim=${describeWidth(embedder.dim, measuredDim)}   [${label}]`);
}

/**
 * Mark a section whose cosines are STORED-vector-to-STORED-vector on both sides.
 *
 * A script can hold sections in different spaces — measure-nomination-size-bias.ts embeds fresh
 * probes for its junk sweep and then replays leave-one-out over stored vectors only — and a single
 * header in front of both is necessarily wrong about one of them. This says which space the lines
 * below are in, and it is the store's own regardless of what model the process loaded.
 */
export function printStoredOnlySection(space: StoreSpace | null, population: ScoredPopulation = "observations"): void {
  const identity = space === null ? null : scoredSpaceIdentity(space, population);
  const label = identity === null ? "(unavailable)" : identity.label;
  const what = population === "concepts" ? "concepts.embedding" : "observation and segment vectors";
  console.log(
    `\n-- stored-vector section (${what}): both sides of every comparison below are read from the\n` +
    `-- store, with no embedding performed, so this is those rows' own space (${label}) whatever\n` +
    `-- model is loaded. Any loaded-embedder warning above applies elsewhere, not to this section.`,
  );
  // The population that did NOT move is the one a prepped copy misattributes, so say it outright
  // rather than leaving the reader to infer it from the header block far above.
  if (identity !== null && identity.trustable && space?.reembed != null && population === "concepts") {
    console.log(
      `-- NOTE: reembed-store.ts did NOT rewrite these vectors. This section is in the PINNED space\n` +
      `-- while the rest of this run scores the candidate's — the two are not comparable.`,
    );
  }
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
  measuredDim?: number,
): void {
  const modelId = embedder.modelId ?? "(no modelId)";
  // The width that will actually meet the stored vectors is the one embed() produces, not the one
  // the provider declares — see describeWidth. Comparing on the declared value would let an
  // unprofiled 1024-dim candidate pass a 1024-dim store's check while reporting 384, or fail it.
  const effectiveDim = measuredDim ?? embedder.dim;
  console.log(`loaded embedder: model=${modelId}  dim=${describeWidth(embedder.dim, measuredDim)}`);

  // WIDTH — independent of the pin. Compare against the population this run will actually meet.
  if (space !== null && scoring === "against-stored-vectors" && space.dim !== null && space.dim !== effectiveDim) {
    const pinNote = space.pinReadable && space.pin !== null
      ? `The store pin is '${space.pin}'.`
      : `The store carries no pin to corroborate which space its vectors are in.`;
    console.log(
      `!! WARNING: this embedder produces ${effectiveDim}-dim vectors and the stored vectors this run\n` +
      `!! scores against are ${space.dim}-dim${space.dimSplit ? ` (observations; concepts are ${space.conceptDim}-dim)` : ""}. ${pinNote}\n` +
      `!! cosine() truncates to the SHORTER of the two widths — it does not throw and does not return\n` +
      `!! NaN — so every figure below is a dot product over a prefix, not a similarity. Do not read it.`,
    );
  }

  // IDENTITY — compared against the SCORED side, which is the pin only when no candidate rewrite
  // has happened. On a reembed-prepped copy the pin describes the concepts, and comparing against it
  // would flag a correctly-matched candidate run as a mismatch (and pass the genuinely wrong one).
  if (space === null) return;
  const scored = scoredSpaceIdentity(space, "observations");
  // AN INTERRUPTED PREPARATION SHORT-CIRCUITS EVERY COMPARISON. There is no space to match or
  // mismatch against — the stored rows are two spaces at once — so the only honest output is that
  // the question cannot be asked. printStoreHeader has already said STOP; this keeps the embedder
  // line from quietly following it with a verdict that implies otherwise.
  if (!scored.trustable) {
    if (scoring === "against-stored-vectors") {
      // Name the CAUSE — the three untrustable states need different remedies, and "rebuild the
      // copy" is wrong advice for a store whose own migration is half-finished. Keyed off the
      // CURRENT state set; the collapse to `fixture-invalid` left this mapping naming two retired
      // states, so the one case that most needs a diagnosis printed "come from undefined".
      const cause = space.attribution.state === "fixture-invalid"
        ? `${REBUILD}\n!! (${space.attribution.reason})`
        : {
          "engine-migration-interrupted":
            "an INTERRUPTED OFFICIAL MIGRATION (see the STOP above) — finish or abandon it with 'monet doctor'",
          "reembed-interrupted":
            "an INTERRUPTED fixture preparation (see the STOP above) — rebuild the copy",
        }[scored.source as "engine-migration-interrupted" | "reembed-interrupted"];
      console.log(
        `!! REFUSING TO ATTRIBUTE: the stored vectors this run scores against come from\n` +
        `!! ${cause}.\n` +
        `!! They are not all in one space, so whether '${modelId}' matches them is not a question\n` +
        `!! with an answer. Nothing below is interpretable as a measurement of any single model.`,
      );
    }
    return;
  }
  const via = scored.source === "reembed-marker" ? "the candidate this copy was re-embedded with" : "the store pin";
  if (!scored.known) {
    if (scored.source === "reembed-marker" && scoring === "against-stored-vectors") {
      console.log(
        `!! WARNING: this copy was re-embedded with '${scored.label}', which carries no model id, so\n` +
        `!! whether the loaded '${modelId}' is the SAME space cannot be established here — only that the\n` +
        `!! stored vectors are not the pin's. Rebuild the copy with a profiled checkpoint to compare.`,
      );
    }
    return; // an unpinned, unprepared store has no identity to compare against at all
  }
  if (scored.id === modelId) return;
  if (scoring === "against-stored-vectors") {
    console.log(
      `!! WARNING: loaded embedder '${modelId}' does NOT match ${via} '${scored.label}'.\n` +
      `!! Probes are embedded by the loaded model and compared against vectors written by that other\n` +
      `!! one, so every figure below is a cross-space comparison. Fix the MODEL env var, or read the\n` +
      `!! output as a deliberate swap experiment — it is not a measurement of either space alone.`,
    );
  } else {
    console.log(
      `   (candidate-model run: '${modelId}' differs from ${via} '${scored.label}', but every scored\n` +
      `   vector below is re-embedded by the loaded model, so the results are wholly in '${modelId}'\n` +
      `   space. That other id names what the STORE holds, which this run does not measure.)`,
    );
  }
}
