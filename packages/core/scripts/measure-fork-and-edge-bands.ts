/**
 * Re-derive the LAST TWO cosine constants that never travelled: tauAmbiguous and edgeSimMin.
 *
 *   MONET_DB=/path/to/store.db npx tsx scripts/measure-fork-and-edge-bands.ts
 *
 * tauAttach, the segment budget, and the card-emission floor all now carry a per-model value with a
 * derivation table beside it. These two do not. `tauAmbiguous` is 0.5 in every profile — legacy,
 * multilingual, and bge alike — and a value identical across every profile was derived for none.
 * `edgeSimMin` is not in the profile table at all: engine.ts picks `semantic ? 0.45 : 0.4`, a binary
 * split across the whole class of semantic models, which is the same carried-over-constant failure
 * the profile table exists to prevent.
 *
 * Each governs a DECISION, so each is measured as that decision on the corpus it governs — never as
 * a pair distribution, which is what made the earlier ranking claim wrong.
 *
 * ── tauAmbiguous ──────────────────────────────────────────────────────────────────────────────
 * It splits the below-attach region in two: `score >= tauAmbiguous` forks but records a
 * possible-duplicate edge back to the near-miss; `score < tauAmbiguous` forks with no link at all.
 * So the question is not "is 0.5 a good number" but "how many forks does 0.5 actually separate".
 * Replays every live observation leave-one-out, exactly as measure-attach-thresholds.ts does, and
 * reports the argmax score distribution OF THE FORKS. If no fork scores below 0.5, the constant is
 * inert in this space and the honest output is that fact, not a tuned replacement.
 *
 * ── edgeSimMin ────────────────────────────────────────────────────────────────────────────────
 * A `related` edge is written when `edgeSimMin <= cos(a,b) < tauAttach` between two concept vectors.
 * With gather removed nothing RANKS with these edges any more, but they still drive
 * overview.counts.edges, topThread, topConnectedConcepts, and the duplicate/extraction queues — so
 * the constant now governs what a human is shown, and an edge set that connects everything shows
 * nothing. Scores every concept pair in the dominant circle and reports, per candidate, the edge
 * count, the graph density, and the degree of the most-connected concept.
 *
 * BOTH READ THE SAME WAY: find the point where the population stops being dominated by pairs that
 * are merely co-located in the space. bge's own numbers say where to look — on STARTER_SUITE the
 * median cosine between UNRELATED texts is 0.458 and junk p95 is 0.481, so any edge floor at or
 * below ~0.48 is admitting the median unrelated pair.
 */
import Database from "better-sqlite3";
import { cosine, isZeroVector, jsonToEmb } from "../src/embedding";

const DB = process.env.MONET_DB ?? `${process.env.HOME}/.monet/monet.db`;
const EDGE_CANDIDATES = (process.env.EDGE_MINS ?? "0.40,0.45,0.50,0.55,0.60,0.65,0.70")
  .split(",").map((s) => Number(s.trim()));
const TAU_ATTACH = Number(process.env.TAU_ATTACH ?? 0.78);
const AMBIG_CANDIDATES = (process.env.TAU_AMBIGS ?? "0.40,0.50,0.55,0.60,0.65,0.70")
  .split(",").map((s) => Number(s.trim()));

const db = new Database(DB, { readonly: true });
const pin = (db.prepare(`SELECT embedder_model_id AS m FROM sync_meta`).get() as { m: string } | undefined)?.m;
const circle = (db.prepare(
  `SELECT circle, COUNT(*) n FROM concepts WHERE kind!='source' GROUP BY circle ORDER BY n DESC LIMIT 1`,
).get() as { circle: string }).circle;
console.log(`db=${DB}\npin=${pin ?? "(none)"}  circle=${circle}  tauAttach=${TAU_ATTACH}\n`);

const pct = (n: number, d: number): string => `${((100 * n) / Math.max(d, 1)).toFixed(1)}%`;
const quantile = (sorted: number[], q: number): number =>
  sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/* ───────────────────────── tauAmbiguous: the fork score distribution ───────────────────────── */

type Seg = { conceptId: string; obsId: string; v: Float32Array };
const segments: Seg[] = [];
for (const row of db.prepare(
  `SELECT s.embedding AS e, o.id AS obs, o.concept_id AS cid
     FROM observation_segments s
     JOIN observations o ON o.id = s.observation_id
     JOIN concepts c ON c.id = o.concept_id
    WHERE c.circle = ? AND c.kind != 'source' AND o.kind != 'source' AND s.embedding IS NOT NULL`,
).iterate(circle) as Iterable<{ e: string; obs: string; cid: string }>) {
  const v = jsonToEmb(row.e);
  if (!isZeroVector(v)) segments.push({ conceptId: row.cid, obsId: row.obs, v });
}

const byObs = new Map<string, Seg[]>();
const byConcept = new Map<string, Seg[]>();
for (const s of segments) {
  (byObs.get(s.obsId) ?? byObs.set(s.obsId, []).get(s.obsId)!).push(s);
  (byConcept.get(s.conceptId) ?? byConcept.set(s.conceptId, []).get(s.conceptId)!).push(s);
}
const obsPerConcept = new Map<string, number>();
for (const [, segs] of byObs) {
  const cid = segs[0].conceptId;
  obsPerConcept.set(cid, (obsPerConcept.get(cid) ?? 0) + 1);
}

// Leave-one-out nomination, argmax over each concept's best SEGMENT cosine — the same replay
// measure-attach-thresholds.ts runs, so the two derivations sit in one space.
const forkScores: number[] = [];   // argmax score of every observation that would NOT attach
let attached = 0;
for (const [obsId, obsSegs] of byObs) {
  const own = obsSegs[0].conceptId;
  if ((obsPerConcept.get(own) ?? 0) < 2) continue; // singleton: un-nominatable by construction
  let best = -1;
  for (const [cid, cSegs] of byConcept) {
    for (const cs of cSegs) {
      if (cs.obsId === obsId) continue; // withhold the observation from its own concept
      for (const os of obsSegs) {
        const c = cosine(os.v, cs.v);
        if (c > best) best = c;
      }
    }
    void cid;
  }
  if (best >= TAU_ATTACH) attached++;
  else forkScores.push(best);
}
forkScores.sort((a, b) => a - b);

console.log(`===== tauAmbiguous — ${byObs.size} observations replayed, ${attached} attach, ${forkScores.length} FORK =====`);
console.log(`fork argmax score:  min=${forkScores[0]?.toFixed(4)}  p05=${quantile(forkScores, 0.05).toFixed(4)}  ` +
  `p25=${quantile(forkScores, 0.25).toFixed(4)}  median=${quantile(forkScores, 0.5).toFixed(4)}  max=${forkScores.at(-1)?.toFixed(4)}`);
for (const t of AMBIG_CANDIDATES) {
  const linked = forkScores.filter((s) => s >= t).length;
  console.log(`  tauAmbiguous=${t.toFixed(2)}  forks WITH a possible-duplicate edge=${linked} (${pct(linked, forkScores.length)})  ` +
    `forks with NO link=${forkScores.length - linked}`);
}

/* ───────────────────────── edgeSimMin: what the `related` band admits ───────────────────────── */

const concepts: { id: string; v: Float32Array }[] = [];
for (const row of db.prepare(
  `SELECT id, embedding AS e FROM concepts WHERE circle = ? AND kind != 'source' AND status = 'active' AND embedding IS NOT NULL`,
).iterate(circle) as Iterable<{ id: string; e: string }>) {
  const v = jsonToEmb(row.e);
  if (!isZeroVector(v)) concepts.push({ id: row.id, v });
}

const pairScores: number[] = [];
const degrees = new Map<number, Map<string, number>>(EDGE_CANDIDATES.map((t) => [t, new Map()]));
for (let i = 0; i < concepts.length; i++) {
  for (let j = i + 1; j < concepts.length; j++) {
    const c = cosine(concepts[i].v, concepts[j].v);
    pairScores.push(c);
    if (c >= TAU_ATTACH) continue; // above attach is a duplicate candidate, not a `related` edge
    for (const t of EDGE_CANDIDATES) {
      if (c < t) continue;
      const d = degrees.get(t)!;
      d.set(concepts[i].id, (d.get(concepts[i].id) ?? 0) + 1);
      d.set(concepts[j].id, (d.get(concepts[j].id) ?? 0) + 1);
    }
  }
}
pairScores.sort((a, b) => a - b);
const totalPairs = pairScores.length;

console.log(`\n===== edgeSimMin — ${concepts.length} active concepts, ${totalPairs} pairs =====`);
console.log(`concept-pair cosine:  min=${pairScores[0]?.toFixed(4)}  p25=${quantile(pairScores, 0.25).toFixed(4)}  ` +
  `median=${quantile(pairScores, 0.5).toFixed(4)}  p95=${quantile(pairScores, 0.95).toFixed(4)}  max=${pairScores.at(-1)?.toFixed(4)}`);
for (const t of EDGE_CANDIDATES) {
  const d = degrees.get(t)!;
  const edges = [...d.values()].reduce((a, b) => a + b, 0) / 2;
  const maxDeg = Math.max(0, ...d.values());
  const isolated = concepts.length - d.size;
  console.log(`  edgeSimMin=${t.toFixed(2)}  related edges=${edges}  density=${pct(edges, totalPairs)}  ` +
    `max degree=${maxDeg}  concepts with NO related edge=${isolated} (${pct(isolated, concepts.length)})`);
}
db.close();
