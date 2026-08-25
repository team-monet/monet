/**
 * THE LEXICAL ARM of native retrieval (#155) — the pure half.
 *
 * WHY A SECOND SIGNAL AT ALL. Nomination and search both reduce to top-1/top-k over every concept in
 * a circle, and on the live corpus one embedding space cannot make that choice: measured by
 * leave-one-out replay over 275 concepts, max-cosine returns an observation to its own concept 46.3%
 * of the time. Raising or lowering tauAttach does not move it (46-49% across 0.50-0.75), and neither
 * does removing the over-absorbed concepts (46.7% with blobs excluded from both sides). The signal,
 * not the threshold and not the corpus, is the binding constraint.
 *
 * WHY LEXICAL AND NOT ENTITIES. `concept_entities` was the expected answer — it already exists and is
 * densely populated (53,793 entities over 630 concepts). Measured on the same replay it scores 21.1%,
 * WORSE than cosine alone, and 47.5% in combination: those entities are spread too evenly to separate
 * anything. Plain IDF-weighted token overlap scores 53.2% by itself — beating the embedding — and
 * cosine × (1 + 0.5 × lexical) scores 59.1% when overlap is taken against a concept's token union, and 67.1% when it is taken per observation and maxed — the unit rule this file's lexicalOverlap note explains.
 *
 * THE BLEND WEIGHT IS DELIBERATELY MODEST AND DELIBERATELY NOT PRESENTED AS TUNED. 0.5 measured
 * 59.1% and 1.0 measured 57.5% across 739 replays, a gap inside the ~1.8pt standard error, so the
 * sweep resolves the SHAPE and not the number: a modest boost on top of cosine wins, while
 * lexical-dominant (54.0%) and evenly-weighted (55.5%) blends both score lower. Anyone changing it
 * should re-run scripts/measure-nomination-signals.ts on the corpus it will govern rather than
 * treating this constant as optimal.
 *
 * DOCUMENT FREQUENCY IS COUNTED OVER CONCEPTS, NOT OBSERVATIONS. A term every concept mentions must
 * not be able to decide anything, and on a single-project store that describes most of the domain
 * vocabulary — "monet", "store", "concept". Counting over observations would let a term that appears
 * many times inside ONE concept look rare, which is exactly backwards for a signal whose whole job is
 * to tell concepts apart.
 *
 * PURE: no db handle, no clock. The SQL that feeds it lives in retrieval.ts.
 */

/**
 * Words worth matching on. Three characters minimum after the first, which drops the articles and
 * operators that carry no discriminative load, and keeps identifiers (`tauAttach`, `source_chunks`)
 * whole — those are the highest-signal tokens in a technical corpus and splitting them on case or
 * underscore would scatter exactly the evidence this arm exists to catch.
 */
const TOKEN = /[a-z0-9][a-z0-9_-]{2,}/gu;

/**
 * The share of a text's letters and digits that `TOKEN` above actually consumes — "how much of this
 * can the lexical arm read", answered by the tokenizer itself.
 *
 * WHY NOT nonLatinLetterShare (Codex P1, PR #87 round 4). That function detects SCRIPT, and says so
 * in its own header: French, Vietnamese and Turkish score 0 there and are still largely invisible to
 * TOKEN, whose class is `[a-z0-9_-]`. Anything accented is dropped or fragmented. Using the script
 * guard to decide lexical comparability answered a neighbouring question — the third time this
 * branch reached for an adjacent quantity, which is why the measure now lives beside the regex it
 * measures rather than being borrowed from a module that documents its own unsuitability.
 */
/**
 * Below this share of a text readable by TOKEN, a rank gap is not the quantity a lexically-blended
 * threshold was calibrated against, and any such threshold must stand down (see tauMargin).
 *
 * MEASURED, NOT PICKED. On the corpus tauMargin was derived from — monet-hq, n=1011 live
 * observations, in the `Xenova/bge-small-en-v1.5` 384-dim space that store held BEFORE its
 * 2026-08-24 migration to bge-m3 (naming the space, not just the corpus, is the point: see the
 * LEXICAL_BOOST block below for what a corpus-only label cost) — coverage runs min 0.845, p01
 * 0.902, p05 0.920, p50 0.955 — so every observation that produced the threshold clears this bar
 * with room. The cases it has to exclude sit far below:
 * Korean scores 0.000, Korean carrying an ASCII identifier 0.200, and accented French 0.571. The
 * band between 0.571 and 0.845 is empty on both sides, and this sits inside it.
 *
 * That emptiness is why the value is a floor rather than a tuned point: anywhere in that band admits
 * 100% of the derivation population and refuses all three contrast cases, so nothing here is being
 * traded off. Re-measure it on any corpus this threshold is re-derived against.
 */
export const LEXICAL_COVERAGE_MIN = 0.8;

export function lexicalCoverage(text: string): number {
  const lower = text.toLowerCase();
  const alnum = lower.match(/[\p{L}\p{N}]/gu);
  if (alnum === null || alnum.length === 0) return 1; // nothing to read: vacuously comparable
  // COUNTED THE SAME WAY ON BOTH SIDES (Codex P2, PR #87 round 5). `m[0].length` includes the `-`
  // and `_` a token may carry, while the denominator counts letters and digits only — so a token
  // like `api____________________` reported more covered characters than it has readable ones and
  // could push a mostly-CJK probe to full coverage on three ASCII letters. The numerator now counts
  // what the denominator counts.
  let covered = 0;
  for (const m of lower.matchAll(TOKEN)) covered += (m[0].match(/[\p{L}\p{N}]/gu) ?? []).length;
  return Math.min(1, covered / alnum.length);
}

/** The token set of one text. A SET, not a bag: this measures whether a term is shared, not how
 *  often it is repeated, so a long observation cannot outscore a short one by restating itself. */
export function lexicalTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(TOKEN) ?? []);
}

/**
 * Inverse document frequency of one token, given how many of `conceptCount` concepts contain it.
 *
 * `1 + df` in the denominator so a token present in every concept still yields a positive weight
 * rather than a zero or a negative one — a token cannot be made to count AGAINST a concept, which is
 * what a raw log(N/df) would do once df exceeds N.
 */
export function tokenIdf(conceptCount: number, df: number): number {
  // CLAMPED AT ZERO (Codex P2, PR #156). The `1 + df` denominator was supposed to keep a ubiquitous
  // token from counting AGAINST a concept, and it does not: at df === conceptCount the log goes
  // negative, so a term every candidate shares would subtract weight, `lexicalOverlap` could fall
  // below zero, and a boosted rank could then sort UNDER an unboosted one. A term shared by
  // everything must be NEUTRAL, which is exactly zero and never less.
  return Math.max(0, Math.log(conceptCount / (1 + df)));
}

/**
 * How much of the incoming text's discriminative mass this concept accounts for: the IDF-weighted
 * fraction of the probe's own tokens that the concept also contains.
 *
 * APPLIED PER OBSERVATION, NEVER OVER A CONCEPT'S UNION — see the caller in retrieval.ts. A union
 * grows with concept size until a large concept contains nearly every term and overlaps everything at
 * ~1.0; measured, that cost small concepts 71.9% of their own evidence. Scored per observation and
 * maxed, the same corpus goes 59.1% -> 67.1% argmax accuracy.
 *
 * NORMALIZED BY THE PROBE, NOT BY THE UNION. A concept holding a hundred observations contains more
 * tokens than one holding two, and a Jaccard-style union denominator would penalise it for its size
 * regardless of relevance — reintroducing a size bias in the opposite direction to the one #155
 * started from. The question this answers is "how much of what arrived does this concept already
 * know", which is the question resolution is actually asking.
 *
 * Returns 0 when the probe carries no weighted tokens at all, so an empty or stopword-only text
 * contributes nothing rather than dividing by zero.
 */
export function lexicalOverlap(
  probeTokens: ReadonlySet<string>,
  conceptTokens: ReadonlySet<string>,
  idfOf: (token: string) => number,
): number {
  let matched = 0;
  let total = 0;
  for (const token of probeTokens) {
    const weight = idfOf(token);
    total += weight;
    if (conceptTokens.has(token)) matched += weight;
  }
  return total <= 0 ? 0 : matched / total;
}

/**
 * The blend: cosine, boosted by how much of the incoming text the concept already contains.
 *
 * MULTIPLICATIVE, NOT ADDITIVE, and that is measured rather than preferred. An additive blend
 * (0.5·cos + 0.5·lex) scores 59.4% against this form, because addition lets a concept with strong
 * vocabulary overlap and no semantic relationship win outright, while multiplication keeps cosine as
 * the floor of the decision and lets the lexical arm only re-order candidates that already have
 * semantic support. A concept the embedding rejects cannot be talked into winning by vocabulary.
 *
 * THE WEIGHT 1.0 HOLDS IN EVERY SPACE IT HAS BEEN MEASURED IN; THE SHAPE AROUND IT VARIES BY
 * SPACE — A PLATEAU'S START, A PEAK, OR A FLAT REGION'S TOP EDGE (all four runs below).
 * Measured at the shipped observation-unit overlap, argmax accuracy ran 0.5 -> 67.1%,
 * 1.0 -> 72.1%, 2.0 -> 72.7%, 4.0 -> 73.2% on the then-current embedder, and 72.8 / 73.9 / 74.2 /
 * 73.3 on bge-small-en — one plateau from 1.0 upward, inside the ~1.8pt standard error at n=739.
 * (This heading read "AND IS A PEAK ON THE ONE THAT SHIPS" until 2026-08-25; the run it rested on
 * turned out to be a bge-small run wearing a bge-m3 label. See the next paragraph.)
 *
 * TWO RUNS, TWO SPACES — AND THE FIRST ONE WAS MISLABELLED. This block used to report the
 * 2026-08-23 run as "RE-MEASURED ON bge-m3 (the shipping embedder)". It was not. That run reads
 * whatever vectors the DB it is pointed at holds (scripts/measure-nomination-signals.ts imports no
 * embedder), and monet-hq did not migrate to bge-m3 until 2026-08-24 09:51 UTC. Pointing the same
 * script at the pre-migration snapshot reproduces every figure to the decimal, which is what
 * settles it. Both runs, each against the space it actually read:
 *
 *   bge-small-en-v1.5, 384-dim, pre-migration monet-hq, 2026-08-23, n=788
 *     0 -> 66.0%, 0.25 -> 71.6%, 0.5 -> 72.8%, 1.0 -> 73.9%, 2.0 -> 72.8%, 4.0 -> 72.1%
 *   bge-m3:cls:q8, 1024-dim, post-migration monet-hq, 2026-08-25, n=788 (the space that SHIPS)
 *     0 -> 72.0%, 0.25 -> 75.6%, 0.35 -> 76.3%, 0.5 -> 76.3%, 1.0 -> 76.3%, 2.0 -> 75.8%,
 *     4.0 -> 75.1%
 *
 * The conclusion drawn from the mislabelled run — "there is no plateau in this space, accuracy
 * falls monotonically above 1.0, so 1.0 is the PEAK rather than a conservative point on a flat
 * region" — is TRUE OF bge-small AND FALSE OF bge-m3, and is retired as a statement about the
 * shipping space. In bge-m3, 0.35, 0.5 and 1.0 all tie at 76.3%: a genuine flat region, with 1.0
 * at its TOP edge. So 1.0 stands under both readings — the conservative-point argument that
 * originally chose it holds again in the space that ships, and there is still no measurement above
 * 1.0 that argues for raising it (2.0 and 4.0 fall in both spaces).
 *
 * The zero point was never measured before 2026-08-23: the lexical arm is worth +62 observations
 * (66.0% -> 73.9%) on bge-small and +34 (72.0% -> 76.3%) on bge-m3, and is net positive in every
 * home-concept size bin, so it earns its place in both — 21.8% of the residual misfiles at 1.0 are
 * won on a LOWER raw cosine, and that is the price of the gain rather than a defect to remove.
 *
 * An earlier draft of this file claimed 0.5 was optimal and that higher weights scored worse. That
 * came from measuring overlap against a concept's token UNION, whose size bias inverted the ordering.
 * At the unit this code actually uses, the ordering is the other way around.
 */
export const LEXICAL_BOOST = 1.0;

export function blendLexical(cosineScore: number, overlap: number): number {
  return cosineScore * (1 + LEXICAL_BOOST * overlap);
}
