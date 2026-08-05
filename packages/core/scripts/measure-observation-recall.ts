/**
 * THE FUNDAMENTAL QUESTION, stripped of everything downstream (#155).
 *
 *   MONET_DB=/path/to/backfilled.db npx tsx scripts/measure-observation-recall.ts
 *
 * Every other measurement on this issue asks "did the right CONCEPT come back", which silently
 * assumes the store's concept assignment is correct — the very thing under suspicion. Filing errors
 * and retrieval errors are then the same errors counted twice, and no amount of scorer work can tell
 * them apart.
 *
 * This asks the question that does not depend on filing at all: GIVEN A CUE FROM SOMETHING WE
 * STORED, DOES THAT EXACT OBSERVATION COME BACK? Nothing about concepts, nothing about how a model
 * would use the result. If this fails, every measurement above it is meaningless.
 *
 * THE CUE is the observation's opening sentence, capped — a partial, realistic recall cue rather
 * than a copy of the text. Nothing is withheld: the target observation is in the candidate set,
 * because "can we find what we stored" is precisely the question. With 920 observations mapped into
 * one saturated embedding region this is not the giveaway it sounds like — the pre-#155 index gets
 * it wrong most of the time.
 *
 * Reported at both granularities the store actually has:
 *   OBSERVATION  rank of the target observation among all observations
 *   SEGMENT      rank of any segment OF that observation among all segments — the unit ranking
 *                really happens at, before the per-observation and per-concept dedupes
 */
import Database from "better-sqlite3";
import { cosine, isZeroVector, jsonToEmb, type EmbeddingProvider } from "../src/embedding";
import { blendLexical, lexicalOverlap, lexicalTokens, tokenIdf } from "../src/lexical-overlap";

const DB = process.env.MONET_DB!;
const db = new Database(DB, { readonly: true });
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

interface Obs { oid: string; content: string; whole: Float32Array | null; segs: Float32Array[]; toks: Set<string> }
const byObs = new Map<string, Obs>();
for (const r of obsRows) {
  const w = jsonToEmb(r.emb);
  byObs.set(r.oid, { oid: r.oid, content: r.content, whole: isZeroVector(w) ? null : w, segs: [], toks: lexicalTokens(r.content) });
}
for (const r of segRows) {
  const v = jsonToEmb(r.emb);
  if (!isZeroVector(v)) byObs.get(r.oid)?.segs.push(v);
}
const observations = [...byObs.values()].filter((o) => o.whole !== null && o.segs.length > 0);

// Document frequency over OBSERVATIONS here, not concepts: this measurement has no concept layer, and
// the population being told apart is the observations themselves.
const df = new Map<string, number>();
for (const o of observations) for (const t of o.toks) df.set(t, (df.get(t) ?? 0) + 1);
const idfOf = (t: string): number => tokenIdf(observations.length, df.get(t) ?? 0);

/**
 * CUE=opening (default) takes the first sentence; CUE=tail takes the LAST substantial one.
 *
 * The tail is the measurement that can actually see what the segment layer exists for. An
 * observation longer than the model's 512-token window has its end DISCARDED from the whole-document
 * vector — silently, with no error anywhere — so a cue drawn from the opening can never reveal the
 * loss, and every earlier run on this issue used an opening cue. Only segments give late text a
 * vector of its own. Broken out by length below, because the effect can only exist where the text
 * actually overflows the window.
 */
const CUE_MODE = process.env.CUE ?? "opening";
const cue = (text: string): string => {
  const parts = text.trim().split(/(?<=[.!?])\s+|\n/u).filter((s) => s.trim().length >= 40);
  if (parts.length === 0) return text.slice(0, 220);
  return (CUE_MODE === "tail" ? parts[parts.length - 1] : parts[0]).slice(0, 220);
};
/** Past roughly this many characters the tail of an observation is outside a 512-token window. */
const LONG_CHARS = 2000;

const VARIANTS = ["whole", "segment", "segment+lexical"] as const;
type Variant = (typeof VARIANTS)[number];
interface Tally { r1: number; r5: number; r10: number; mrr: number; n: number }

async function main(): Promise<void> {
  const { OnnxEmbeddingProvider } = await import("../src/embedding-onnx");
  /*
   * MODEL=<hub id or local path> re-embeds the corpus with a DIFFERENT model before measuring, which
   * is how "is the embedder the ceiling?" gets an answer instead of an opinion. Stored vectors come
   * from the pinned model, so a fair comparison recomputes BOTH sides in the candidate space — every
   * segment and every cue — over the same text, the same cues, and the same metric. Only the space
   * changes.
   */
  const modelId = process.env.MODEL;
  const onnx: EmbeddingProvider = modelId ? new OnnxEmbeddingProvider({ model: modelId }) : new OnnxEmbeddingProvider();
  await onnx.embed("warmup");
  console.log(`embedder=${onnx.modelId ?? "(unnamed)"}  dim=${onnx.dim}\n`);
  if (modelId !== undefined) {
    let done = 0;
    for (const o of observations) {
      o.whole = await onnx.embed(o.content);
      o.segs = [];
      for (const s of segTextByObs.get(o.oid) ?? [o.content]) o.segs.push(await onnx.embed(s));
      if (++done % 300 === 0) console.log(`  re-embedded ${done}/${observations.length}`);
    }
  }

  const t = new Map<Variant, Tally>(VARIANTS.map((v) => [v, { r1: 0, r5: 0, r10: 0, mrr: 0, n: 0 }]));
  const tLong = new Map<Variant, Tally>(VARIANTS.map((v) => [v, { r1: 0, r5: 0, r10: 0, mrr: 0, n: 0 }]));
  console.log(`circle=${circle}   ${observations.length} observations / ${segRows.length} segments`);
  console.log(`cue = ${CUE_MODE} sentence, capped at 220 chars. Target is NOT withheld.\n`);

  for (const probe of observations) {
    const cueText = cue(probe.content);
    const qv = await onnx.embed(cueText);
    const qToks = lexicalTokens(cueText);
    const scored = new Map<Variant, Array<{ oid: string; s: number }>>(VARIANTS.map((v) => [v, []]));

    for (const cand of observations) {
      const w = cosine(qv, cand.whole!);
      let bestSeg = -Infinity;
      for (const sv of cand.segs) { const c = cosine(qv, sv); if (c > bestSeg) bestSeg = c; }
      const lex = lexicalOverlap(qToks, cand.toks, idfOf);
      scored.get("whole")!.push({ oid: cand.oid, s: w });
      scored.get("segment")!.push({ oid: cand.oid, s: bestSeg });
      scored.get("segment+lexical")!.push({ oid: cand.oid, s: blendLexical(bestSeg, lex) });
    }

    for (const v of VARIANTS) {
      const ranked = scored.get(v)!.sort((a, b) => b.s - a.s || (a.oid < b.oid ? -1 : 1));
      const rank = ranked.findIndex((x) => x.oid === probe.oid) + 1;
      const isLong = probe.content.length >= LONG_CHARS;
      for (const acc of isLong ? [t.get(v)!, tLong.get(v)!] : [t.get(v)!]) {
        acc.n++;
        if (rank === 1) acc.r1++;
        if (rank >= 1 && rank <= 5) acc.r5++;
        if (rank >= 1 && rank <= 10) acc.r10++;
        if (rank >= 1) acc.mrr += 1 / rank;
      }
    }
  }

  console.log(`  CAN THE STORE RETURN THE EXACT OBSERVATION ITS CUE CAME FROM?`);
  console.log(`  index              R@1     R@5    R@10     MRR`);
  for (const v of VARIANTS) {
    const a = t.get(v)!;
    const p = (x: number) => `${((x / a.n) * 100).toFixed(1)}%`.padStart(6);
    console.log(`  ${v.padEnd(17)} ${p(a.r1)}  ${p(a.r5)}  ${p(a.r10)}  ${(a.mrr / a.n).toFixed(4)}`);
  }
  const longN = observations.filter((o) => o.content.length >= LONG_CHARS).length;
  console.log(`\n  LONG OBSERVATIONS ONLY (>= ${LONG_CHARS} chars — tail sits past the window): n=${longN}`);
  console.log(`  index              R@1     R@5    R@10     MRR`);
  for (const v of VARIANTS) {
    const a = tLong.get(v)!;
    if (a.n === 0) continue;
    const p = (x: number) => `${((x / a.n) * 100).toFixed(1)}%`.padStart(6);
    console.log(`  ${v.padEnd(17)} ${p(a.r1)}  ${p(a.r5)}  ${p(a.r10)}  ${(a.mrr / a.n).toFixed(4)}`);
  }

  console.log(`\n  No concepts are involved. A failure here is a failure of storage-and-recall itself,`);
  console.log(`  not of how anything was filed and not of how a model would use the result.`);
}
void main();
