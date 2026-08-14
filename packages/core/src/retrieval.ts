/**
 * Retrieval scoring — the query-ranking arms for search(), extracted from the
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
import { blendLexical, lexicalOverlap, lexicalTokens, tokenIdf } from "./lexical-overlap";
import type { StoragePort } from "./storage";

/**
 * Absolute cosine floor for search()'s NATIVE cards. This is a CARD-EMISSION rule, not a scoring
 * rule, and the distinction is load-bearing:
 *
 *   - search() applies it: a native row whose best observation scores below the floor yields NO
 *     card. Fewer than `limit` results, possibly zero, is CORRECT — silence beats noise.
 *   - scoreNativeConceptsByObservation does NOT apply it. The scorer is pure measurement; a
 *     caller that needs the true low cosine must be able to see it.
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

/**
 * The card-emission floor to actually use, given what a provider declared.
 *
 * The floor is an ABSOLUTE cosine, so where it belongs is a fact about a space — the same reason
 * recommendedThresholds and reliableSegmentTokens travel. 0.12 was chosen on multilingual-MiniLM,
 * whose junk obs-max p50 was 0.023. bge-small-en-v1.5 puts junk at p50 0.397, so 0.12 sits below its
 * entire noise distribution and suppresses 0.0% of junk cards — the constant is not merely mistuned
 * there, it is unreachable.
 *
 * Honoured only when finite and within [0, 1): a cosine floor outside that cannot gate anything, and
 * a NaN would compare false against every score and silently disable emission filtering entirely.
 */
export function nativeScoreFloorOf(declared: number | undefined): number {
  return typeof declared === "number" && Number.isFinite(declared) && declared >= 0 && declared < 1
    ? declared
    : NATIVE_SCORE_FLOOR;
}

/** The minimum concept shape retrieval scoring reads. engine.ts's ConceptRow satisfies it structurally. */
export interface ScorableConceptRow {
  id: string;
  kind: string;
  embedding: string;
}

/** How a native concept earned its query score: the value, and the observation that produced it. */
export interface NativeObservationMatch {
  /**
   * THE RANKING KEY, and the only thing the lexical arm moves (#155).
   *
   * `score` above is the raw cosine and stays the raw cosine, because it is what tauAttach/
   * tauAmbiguous and NATIVE_SCORE_FLOOR are compared against. The lexical measurement justified
   * re-ORDERING candidates — argmax accuracy 46.3% -> 67.1% — and said nothing whatever about where
   * a band boundary belongs. Letting the blend inflate `score` would have silently loosened every
   * threshold that reads it by up to the boost factor, which is a threshold change with no evidence
   * behind it and exactly the carry-a-constant-across-a-scale-change mistake this issue documents.
   *
   * So: argmax on `rank`; compare `score`. Equal to `score` when no lexical evidence applies.
   *
   * BOTH ARMS READ `rank`, and whether the lexical component contributes at all is a property of the
   * EMBEDDER (EmbeddingProvider.needsLexicalArm). With it off, `rank` is a copy of `score`, so a
   * lexical-embedder store ranks exactly as it did before #155 — which is why the eval gates that
   * run on HashingEmbeddingProvider stay byte-identical while the shipping semantic model gets the
   * arm. Measured on the live corpus: read-side R rises 33.6% -> 56.0% on short queries and
   * 28.8% -> 56.4% on long ones, and nomination 46.3% -> 67.1%.
   */
  rank: number;
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
 * cosine — `score > 0`. NATIVE_SCORE_FLOOR is deliberately NOT applied here: it is search()'s
 * card-emission rule, so the scorer remains usable anywhere true low-cosine measurements matter.
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
 * usable live observation vector is simply ABSENT from the returned map and invisible to search.
 * Falling back to `concepts.embedding` would reintroduce
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
 *
 * SEGMENT GRANULARITY (#155). The vectors scored here are an
 * observation's SEGMENTS, not the observation as a whole: the same unit split applied one level down,
 * because an observation is too big to be a retrieval unit. Measured on the live store, whole-
 * observation scoring let pairs from DIFFERENT concepts clear tauAttach 41.5% of the time and held
 * clean-label separability to AUC 0.7782; at segment granularity that becomes 0.2% and 0.9119. The
 * per-concept MAX still does the delivery-side dedupe by construction — one entry per concept id
 * however many segments or observations match — so this function's contract is unchanged and only
 * the granularity of its evidence moved.
 *
 * LIVENESS IS INHERITED, NOT MIRRORED: segments carry no lifecycle of their own, so the join applies
 * the observation's own `superseded_by IS NULL AND superseded_at IS NULL` predicate in this one
 * place. A segment that could be live while its observation is not would be a second truth about
 * what exists.
 *
 * THE UNION ALL ARM IS A TRANSITIONAL FALLBACK, not a permanent one. Every accepted write now creates
 * its segments in the same transaction, so only rows written BEFORE the backfill lack them — and for
 * those, scoring the observation's own vector is exactly the pre-#155 behavior, i.e. never worse than
 * status quo. Omitting the arm instead would make un-backfilled observations silently unfindable, the
 * loudest possible version of the defect this change exists to remove. The `NOT EXISTS` probe is
 * keyed on `observation_segments`' own PRIMARY KEY (observation_id, segment_index), so it is an index
 * seek per row rather than the unindexed correlated scan that wedged the store in #145.
 */
export function scoreNativeConceptsByObservation(
  db: StoragePort,
  conceptIds: readonly string[],
  emb: Float32Array,
  queryText: string,
  applyLexical: boolean,
): Map<string, NativeObservationMatch> {
  const best = new Map<string, NativeObservationMatch>();
  if (conceptIds.length === 0) return best;
  const rows = db
    .prepare(
      `SELECT o.concept_id AS concept_id, o.id AS observation_id, s.embedding AS embedding
         FROM observation_segments s
         JOIN observations o ON o.id = s.observation_id
        WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
          AND o.kind != 'source'
          AND o.concept_id IN (SELECT value FROM json_each(?))
       UNION ALL
       SELECT o.concept_id AS concept_id, o.id AS observation_id, o.embedding AS embedding
         FROM observations o
        WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
          AND o.kind != 'source'
          AND o.concept_id IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (SELECT 1 FROM observation_segments s2 WHERE s2.observation_id = o.id)`,
    )
    .all(JSON.stringify([...conceptIds]), JSON.stringify([...conceptIds])) as Array<{ concept_id: string; observation_id: string; embedding: string }>;
  for (const row of rows) {
    const vec = jsonToEmb(row.embedding);
    if (isZeroVector(vec)) continue; // placeholder, not a measurement
    const score = cosine(emb, vec);
    if (score <= 0) continue; // mirrors the pre-split `cos > 0` sim/seed condition exactly
    const prior = best.get(row.concept_id);
    if (prior === undefined || score > prior.score || (score === prior.score && row.observation_id < prior.observationId)) {
      best.set(row.concept_id, { score, rank: score, observationId: row.observation_id });
    }
  }
  if (applyLexical) applyLexicalArm(db, conceptIds, queryText, best);
  return best;
}

/**
 * THE LEXICAL ARM (#155). Re-orders the candidates the dense arm already scored, by how much of the
 * incoming text's discriminative vocabulary each concept already contains. See src/lexical-overlap.ts
 * for why this exists, why it is lexical rather than entity-based, and why the blend is multiplicative
 * and modest.
 *
 * IT NEVER ADDS A CANDIDATE. Only concepts with a strictly positive best-observation cosine are in
 * `best` by the time this runs, and this function only rescales them — so the candidate set is
 * exactly what the dense arm admitted, and a concept the embedding rejected cannot be talked into
 * the results by vocabulary alone. That also keeps NATIVE_SCORE_FLOOR meaningful: the floor still
 * gates on a value derived from a real cosine.
 *
 * WHICH OBSERVATION IS NAMED is deliberately left alone. `observationId` still points at the segment's
 * observation that won the DENSE comparison — the lexical arm is a property of the whole concept, not
 * of any one observation, so letting it change the attribution would name a row that did not earn it.
 *
 * DOCUMENT FREQUENCY IS COUNTED OVER THE CANDIDATE CONCEPTS, which is the population the ranking is
 * actually deciding among. Counting over the whole store would let concepts outside this circle — or
 * outside this call's scope — shift weights inside it.
 */
function applyLexicalArm(
  db: StoragePort,
  conceptIds: readonly string[],
  queryText: string,
  best: Map<string, NativeObservationMatch>,
): void {
  if (best.size === 0) return;
  const probeTokens = lexicalTokens(queryText);
  if (probeTokens.size === 0) return; // nothing discriminative arrived; leave the dense ranking alone
  const rows = db
    .prepare(
      `SELECT o.concept_id AS concept_id, t.observation_id AS observation_id, t.token AS token
         FROM observation_tokens t
         JOIN observations o ON o.id = t.observation_id
        WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
          AND o.kind != 'source'
          AND t.token IN (SELECT value FROM json_each(?))
          AND o.concept_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...probeTokens]), JSON.stringify([...conceptIds])) as
    Array<{ concept_id: string; observation_id: string; token: string }>;

  /*
   * OVERLAP IS MAX OVER THE CONCEPT'S OBSERVATIONS, never over their union — the same unit rule the
   * dense arm follows, and for the same reason. A concept's UNION of tokens grows with its size, so a
   * 135-observation concept contains nearly every term in the corpus and scores an overlap near 1.0
   * against anything at all. Measured, that is not theoretical: with union overlap, concepts of 2-4
   * observations lost 71.9% of their own evidence to a 20+ concept and returned home 21.6% of the
   * time; scored per observation instead, those become 32.3% and 40.7%, and overall argmax accuracy
   * goes 59.1% -> 67.1%. Union overlap reintroduced, inside the fix, exactly the size bias this issue
   * exists to remove.
   */
  const tokensByObservation = new Map<string, { conceptId: string; tokens: Set<string> }>();
  const conceptsPerToken = new Map<string, Set<string>>();
  for (const row of rows) {
    const entry = tokensByObservation.get(row.observation_id) ?? { conceptId: row.concept_id, tokens: new Set<string>() };
    entry.tokens.add(row.token);
    tokensByObservation.set(row.observation_id, entry);
    const concepts = conceptsPerToken.get(row.token) ?? new Set<string>();
    concepts.add(row.concept_id);
    conceptsPerToken.set(row.token, concepts);
  }
  // Document frequency counts CONCEPTS, not observations: a term repeated across one concept's many
  // observations must not look rare, which is what an observation-level count would make it.
  const idfOf = (token: string): number => tokenIdf(conceptIds.length, conceptsPerToken.get(token)?.size ?? 0);

  const bestOverlap = new Map<string, number>();
  for (const { conceptId, tokens } of tokensByObservation.values()) {
    const overlap = lexicalOverlap(probeTokens, tokens, idfOf);
    if (overlap > (bestOverlap.get(conceptId) ?? 0)) bestOverlap.set(conceptId, overlap);
  }

  for (const [conceptId, match] of best) {
    const overlap = bestOverlap.get(conceptId) ?? 0;
    best.set(conceptId, { score: match.score, rank: blendLexical(match.score, overlap), observationId: match.observationId });
  }
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
 * cosine this function's callers used for them before that split. search() calls this with its
 * authorized source candidate set.
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
