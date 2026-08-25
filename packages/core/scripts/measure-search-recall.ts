/**
 * DOES THE READ SIDE ACTUALLY FIND THINGS? (#155, and the open question in #62.)
 *
 *   MONET_DB=/path/to/backfilled.db npx tsx scripts/measure-search-recall.ts
 *
 * The segment layer changed search ranking through the shared
 * scoreNativeConceptsByObservation that nomination uses — but only the write side was ever measured.
 * The read-side claim so far rests on a pair-level statistic (observation pairs from different
 * concepts clearing tauAttach, 41.5% -> 3.6%), and this issue has already been misled three times by
 * a metric shaped like something other than the decision. So this measures the decision search makes:
 * given a query, does the right concept come back, and at what rank.
 *
 * METHOD. Leave-one-out again, on the live corpus. Each live observation becomes a query for its own
 * content; its own vectors are withheld; every concept in the circle is scored and ranked; the metric
 * is where the observation's HOME concept lands. Recall@1 is the strict version of the question, and
 * MRR is what a reader actually experiences, since a card at rank 3 is still found.
 *
 * TWO QUERY SHAPES, because they are not the same question and #62 is about the second.
 *   full      the whole observation as the query — "is this content reachable at all"
 *   opening   its first sentence — short and topic-like, the shape a real recall query has. #62's
 *             complaint was precisely that short queries about same-day content returned nothing.
 *
 * THREE INDEXES, same store and same queries so only the ranking input differs.
 *   whole     observations.embedding — one vector per observation, the pre-#155 behavior
 *   segment   observation_segments — what ships now
 *   segment+lexical   segments re-ordered by the lexical arm, which currently applies ONLY to
 *             nomination. Measured here so the decision to extend it to search is evidence-backed
 *             rather than assumed: wiring it in blind regressed three eval gates once already.
 *
 * "Home concept" is a proxy for relevance, and a pessimistic one on a corpus with genuine
 * near-duplicates. It is identical across all three variants, so the COMPARISON is sound even where
 * the absolute level is understated.
 */
import Database from "better-sqlite3";
import { cosine, isZeroVector, jsonToEmb, type EmbeddingProvider } from "../src/embedding";
import { blendLexical, lexicalOverlap, lexicalTokens, tokenIdf } from "../src/lexical-overlap";
import { printEmbedderHeader, printStoreHeader, requireTrustableSpace } from "./measure-header";

const DB = process.env.MONET_DB!;
const db = new Database(DB, { readonly: true });
const storeSpace = printStoreHeader(db, DB);
// UNCONDITIONAL, INCLUDING THE MODEL PATH — same reason as measure-observation-recall.ts. The swap
// loop rewrites every `whole`/`segs` VALUE, but `observations` above was already filtered to rows
// holding a nonzero stored whole vector AND at least one stored segment, and the swap iterates that
// filtered list. Membership is stored state. On a store whose official migration was interrupted,
// the migrated rows have had their segments deleted (engine.ts, migrateEmbeddings) and would be
// silently excluded, turning a "replaces everything" run into a measurement of whatever the
// migration had not yet reached. Refuse instead.
requireTrustableSpace(storeSpace);
const circle = (db.prepare(
  `SELECT circle, COUNT(*) n FROM concepts WHERE kind!='source' GROUP BY circle ORDER BY n DESC LIMIT 1`,
).get() as { circle: string }).circle;

const obsRows = db.prepare(
  `SELECT o.id AS oid, o.concept_id AS cid, o.content AS content, o.embedding AS emb
     FROM observations o JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.circle = ?`,
).all(circle) as Array<{ oid: string; cid: string; content: string; emb: string }>;

const segRows = db.prepare(
  `SELECT s.observation_id AS oid, s.embedding AS emb, s.content AS content FROM observation_segments s
     JOIN observations o ON o.id = s.observation_id
     JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.circle = ?`,
).all(circle) as Array<{ oid: string; emb: string; content: string }>;
db.close();

const segTextByObs = new Map<string, string[]>();
for (const r of segRows) segTextByObs.set(r.oid, [...(segTextByObs.get(r.oid) ?? []), r.content]);

interface Obs { oid: string; cid: string; content: string; whole: Float32Array | null; segs: Float32Array[]; toks: Set<string> }
const byObs = new Map<string, Obs>();
for (const r of obsRows) {
  const whole = jsonToEmb(r.emb);
  byObs.set(r.oid, {
    oid: r.oid, cid: r.cid, content: r.content,
    whole: isZeroVector(whole) ? null : whole,
    segs: [], toks: lexicalTokens(r.content),
  });
}
for (const r of segRows) {
  const v = jsonToEmb(r.emb);
  if (!isZeroVector(v)) byObs.get(r.oid)?.segs.push(v);
}
const observations = [...byObs.values()].filter((o) => o.whole !== null && o.segs.length > 0);
const byConcept = new Map<string, Obs[]>();
for (const o of observations) byConcept.set(o.cid, [...(byConcept.get(o.cid) ?? []), o]);

const df = new Map<string, number>();
for (const members of byConcept.values()) {
  const seen = new Set<string>();
  for (const m of members) for (const t of m.toks) seen.add(t);
  for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
}
const idfOf = (t: string): number => tokenIdf(byConcept.size, df.get(t) ?? 0);

/** First sentence, capped — the shape of a real recall query rather than a whole document. */
const opening = (text: string): string => {
  const cut = text.trim().split(/(?<=[.!?])\s+|\n/u)[0] ?? text;
  return cut.slice(0, 220);
};

const VARIANTS = ["whole", "segment", "segment+lexical"] as const;
type Variant = (typeof VARIANTS)[number];
interface Tally { r1: number; r5: number; r10: number; mrr: number; n: number }
const blank = (): Tally => ({ r1: 0, r5: 0, r10: 0, mrr: 0, n: 0 });
let swapped: EmbeddingProvider | null = null;

async function run(label: string, queryOf: (o: Obs) => Promise<Float32Array>, queryText: (o: Obs) => string): Promise<void> {
  const tallies = new Map<Variant, Tally>(VARIANTS.map((v) => [v, blank()]));
  for (const probe of observations) {
    if ((byConcept.get(probe.cid) ?? []).length < 2) continue; // home would be empty once withheld
    const qv = await queryOf(probe);
    const qToks = lexicalTokens(queryText(probe));
    const scores = new Map<Variant, Array<{ cid: string; s: number }>>(VARIANTS.map((v) => [v, []]));

    for (const [cid, members] of byConcept) {
      let bestWhole = -Infinity, bestSeg = -Infinity, bestOverlap = 0;
      for (const other of members) {
        if (other.oid === probe.oid) continue; // withheld
        const w = cosine(qv, other.whole!);
        if (w > bestWhole) bestWhole = w;
        for (const sv of other.segs) { const c = cosine(qv, sv); if (c > bestSeg) bestSeg = c; }
        const o = lexicalOverlap(qToks, other.toks, idfOf);
        if (o > bestOverlap) bestOverlap = o;
      }
      if (bestWhole === -Infinity) continue;
      scores.get("whole")!.push({ cid, s: bestWhole });
      scores.get("segment")!.push({ cid, s: bestSeg });
      scores.get("segment+lexical")!.push({ cid, s: blendLexical(bestSeg, bestOverlap) });
    }

    for (const v of VARIANTS) {
      const ranked = scores.get(v)!.sort((a, b) => b.s - a.s || (a.cid < b.cid ? -1 : 1));
      const rank = ranked.findIndex((x) => x.cid === probe.cid) + 1;
      const t = tallies.get(v)!;
      t.n++;
      if (rank === 1) t.r1++;
      if (rank >= 1 && rank <= 5) t.r5++;
      if (rank >= 1 && rank <= 10) t.r10++;
      if (rank >= 1) t.mrr += 1 / rank;
    }
  }
  console.log(`\n  QUERY SHAPE: ${label}`);
  console.log(`  index              R@1     R@5    R@10     MRR`);
  for (const v of VARIANTS) {
    const t = tallies.get(v)!;
    const pct = (x: number) => `${((x / t.n) * 100).toFixed(1)}%`.padStart(6);
    console.log(`  ${v.padEnd(17)} ${pct(t.r1)}  ${pct(t.r5)}  ${pct(t.r10)}  ${(t.mrr / t.n).toFixed(4)}`);
  }
}

async function main(): Promise<void> {
  console.log(`circle=${circle}   ${observations.length} observations / ${byConcept.size} concepts`);
  /*
   * MODEL=<hub id> re-embeds the corpus before measuring. The concept-level layers are where the
   * headroom is — filing and search still miss a third to a half of the time, against a fundamental
   * layer already at 90% — so "would a better embedder help?" has to be asked HERE, not only on the
   * layer that is nearly saturated.
   */
  const swapModel = process.env.MODEL;
  if (swapModel !== undefined) {
    const { OnnxEmbeddingProvider: Swap } = await import("../src/embedding-onnx");
    const alt: EmbeddingProvider = new Swap({ model: swapModel });
    // Kept for its LENGTH: MODEL names an arbitrary checkpoint and `alt.dim` may be the 384 fallback.
    const warmup = await alt.embed("warmup");
    // The loop directly below rewrites `whole` and `segs` for every observation, so no stored vector
    // survives into the scoring — a candidate-model run, not a cross-space comparison.
    printEmbedderHeader(storeSpace, alt, "replaces-stored-vectors", warmup.length);
    console.log(`re-embedding with ${swapModel}...`);
    for (const o of observations) {
      o.whole = await alt.embed(o.content);
      o.segs = [];
      for (const s of segTextByObs.get(o.oid) ?? [o.content]) o.segs.push(await alt.embed(s));
    }
    swapped = alt;
  }
  // The stored observation vector IS the embedding of the full content, so the "full" shape needs no
  // model at all — the same vector search would compute for that query text.
  await run("full observation", async (o) => o.whole!, (o) => o.content);

  const { OnnxEmbeddingProvider } = await import("../src/embedding-onnx");
  const onnx: EmbeddingProvider = swapped ?? new OnnxEmbeddingProvider();
  // Loaded here rather than at startup — the "full observation" shape above needs no model at all —
  // so the space it embeds cues in is reported here, at the point it becomes real. Reached only when
  // no swap happened, which means every candidate below is still a STORED vector.
  if (swapped === null) {
    const warmup = await onnx.embed("warmup");
    printEmbedderHeader(storeSpace, onnx, "against-stored-vectors", warmup.length);
  }
  const cache = new Map<string, Float32Array>();
  await run("opening sentence", async (o) => {
    const text = opening(o.content);
    let v = cache.get(text);
    if (v === undefined) { v = await onnx.embed(text); cache.set(text, v); }
    return v;
  }, (o) => opening(o.content));

  console.log(`\n  R@1 is the strict question; MRR is what a reader experiences, since a card at rank 3`);
  console.log(`  is still found. "Home concept" is identical across variants, so the comparison holds`);
  console.log(`  even where the absolute level is understated by genuine near-duplicates.`);
}
void main();
