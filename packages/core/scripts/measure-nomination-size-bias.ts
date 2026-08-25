/**
 * NULL-MODEL TEST for a size bias in STORE-TIME NOMINATION (src/engine.ts nominateByObservation,
 * scoring via scoreNativeConceptsByObservation in src/retrieval.ts).
 *
 * THE HYPOTHESIS. Nomination is an argmax over per-concept MAX-cosine-over-live-observations. The
 * recall arm's own note (src/retrieval.ts, NATIVE_SCORE_FLOOR) states the mechanism plainly:
 * "ranking by MAX-over-observations gives a concept one lottery ticket per observation, so a big
 * concept can win on noise alone." Search corrects for it (per-concept dedupe + an emission floor).
 * NOMINATION APPLIES NEITHER. A 135-observation concept therefore gets 135 independent draws at
 * clearing tauAttach where a singleton gets 1 — and every attach adds another draw, which is a
 * positive feedback loop.
 *
 * WHY JUNK QUERIES ARE THE TEST. On a real query, a big concept outscoring a small one is
 * CONFOUNDED: it may simply hold more genuinely relevant evidence ("legitimate relevance mass",
 * which retrieval.ts deliberately keeps). Off-topic text has no genuine affinity to anything in the
 * store, so under a size-unbiased scorer the expected best-observation score must be FLAT in
 * concept size. Any monotone rise is structural — draw count, not content.
 *
 * READ THE OUTPUT AS: (1) is mean junk score flat across size bins? (2) how over-represented are
 * big concepts among junk argmax winners? (3) does junk reach tauAmbiguous/tauAttach on big
 * concepts — i.e. can noise alone drive a real attach decision?
 *
 * Read-only on a COPY of the live store. Never mutates, never writes to ~/.monet.
 *
 * WHAT THIS SCRIPT ESTABLISHED, AND WHY THE OBVIOUS REMEDY IS A DEAD END (measured 2026-08-23 on
 * bge-m3 over live monet-hq). The bias is REAL: best-observation cosine on off-topic text rises
 * monotonically with concept size (bin 1 mean -0.0192 -> bin 20+ mean 0.0190), and concepts of
 * size>=20 are 2.1% of the circle while winning 16.7% of junk argmaxes — 7.9x over-represented.
 *
 * It is NOT, however, what causes the misfiles, so do not reach for the correction named above.
 * Junk never approaches the bands (0.0% of pairs reach tauAmbiguous 0.5 or tauAttach 0.7), so noise
 * alone cannot drive an attach; the bias decides WHICH concept wins, not WHETHER one does. And the
 * margin it would have to close is too large: among misfiles the median rank(winner) - rank(home)
 * is 0.0767, roughly twice the ~0.04 total span of the size effect itself. Measured directly, a
 * log-size penalty (rank - alpha*ln(size)) is net NEGATIVE at every strength tried — 0.002 -> -4
 * observations, 0.01 -> -14, 0.03 -> -88, 0.12 -> -404 — even though it does exactly what it was
 * meant to (blob capture 34.0% -> 0.0%, mean wrong-winner size 29.7 -> 1.1). It removes the intended
 * misfiles and creates more new ones than it fixes.
 *
 * The two corrections search applies do not transfer either. Per-concept dedupe is a no-op here:
 * scoreNativeConceptsByObservation already yields ONE score per concept, so there is no slot
 * occupancy to collapse — search's dedupe fixes result-list crowding, which is a different failure
 * that happens to share the name. The emission floor is inert: 0 of 788 nomination winners fall
 * below 0.12, the lowest being 0.6748.
 *
 * WHAT REMAINS OPEN is not a knob. This replay's ground truth is the store's own past placements,
 * and 91.4% of them were made under MiniLM before the bge pin — so the 26% disagreement mixes
 * scorer error with the scorer correctly rejecting an old misfile. Splitting agreement by placement
 * era points the right way in all three comparable size bins (+3.3 / +16.2 / +6.4 pt for bge-era
 * placements) but every gap sits inside its own standard error at n=28/12/4. Separating label noise
 * from scorer error needs hand-adjudicated ground truth, not another statistic.
 */
import Database from "better-sqlite3";
import { cosine, isZeroVector, jsonToEmb, type EmbeddingProvider } from "../src/embedding";
import { printEmbedderHeader, printStoreHeader } from "./measure-header";

const DB = process.env.PROBE_DB!;
const JUNK = [
  "zzqx flurb wibbleton grommet",
  "the mitochondria is the powerhouse of the cell",
  "recipe for sourdough starter hydration ratio",
  "what time does the ferry leave for the island",
  "quarterly dividend yield of municipal bond funds",
  "knitting cable stitch pattern for a wool scarf",
  "how to prune tomato suckers in midsummer",
  "the migratory patterns of arctic terns",
  "asdfgh qwerty zxcvbn",
  "best hiking boots for wet granite scrambling",
  "how long to braise short ribs at low heat",
  "the offside rule explained for new fans",
];

const bucket = (n: number) => (n === 1 ? "1" : n <= 4 ? "2-4" : n <= 9 ? "5-9" : n <= 19 ? "10-19" : "20+");
const ORDER = ["1", "2-4", "5-9", "10-19", "20+"];
const q = (xs: number[], p: number) => (xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]);

async function main() {
  const db = new Database(DB, { readonly: true });
  const storeSpace = printStoreHeader(db, DB);

  // The nomination scan runs inside ONE circle. Measure the largest, which is where the blobs are.
  const circle = (db.prepare(
    `SELECT circle, COUNT(*) n FROM concepts WHERE kind!='source' GROUP BY circle ORDER BY n DESC LIMIT 1`,
  ).get() as { circle: string; n: number });
  console.log(`circle=${circle.circle} (${circle.n} non-source concepts)\n`);

  // Exactly the rows scoreNativeConceptsByObservation reads: live, non-source.
  const rows = db.prepare(
    `SELECT o.concept_id AS cid, o.embedding AS emb
       FROM observations o JOIN concepts c ON c.id = o.concept_id
      WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
        AND o.kind != 'source' AND c.circle = ? AND c.kind != 'source'`,
  ).all(circle.circle) as Array<{ cid: string; emb: string }>;

  const byConcept = new Map<string, Float32Array[]>();
  for (const r of rows) {
    const v = jsonToEmb(r.emb);
    if (isZeroVector(v)) continue; // placeholder, not a measurement — the scorer skips these too
    (byConcept.get(r.cid) ?? byConcept.set(r.cid, []).get(r.cid)!).push(v);
  }
  const sizes = new Map([...byConcept].map(([cid, vs]) => [cid, vs.length]));
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  console.log(`scorable: ${byConcept.size} concepts / ${total} observations (mean ${(total / byConcept.size).toFixed(2)})`);
  const share = new Map<string, number>();
  for (const n of sizes.values()) share.set(bucket(n), (share.get(bucket(n)) ?? 0) + 1);
  console.log(`concepts by size bin: ${ORDER.map((b) => `${b}=${share.get(b) ?? 0}`).join("  ")}\n`);

  const { OnnxEmbeddingProvider } = await import("../src/embedding-onnx");
  const onnx: EmbeddingProvider = new OnnxEmbeddingProvider();
  await onnx.embed("warmup");
  const th = onnx.recommendedThresholds;
  // This script embeds JUNK probes with the loaded model and scores them against the store's
  // STORED vectors, so a model that is not the store's pin makes every cosine below cross-space.
  printEmbedderHeader(storeSpace, onnx);
  console.log(`thresholds=${JSON.stringify(th)}\n`);

  // Per size bin: the distribution of best-observation cosine under OFF-TOPIC text.
  const perBin = new Map<string, number[]>(ORDER.map((b) => [b, []]));
  const winners: Array<{ size: number; score: number }> = [];

  for (const query of JUNK) {
    const qv = await onnx.embed(query);
    let best: { cid: string; score: number } | null = null;
    for (const [cid, vecs] of byConcept) {
      let m = -Infinity;
      for (const v of vecs) { const c = cosine(qv, v); if (c > m) m = c; }
      perBin.get(bucket(sizes.get(cid)!))!.push(m);
      if (best === null || m > best.score) best = { cid, score: m };
    }
    winners.push({ size: sizes.get(best!.cid)!, score: best!.score });
  }

  console.log("BEST-OBSERVATION COSINE ON OFF-TOPIC TEXT, BY CONCEPT SIZE");
  console.log("(flat = no size bias; rising = draw-count bias)\n");
  console.log("  bin      n      mean     p50      p95      max");
  for (const b of ORDER) {
    const xs = perBin.get(b)!;
    if (xs.length === 0) continue;
    const mean = xs.reduce((a, c) => a + c, 0) / xs.length;
    console.log(`  ${b.padEnd(7)} ${String(xs.length).padStart(5)}   ${mean.toFixed(4)}  ${q(xs, 0.5).toFixed(4)}  ${q(xs, 0.95).toFixed(4)}  ${Math.max(...xs).toFixed(4)}`);
  }

  const bigShare = ([...sizes.values()].filter((n) => n >= 20).length / byConcept.size) * 100;
  const wonBig = (winners.filter((w) => w.size >= 20).length / winners.length) * 100;
  const meanWinner = winners.reduce((a, w) => a + w.size, 0) / winners.length;
  console.log(`\nARGMAX WINNER ON JUNK (${winners.length} off-topic queries)`);
  console.log(`  concepts of size>=20 are ${bigShare.toFixed(1)}% of the circle`);
  console.log(`  they win ${wonBig.toFixed(1)}% of junk argmaxes  ->  ${(wonBig / bigShare).toFixed(1)}x over-represented`);
  console.log(`  mean winner size ${meanWinner.toFixed(1)} obs vs store mean ${(total / byConcept.size).toFixed(2)}`);

  if (th?.tauAmbiguous !== undefined) {
    const over = (t: number) => ORDER.map((b) => {
      const xs = perBin.get(b)!;
      return xs.length ? `${b}=${((xs.filter((x) => x >= t).length / xs.length) * 100).toFixed(1)}%` : `${b}=-`;
    }).join("  ");
    console.log(`\nSHARE OF (concept, junk query) PAIRS REACHING EACH BAND`);
    console.log(`  >= tauAmbiguous (${th.tauAmbiguous}):  ${over(th.tauAmbiguous)}`);
    console.log(`  >= tauAttach    (${th.tauAttach}):  ${over(th.tauAttach)}`);
  }
  // ------------------------------------------------------------------------------------------
  // LEAVE-ONE-OUT MISFILE TEST — the symptom itself, on REAL content rather than a null model.
  //
  // Every live observation is replayed as if it were arriving now: it is withheld from its own
  // concept, nomination is re-run over the circle exactly as nominateByObservation would, and the
  // winner is compared to the concept the observation actually lives in. Stored vectors are reused,
  // so this is the real embedding space with no re-embedding.
  //
  // A singleton's home has NO remaining evidence once its only observation is withheld, so it is
  // un-nominatable by construction (the no-centroid-fallback edge) and is excluded — counting it
  // would score a structural impossibility as a misfile. The population is therefore observations
  // in concepts of size >= 2.
  //
  // "Correct" here means "returns to its own concept". That is a proxy, not truth — an observation
  // sitting in an over-absorbed concept arguably BELONGS elsewhere — so read the STEAL DIRECTION
  // (what size wins when it is wrong) as the load-bearing number, not the raw rate.
  // ------------------------------------------------------------------------------------------
  const conceptIds = [...byConcept.keys()];

  /**
   * CANDIDATE NOMINATION STATISTICS, measured side by side on identical input.
   *
   *   max        SHIPPING. max cosine over the concept's live observations — one draw per
   *              observation, so E[max] rises with N on pure noise (the null model above).
   *   top2mean   mean of the two highest. A single lucky draw no longer carries a concept: the
   *              runner-up has to agree. Falls back to the sole value at size 1, so singletons
   *              are untouched and the arithmetic is identical where nothing has consolidated.
   *   mean       mean over ALL of the concept's observations. Maximal extreme-value suppression,
   *              but it reintroduces the dilution the unit split exists to remove — a large
   *              coherent concept is punished for breadth. Measured as the far end of the range,
   *              not as a proposal.
   */
  const STATS = ["max", "top2mean", "mean"] as const;
  type Stat = (typeof STATS)[number];
  const apply = (stat: Stat, best1: number, best2: number, sum: number, n: number): number =>
    stat === "max" ? best1 : stat === "mean" ? sum / n : n < 2 ? best1 : (best1 + best2) / 2;

  interface Tally { evaluated: number; home: number; stolenByBig: number; stolenSizeSum: number;
                    byBin: Map<string, { n: number; miss: number; toBigger: number }>; }
  const tally = new Map<Stat, Tally>(STATS.map((s) => [s, {
    evaluated: 0, home: 0, stolenByBig: 0, stolenSizeSum: 0,
    byBin: new Map(ORDER.map((b) => [b, { n: 0, miss: 0, toBigger: 0 }])),
  }]));

  for (const homeId of conceptIds) {
    const mine = byConcept.get(homeId)!;
    if (mine.length < 2) continue; // withholding the only observation leaves nothing to nominate
    const homeBin = bucket(mine.length);
    for (let i = 0; i < mine.length; i++) {
      const probe = mine[i];
      const best = new Map<Stat, { cid: string; score: number }>();
      for (const cid of conceptIds) {
        const vecs = byConcept.get(cid)!;
        // One pass per candidate collects every statistic's inputs: the two highest and the sum.
        let b1 = -Infinity, b2 = -Infinity, sum = 0, n = 0;
        for (let j = 0; j < vecs.length; j++) {
          if (cid === homeId && j === i) continue; // withheld
          const c = cosine(probe, vecs[j]);
          sum += c; n++;
          if (c > b1) { b2 = b1; b1 = c; } else if (c > b2) { b2 = c; }
        }
        if (n === 0) continue;
        for (const stat of STATS) {
          const score = apply(stat, b1, b2, sum, n);
          const prior = best.get(stat);
          if (prior === undefined || score > prior.score || (score === prior.score && cid < prior.cid)) best.set(stat, { cid, score });
        }
      }
      for (const stat of STATS) {
        const win = best.get(stat);
        if (win === undefined) continue;
        const t = tally.get(stat)!;
        t.evaluated++;
        const slot = t.byBin.get(homeBin)!;
        slot.n++;
        if (win.cid === homeId) { t.home++; continue; }
        slot.miss++;
        const winnerSize = sizes.get(win.cid)!;
        t.stolenSizeSum += winnerSize;
        if (winnerSize >= 20) t.stolenByBig++;
        if (winnerSize > mine.length) slot.toBigger++;
      }
    }
  }

  const base = tally.get("max")!;
  console.log(`\nLEAVE-ONE-OUT MISFILE TEST (${base.evaluated} observations in concepts of size>=2)`);
  console.log(`  statistic    home%   |  when WRONG: mean winner size   won by a 20+ blob`);
  for (const stat of STATS) {
    const t = tally.get(stat)!;
    const stolen = t.evaluated - t.home;
    const homePct = ((t.home / t.evaluated) * 100).toFixed(1);
    const sz = stolen ? (t.stolenSizeSum / stolen).toFixed(1) : "-";
    const big = stolen ? `${((t.stolenByBig / stolen) * 100).toFixed(1)}%` : "-";
    console.log(`  ${stat.padEnd(11)} ${homePct.padStart(5)}%  |  ${sz.padStart(22)}   ${big.padStart(16)}`);
  }
  console.log(`  (store mean concept size ${(total / byConcept.size).toFixed(2)}; 20+ blobs are ${bigShare.toFixed(1)}% of concepts)`);

  console.log(`\n  MISFILE RATE BY HOME CONCEPT SIZE — who loses their own evidence`);
  console.log(`  bin        n   ${STATS.map((s) => s.padStart(9)).join("")}      (of misfiles, share going to a BIGGER concept)`);
  for (const b of ORDER) {
    const s0 = base.byBin.get(b)!;
    if (s0.n === 0) continue;
    const cells = STATS.map((stat) => {
      const s = tally.get(stat)!.byBin.get(b)!;
      return `${((s.miss / s.n) * 100).toFixed(1)}%`.padStart(9);
    }).join("");
    const bigs = STATS.map((stat) => {
      const s = tally.get(stat)!.byBin.get(b)!;
      return s.miss ? `${((s.toBigger / s.miss) * 100).toFixed(0)}%` : "-";
    }).join("/");
    console.log(`  ${b.padEnd(7)} ${String(s0.n).padStart(5)}   ${cells}      ${bigs}`);
  }

  db.close();
}
void main();
