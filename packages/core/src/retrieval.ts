/**
 * Retrieval scoring — the query-ranking arms for search() and gather(), extracted from the
 * engine monolith (refactoring-build directive: each subsystem gets restructured as it is
 * touched). ORCHESTRATION stays in engine.ts; only the scoring math lives here.
 *
 * THE UNIT SPLIT (recall design call 2026-07-26). Observations are the unit of RETRIEVAL;
 * concepts are the unit of DELIVERY.
 *
 * The defect this closes: a many-observation concept's `concepts.embedding` is a running-mean
 * centroid (blend(), embedding.ts) over everything ever attached to it, so it embeds to a blurred
 * mixture — pointing at no one query in particular. Measured on the live store (2026-07-25),
 * cosine against that centroid correlates r = -0.584 with log(body length) on ON-TOPIC queries
 * and r = -0.522 OFF-topic: length moved the score regardless of relevance, which means the
 * store's richest, most-consolidated concepts were its LEAST findable — consolidation's virtue
 * destroying findability. Mean cosine by length quartile: shortest 25% scored 0.322 on-topic,
 * longest 25% only 0.149.
 *
 * Length normalization cannot fix this: it is a DIRECTION problem, not a magnitude one (a
 * centroid does not become pointed by scaling it). The fix is the split the source pipeline
 * already made and shipped (#54: files chunked into per-section retrieval units, file = unit of
 * truth), applied natively — rank by the MAX cosine over a concept's own live observation
 * vectors, then dedupe to one card per concept. Native and source memory now share ONE retrieval
 * architecture: scoreSourceConcepts (below) and scoreNativeConceptsByObservation are the same
 * shape, and the two live side by side here so they cannot drift apart.
 *
 * Concept centroids are RETIRED FROM QUERY RANKING. They are retained for store-time resolution
 * only (resolve-or-create / dedup / merge / graph `related`), which is out of this slice's scope
 * and reads `concepts.embedding` exactly as before.
 */
import { cosine, isZeroVector, jsonToEmb } from "./embedding";
import type { StoragePort } from "./storage";

/**
 * Absolute cosine floor for search()'s NATIVE cards. This is a CARD-EMISSION rule, not a scoring
 * or a fusion-input rule, and the distinction is load-bearing:
 *
 *   - search() applies it: a native row whose best observation scores below the floor yields NO
 *     card. Fewer than `limit` results, possibly zero, is CORRECT — silence beats noise.
 *   - scoreNativeConceptsByObservation does NOT apply it. The scorer is pure measurement; a
 *     caller that needs the true low cosine must be able to see it.
 *   - gather() applies it NOWHERE. Its junk-query silence is already STRUCTURAL — an intent that
 *     seeds nothing returns early on `seedStrength.size === 0` — and withholding a sub-floor
 *     concept's similarity there is actively harmful: fuse() (src/graph.ts:126-134) branches on
 *     `sim > 0`, so a concept missing from `sim` is scored by the pure-graph branch
 *     `beta * activation * prior^priorExp`, which has NO relevance term at all. A lexically- or
 *     entity-seeded concept reaches that branch with activation 1.0 (spread() copies its seeds
 *     straight into its output, src/graph.ts:78), and a healthy fresh concept's ACT-R prior then
 *     scores it ~0.387 — above the median genuine match (gold observation-max p50 0.4023 is
 *     barely clear of it). Floor-filtering gather's `sim` therefore INVERTS the ranking: it
 *     promotes the concepts it was meant to suppress. Measured on this branch before the fix: a
 *     sub-floor concept at cosine 0.10 scored 0.3869 and outranked a genuine 0.25 match.
 *
 * WHY A FLOOR EXISTS AT ALL: ranking by MAX-over-observations gives a concept one lottery ticket
 * per observation, so a big concept can win on noise alone. Per-concept dedupe removes most of
 * that bias (a concept is represented by ONE observation however many it has); the floor removes
 * the rest, by refusing to SHOW a card for a query nothing in the store actually answers. The
 * residual "more observations = more genuine surface area" effect is legitimate relevance mass
 * and is deliberately kept.
 *
 * WHY 0.12 (measured, not guessed — src/eval/scenarios.ts STARTER_SUITE corpus, 20 real probe
 * queries and 9 off-topic junk queries, scored at observation granularity):
 *
 *   MiniLM / Xenova/paraphrase-multilingual-MiniLM-L12-v2 (the SHIPPING semantic embedder)
 *     gold obs-max     min 0.1303   p05 0.2043   median 0.4023
 *     junk obs-max     p50 0.0230   p95 0.1960   p99 0.2654
 *     at 0.12 → 100% of gold kept (8% margin under the worst gold hit), 82.2% of junk candidate
 *     cards suppressed. At 0.15 the worst genuine match (0.1303) would be lost.
 *
 *   HashingEmbeddingProvider (the deterministic lexical embedder CI runs on)
 *     gold obs-max     min 0.1673   p05 0.2309   median 0.3631
 *     at 0.12 → 100% of gold kept (39% margin). Lexical trigram overlap gives every pair of
 *     English texts a high noise baseline (junk p50 0.1963), so the floor is near-inert here —
 *     it must not be raised to "work" in the lexical space, because that is the space where a
 *     genuine match is CHEAPEST to reach, not the one the product ships on.
 *
 * 0.12 also sits just above the off-topic cluster measured on the live store (off-topic quartile
 * means 0.075 and -0.014) and below every on-topic quartile mean (0.322 / 0.149) — it gates
 * noise, and is not a relevance classifier.
 */
export const NATIVE_SCORE_FLOOR = 0.12;

/** The minimum concept shape retrieval scoring reads. engine.ts's ConceptRow satisfies it structurally. */
export interface ScorableConceptRow {
  id: string;
  kind: string;
  embedding: string;
}

/** How a native concept earned its query score: the value, and the observation that produced it. */
export interface NativeObservationMatch {
  /** MAX cosine over this concept's live, non-zero observation vectors. Strictly positive; NOT
   *  floored — NATIVE_SCORE_FLOOR is search()'s emission rule, applied by the caller. */
  score: number;
  /** The single observation that scored `score` — named on the card. Its CONTENT never is. */
  observationId: string;
}

/**
 * THE NATIVE RETRIEVAL ARM. Scores each candidate concept by the MAX cosine over its own LIVE
 * observation vectors and reports WHICH observation won — "observations retrieve, concepts
 * deliver", with the per-concept MAX doing the delivery-side dedupe by construction (one entry
 * per concept id no matter how many of its observations match).
 *
 * PURE MEASUREMENT. The returned map holds every candidate with a STRICTLY POSITIVE best-observation
 * cosine — `score > 0`, exactly the condition gather's `sim`/dense-seed arms applied to the centroid
 * before this split, so the candidate set is unchanged and only its scoring source moved.
 * NATIVE_SCORE_FLOOR is deliberately NOT applied here: it is search()'s card-emission rule (see the
 * constant's own note for why applying it any earlier inverts gather's ranking).
 *
 * LIVE means `superseded_by IS NULL AND superseded_at IS NULL` — the same predicate the rest of
 * the engine uses for an observation's active-ness (see the source active-pointer backfill in
 * engine.ts init()). A superseded observation is history: it must not retrieve.
 *
 * `kind != 'source'` matches enforcedNativeObservationRows (engine.ts) — the selector that defines
 * migrateEmbeddings' native-observations coverage — because a native concept CAN legitimately hold
 * a source-kind observation: the graft path writes the incoming row's `kind` verbatim and then
 * normalizes only its `circle` against the owning native concept (engine.ts, upsertObservation in
 * applyGraft), never its kind. Scoring such a row would read a vector that the native migration
 * phase never rewrites, mixing two embedding spaces in one comparison and breaking the ratified
 * "migration coverage = ALL vectors that scoring reads" invariant. Aligning the two predicates is
 * what keeps that invariant true by construction rather than by luck.
 *
 * ZERO VECTORS are excluded rather than scored as 0 (isZeroVector), matching scoreSourceConcepts:
 * an all-zero embedding is a placeholder, not a measurement, and cosine against it is 0 for every
 * query — which would otherwise let a placeholder define a concept's score.
 *
 * NO CENTROID FALLBACK — deliberate, and the sharp edge of this design. A native concept with no
 * usable live observation vector is simply ABSENT from the returned map: it does not rank in the
 * dense arm at all (invisible to search; still SEEDED in gather by the lexical and entity arms,
 * which read title/body and entity keys rather than any embedding — whether such a seed then
 * survives fusion is fuse()'s own pure-graph decision, which weighs the concept's ACT-R prior and
 * is unchanged by this split). Falling back to `concepts.embedding` would reintroduce
 * the exact blurred-centroid ranking this split exists to remove, on the rows least able to
 * afford it. Source concepts keep THEIR whole-file fallback (scoreSourceConcepts, below) because
 * a source concept's centroid is a file, which is #54's ratified unit of truth — not the same
 * object at all.
 *
 * The candidate ids are bound through `json_each(?)` as ONE JSON-array parameter rather than an
 * `IN (?,?,...)` list whose host-parameter count scales with the candidate count: this build's
 * SQLite accepts at most 32766 bound parameters (measured directly — see scoreSourceConcepts's
 * note), a reachable number for a large store. One query, parameter count exactly 1, regardless
 * of how many concepts are in scope.
 *
 * Ties break on the lexicographically smaller observation id: two observations of one concept can
 * legitimately score identically (duplicate text), and determinism is a hard contract here.
 */
export function scoreNativeConceptsByObservation(
  db: StoragePort,
  conceptIds: readonly string[],
  emb: Float32Array,
): Map<string, NativeObservationMatch> {
  const best = new Map<string, NativeObservationMatch>();
  if (conceptIds.length === 0) return best;
  const rows = db
    .prepare(
      `SELECT o.concept_id AS concept_id, o.id AS observation_id, o.embedding AS embedding
         FROM observations o
        WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
          AND o.kind != 'source'
          AND o.concept_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...conceptIds])) as Array<{ concept_id: string; observation_id: string; embedding: string }>;
  for (const row of rows) {
    const vec = jsonToEmb(row.embedding);
    if (isZeroVector(vec)) continue; // placeholder, not a measurement
    const score = cosine(emb, vec);
    if (score <= 0) continue; // mirrors the pre-split `cos > 0` sim/seed condition exactly
    const prior = best.get(row.concept_id);
    if (prior === undefined || score > prior.score || (score === prior.score && row.observation_id < prior.observationId)) {
      best.set(row.concept_id, { score, observationId: row.observation_id });
    }
  }
  return best;
}

/**
 * Chunk-granular source retrieval (ratified, #54): scores each kind='source' row in `rows` by
 * MAX(whole-file concepts.embedding cosine, every ACTIVE chunk vector's cosine)
 * (source_chunks.lifecycle='active' → observations.embedding — the same join listMemories' own
 * provenance count uses, at `SELECT concept_id, observation_id FROM source_chunks WHERE
 * lifecycle='active' ...`), instead of JUST the single mean-pooled whole-file concepts.embedding
 * every OTHER consumer (dedup, graph, pin sampling) still reads unchanged. A multi-section
 * file's one on-topic chunk no longer gets diluted below the noise floor by every unrelated
 * section sharing that one vector.
 *
 * REVIEW FIX (Codex P2 finding 5): the whole-file cosine is an UNCONDITIONAL candidate in the
 * max now, not an all-or-nothing fallback used only when every chunk vector is zero. The
 * all-zero case (a store synced by an older build, storeSourceChunk used to write an all-zero
 * placeholder always; see its own comment) is the OBVIOUS case that needs it, but a subtler one
 * matters just as much: a file PARTIALLY refreshed by a content-changing sync on an old-build
 * store — the edited section gets a real vector, every UNCHANGED section keeps its zero
 * placeholder (storeSourceChunk only ever writes on an actual content change; see
 * materializeStagedBindings' unchanged-content fast path, source-sync.ts). With the old
 * all-or-nothing fallback, ANY non-zero chunk suppressed it entirely, so a query about one of the
 * still-zero UNCHANGED sections scored against only the unrelated edited chunk — worse than
 * status-quo whole-file scoring, not just no-better. Folding the whole-file cosine into the max
 * unconditionally closes that gap (it's a superset of the old behavior: identical whenever no
 * chunk is non-zero, since the max of one candidate is itself; never worse when a chunk IS
 * non-zero, since max only ever adds a candidate, never removes one).
 *
 * REVIEW FIX (Codex P2 finding 6, revised per reviewer follow-up): the chunk-vector query joins
 * the candidate id list through `json_each(?)` on ONE bound JSON-array parameter — the same
 * param-count-independent shape this codebase already uses for ACL membership checks
 * (authorizedSourceProjections' allowed_caller_ids_json/allowed_project_ids_json EXISTS clauses)
 * — rather than an unbounded `IN (?,?,...)` whose host-parameter count scales with the
 * candidate count. The scanner allows up to 10,000 files per source (maxFiles,
 * source-scanner.ts), and this build's actual ceiling was measured directly: SQLite 3.49.2 here
 * accepts up to 32766 bound parameters and throws "too many SQL variables" at 32767 — a real,
 * reachable number for a large multi-source circle, not a theoretical one. json_each(?) makes
 * this query's parameter count exactly 1 regardless of how many source concepts are in scope.
 *
 * Non-source rows are ignored (absent from the returned map) — they are scored by
 * scoreNativeConceptsByObservation instead (the unit split, above), NOT by the plain centroid
 * cosine this function's callers used for them before that split. search() and gather() both call
 * this with their own candidate set so the two stay consistent.
 *
 * NOTE (unit split, deliberate): source scores are NOT subject to NATIVE_SCORE_FLOOR. The floor
 * is a native-arm decision; #54's source semantics are untouched by this slice.
 */
export function scoreSourceConcepts(
  db: StoragePort,
  rows: readonly ScorableConceptRow[],
  emb: Float32Array,
): Map<string, number> {
  const scores = new Map<string, number>();
  const sourceRows = rows.filter((r) => r.kind === "source");
  if (sourceRows.length === 0) return scores;
  const sourceIds = sourceRows.map((r) => r.id);
  const chunkVectors = db
    .prepare(
      `SELECT sc.concept_id AS concept_id, o.embedding AS embedding
         FROM source_chunks sc JOIN observations o ON o.id = sc.observation_id
        WHERE sc.lifecycle = 'active' AND sc.concept_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(sourceIds)) as Array<{ concept_id: string; embedding: string }>;
  const bestByConceptId = new Map<string, number>();
  for (const chunk of chunkVectors) {
    const vec = jsonToEmb(chunk.embedding);
    if (isZeroVector(vec)) continue; // pre-chunk-embedding placeholder — excluded, not scored as 0
    const cos = cosine(emb, vec);
    const prior = bestByConceptId.get(chunk.concept_id);
    if (prior === undefined || cos > prior) bestByConceptId.set(chunk.concept_id, cos);
  }
  for (const row of sourceRows) {
    const wholeFileCos = cosine(emb, jsonToEmb(row.embedding));
    const bestChunkCos = bestByConceptId.get(row.id);
    scores.set(row.id, bestChunkCos === undefined ? wholeFileCos : Math.max(wholeFileCos, bestChunkCos));
  }
  return scores;
}
