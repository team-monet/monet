/**
 * Calibrate / re-verify NATIVE_SCORE_FLOOR (src/retrieval.ts) — the recall unit split's
 * card-emission floor for search().
 *
 *   npx tsx scripts/measure-recall-floor.ts                    # lexical (CI) embedder only
 *   MONET_EVAL_ONNX=1 npx tsx scripts/measure-recall-floor.ts   # + MiniLM, the shipping space
 *
 * WHY THIS LIVES IN THE REPO: the floor is a single constant that governs whether a user's search
 * returns anything at all, and it was chosen from measurement, not intuition. Anyone changing it
 * (or changing the embedder, or the tokenizer) needs to re-run the exact experiment rather than
 * re-derive it. Reporting only; never mutates a store, never writes files, always exits 0.
 *
 * METHOD. Seed one in-memory store from the eval corpus (src/eval/scenarios.ts BACKGROUND + every
 * STARTER_SUITE scenario's seeds/tangents/distractors), then score every concept at OBSERVATION
 * granularity — max cosine over its live, non-zero observation vectors, the same unit
 * scoreNativeConceptsByObservation ranks by. Three populations come out of that:
 *
 *   GOLD      — a probe's own gold concept(s). These are genuine matches; the floor must keep
 *               them. `min` is the number that matters: it is the weakest real answer in the set,
 *               so the floor has to sit under it with margin.
 *   NON-GOLD  — every other concept under a REAL probe query. Context, not a target.
 *   JUNK      — every concept under an off-topic query (see JUNK_QUERIES). This is the null-query
 *               noise the floor exists to silence.
 *
 * Scoring reads the observation rows directly rather than calling the engine, so the measurement
 * stays valid if the scorer's own filtering changes.
 *
 * READING THE OUTPUT: pick the highest floor that still keeps 100% of GOLD, then check how much
 * JUNK it suppresses. The floor is a noise gate, not a relevance classifier — a junk query against
 * a broad technical corpus legitimately retrieves SOMETHING, so "junk queries fully silent" is
 * expected to stay low and is not the target.
 */
import { MonetCore } from "../src/engine";
import { HashingEmbeddingProvider, cosine, isZeroVector, jsonToEmb, type EmbeddingProvider } from "../src/embedding";
import { printProviderIdentity, printSyntheticStoreHeader } from "./measure-header";
import { NATIVE_SCORE_FLOOR, nativeScoreFloorOf } from "../src/retrieval";
import { STARTER_SUITE, BACKGROUND } from "../src/eval/scenarios";
import type { StoragePort } from "../src/storage";

const CIRCLE = "default";
// The candidate list must span the space the SHIPPING model's decision actually lives in. The
// original stopped at 0.25 because that bracketed MiniLM, whose junk p50 was 0.023; bge places
// junk at p50 0.397, so every candidate here was below its noise floor and the sweep could not
// show the trade at all. Overridable for a one-off sweep.
const CANDIDATE_FLOORS = (process.env.FLOORS ?? "0.05,0.1,0.12,0.15,0.2,0.25,0.3,0.35,0.4,0.45,0.5,0.55,0.6")
  .split(",").map(Number);

/** Off-topic in a way no engineering store answers: other domains, and pure noise. */
const JUNK_QUERIES = [
  "zzqx flurb wibbleton grommet",
  "the mitochondria is the powerhouse of the cell",
  "recipe for sourdough starter hydration ratio",
  "what time does the ferry leave for the island",
  "quarterly dividend yield of municipal bond funds",
  "knitting cable stitch pattern for a wool scarf",
  "how to prune tomato suckers in midsummer",
  "the migratory patterns of arctic terns",
  "asdfgh qwerty zxcvbn",
];

const dbOf = (core: MonetCore): StoragePort => (core as unknown as { db: StoragePort }).db;

async function seed(embedder: EmbeddingProvider): Promise<{ core: MonetCore; goldByQuery: Map<string, Set<string>>; queries: string[] }> {
  // Dedup OFF + deterministic ids: the eval harness's own convention (seedScenario), so every
  // seed stays a distinct concept and the gold denominator cannot be corrupted by a merge.
  let seq = 0;
  const core = new MonetCore(":memory:", {
    embedder, tauAttach: 1.1, tauAmbiguous: 1.1,
    idGen: () => `c${(seq++).toString().padStart(6, "0")}`,
  });
  const byKey = new Map<string, string>();
  const store = async (s: { key: string; content: string; kind?: string }): Promise<void> => {
    byKey.set(s.key, (await core.store(s.content, { circle: CIRCLE, kind: s.kind })).conceptId);
  };
  for (const s of BACKGROUND) await store(s);
  for (const scenario of STARTER_SUITE) {
    for (const s of [...scenario.seed, ...(scenario.tangents ?? [])]) await store(s);
    for (const s of scenario.distractors ?? []) await store(s);
  }
  const goldByQuery = new Map<string, Set<string>>();
  const queries: string[] = [];
  for (const scenario of STARTER_SUITE) {
    for (const probe of scenario.probes) {
      queries.push(probe.query);
      goldByQuery.set(probe.query, new Set(probe.gold.map((k) => byKey.get(k)).filter((v): v is string => Boolean(v))));
    }
  }
  return { core, goldByQuery, queries };
}

/** Observation-granular score per concept — the unit scoreNativeConceptsByObservation ranks by. */
function observationMaxByConcept(db: StoragePort, emb: Float32Array): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT concept_id, embedding FROM observations
        WHERE concept_id IS NOT NULL AND kind != 'source'
          AND superseded_by IS NULL AND superseded_at IS NULL`,
    )
    .all() as Array<{ concept_id: string; embedding: string }>;
  const best = new Map<string, number>();
  for (const row of rows) {
    const vec = jsonToEmb(row.embedding);
    if (isZeroVector(vec)) continue;
    const score = cosine(emb, vec);
    const prior = best.get(row.concept_id);
    if (prior === undefined || score > prior) best.set(row.concept_id, score);
  }
  return best;
}

const pct = (sorted: number[], p: number): number =>
  sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))];

async function measure(label: string, embedder: EmbeddingProvider, measuredDim?: number): Promise<void> {
  // The floor TRAVELS (#172), so the marker and the warning must resolve the provider's own value.
  // Marking the module fallback would label the wrong threshold active and stay silent while
  // search() drops gold sitting between the fallback and the real floor.
  const effectiveFloor = nativeScoreFloorOf((embedder as { nativeScoreFloor?: number }).nativeScoreFloor);
  const { core, goldByQuery, queries } = await seed(embedder);
  try {
    const db = dbOf(core);
    const gold: number[] = [];
    const nonGold: number[] = [];
    const junkAll: number[] = [];
    const junkTop: number[] = [];

    for (const query of queries) {
      const scores = observationMaxByConcept(db, await embedder.embed(query));
      const goldIds = goldByQuery.get(query)!;
      for (const [id, score] of scores) (goldIds.has(id) ? gold : nonGold).push(score);
    }
    for (const query of JUNK_QUERIES) {
      const scores = [...observationMaxByConcept(db, await embedder.embed(query)).values()];
      junkAll.push(...scores);
      junkTop.push(Math.max(...scores));
    }

    const g = gold.sort((a, b) => a - b);
    const n = nonGold.sort((a, b) => a - b);
    const j = junkAll.sort((a, b) => a - b);
    const t = junkTop.sort((a, b) => a - b);
    const f = (x: number): string => x.toFixed(4);

    console.log(`\n===== ${label} — ${queries.length} probe queries, ${JUNK_QUERIES.length} junk queries =====`);
    // The prose label says which provider CLASS this is; the identity line says which SPACE, which is
    // the fact a floor derived here has to be read against. There is no store pin to supply it.
    printProviderIdentity(label, embedder, measuredDim);
    console.log(`GOLD      min=${f(g[0])} p05=${f(pct(g, 5))} p25=${f(pct(g, 25))} median=${f(pct(g, 50))} max=${f(g[g.length - 1])}  n=${g.length}`);
    console.log(`NON-GOLD  median=${f(pct(n, 50))} p90=${f(pct(n, 90))} p99=${f(pct(n, 99))}  n=${n.length}`);
    console.log(`JUNK      p50=${f(pct(j, 50))} p95=${f(pct(j, 95))} p99=${f(pct(j, 99))} max=${f(j[j.length - 1])}  n=${j.length}`);
    console.log(`JUNK top-per-query  min=${f(t[0])} median=${f(pct(t, 50))} max=${f(t[t.length - 1])}`);
    for (const floor of CANDIDATE_FLOORS) {
      const keptGold = g.filter((s) => s >= floor).length / g.length;
      const suppressedJunk = j.filter((s) => s < floor).length / j.length;
      const silentQueries = t.filter((s) => s < floor).length / t.length;
      const mark = floor === effectiveFloor ? `  <== ACTIVE FLOOR for ${label}` : "";
      console.log(
        `  floor=${floor.toFixed(2)}  gold kept=${(keptGold * 100).toFixed(1)}%` +
        `  junk cards suppressed=${(suppressedJunk * 100).toFixed(1)}%` +
        `  junk queries fully silent=${(silentQueries * 100).toFixed(1)}%${mark}`,
      );
    }
    if (g[0] < effectiveFloor) {
      console.log(`\n  WARNING: the weakest genuine match (${f(g[0])}) is BELOW this provider's ACTIVE floor (${effectiveFloor}) — search would drop it.`);
    }
  } finally {
    core.close();
  }
}

async function main(): Promise<void> {
  // No store to name: this script seeds a fresh :memory: MonetCore per provider, so the space is
  // whatever each `measure(...)` below constructs, and each one is labelled with its own embedder.
  printSyntheticStoreHeader("one :memory: MonetCore seeded per provider");
  console.log(`NATIVE_SCORE_FLOOR = ${NATIVE_SCORE_FLOOR}`);
  await measure("HashingEmbeddingProvider (lexical — what CI runs)", new HashingEmbeddingProvider());
  if (process.env.MONET_EVAL_ONNX === "1") {
    const { OnnxEmbeddingProvider } = await import("../src/embedding-onnx");
    // MONET_EVAL_MODEL names the space to measure; without it this measures whatever DEFAULT_MODEL
    // happens to be, which is the wrong instrument for deriving a CANDIDATE model's own floor — the
    // one job that brings anyone here while a default is being changed.
    const onnx = new OnnxEmbeddingProvider({ model: process.env.MONET_EVAL_MODEL });
    // MONET_EVAL_MODEL is by definition a model no profile may describe, so `onnx.dim` can be the
    // declarative 384 fallback while the checkpoint embeds wider. Keep the warmup vector and report
    // the width this run actually produced.
    const warmup = await onnx.embed("warmup"); // force model load before timing anything
    await measure(`${onnx.modelId} (semantic — what ships)`, onnx, warmup.length);
  } else {
    console.log("\n(set MONET_EVAL_ONNX=1 to also measure the SHIPPING semantic space — the one the floor is calibrated for)");
  }
}

void main();
