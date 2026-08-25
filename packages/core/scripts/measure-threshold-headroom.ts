/**
 * IS tauAttach ABOVE THE CORPUS'S OWN NOISE FLOOR? Measured on the live store, in the shipping
 * embedding space, at the granularity resolution actually compares.
 *
 * WHY. src/resolution.ts reuses tauAttach/tauAmbiguous — the embedder's recommendedThresholds — but
 * applies them to obs-vs-obs cosine instead of the obs-vs-centroid quantity they were derived for,
 * and argues (resolution.ts, "THRESHOLDS ARE REUSED, NOT REINVENTED") that because obs-vs-obs runs
 * HIGHER, the same numbers are "STRICTER in obs space ... the conservative direction". That
 * inference needs checking: a threshold held fixed while the quantity it gates shifts UPWARD gets
 * EASIER to clear, not harder. The supporting measurement was run on the STARTER_SUITE corpus,
 * whose own harness note records that it "barely consolidates (1.0-1.1 observations/concept)" — a
 * store of single-observation concepts, where obs-vs-obs and obs-vs-centroid are arithmetically the
 * same thing and the shift being argued about cannot appear at all.
 *
 * THE TEST. Two populations of observation pairs, from the live store:
 *
 *   SAME-CONCEPT  pairs inside one concept — evidence the store already treats as one thing.
 *   CROSS-CONCEPT pairs from different concepts — evidence the store treats as DISTINCT. These are
 *                 the pairs that must NOT clear tauAttach; every one that does is a nomination the
 *                 threshold cannot refuse.
 *
 * If the two distributions overlap, the threshold is not separating them and no choice of cutoff
 * inside the overlap can. If the CROSS-CONCEPT median alone sits above tauAttach, the threshold is
 * below the corpus's noise floor and attach fires on essentially any pair.
 *
 * Read-only; reuses stored vectors, so this is the real space with no re-embedding. Cross-concept
 * pairs are subsampled on a fixed stride (no clock, no RNG) to keep the run bounded and repeatable.
 */
import Database from "better-sqlite3";
import { cosine, isZeroVector, jsonToEmb } from "../src/embedding";
import { printStoreHeader } from "./measure-header";

// PROBE_DB, not MONET_DB — of the five scripts that import no embedder this is the only one reading
// a different env var (nomination-size-bias and normalization-ceiling read PROBE_DB too, but they
// load embedders), so the header below prints the path it ACTUALLY resolved rather than the
// variable a reader assumes.
const DB = process.env.PROBE_DB!;
const TAU_ATTACH = Number(process.env.TAU_ATTACH ?? 0.72);
const TAU_AMBIGUOUS = Number(process.env.TAU_AMBIGUOUS ?? 0.5);
const MAX_CROSS = Number(process.env.MAX_CROSS ?? 400_000);

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const share = (xs: number[], t: number) => ((xs.filter((x) => x >= t).length / xs.length) * 100).toFixed(1);

const db = new Database(DB, { readonly: true });
printStoreHeader(db, DB);
const circle = (db.prepare(
  `SELECT circle, COUNT(*) n FROM concepts WHERE kind!='source' GROUP BY circle ORDER BY n DESC LIMIT 1`,
).get() as { circle: string }).circle;

/*
 * USE_SEGMENTS=1 measures at the granularity the shipped scorer actually ranks (#155): an
 * observation is represented by its SEGMENT vectors, and a pair scores as the MAX cosine over the
 * cross product of the two observations' segments — the same statistic
 * scoreNativeConceptsByObservation reduces to. Without it, the script measures the pre-#155
 * whole-observation vector, which is what the original calibration saw. Running both against one
 * store is how the threshold gets re-derived on evidence rather than carried over.
 */
const useSegments = process.env.USE_SEGMENTS === "1";
const rows = db.prepare(
  useSegments
    ? `SELECT o.concept_id AS cid, o.id AS oid, s.embedding AS emb
         FROM observation_segments s
         JOIN observations o ON o.id = s.observation_id
         JOIN concepts c ON c.id = o.concept_id
        WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
          AND o.kind != 'source' AND c.circle = ? AND c.kind != 'source'`
    : `SELECT o.concept_id AS cid, o.id AS oid, o.embedding AS emb
         FROM observations o JOIN concepts c ON c.id = o.concept_id
        WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
          AND o.kind != 'source' AND c.circle = ? AND c.kind != 'source'`,
).all(circle) as Array<{ cid: string; oid: string; emb: string }>;

// Group by OBSERVATION: the pair populations are observation pairs either way, so that a segmented
// and an unsegmented run are comparing the same things and only the evidence granularity differs.
const byObs = new Map<string, { cid: string; vecs: Float32Array[] }>();
for (const r of rows) {
  const vec = jsonToEmb(r.emb);
  if (isZeroVector(vec)) continue;
  const entry = byObs.get(r.oid) ?? { cid: r.cid, vecs: [] };
  entry.vecs.push(vec);
  byObs.set(r.oid, entry);
}
const obs = [...byObs.values()];
const pairScore = (a: { vecs: Float32Array[] }, b: { vecs: Float32Array[] }): number => {
  let m = -Infinity;
  for (const x of a.vecs) for (const y of b.vecs) { const c = cosine(x, y); if (c > m) m = c; }
  return m;
};

const same: number[] = [];
const cross: number[] = [];
const totalPairs = (obs.length * (obs.length - 1)) / 2;
const stride = Math.max(1, Math.ceil(totalPairs / MAX_CROSS));
let seen = 0;
for (let i = 0; i < obs.length; i++) {
  for (let j = i + 1; j < obs.length; j++) {
    if (obs[i].cid === obs[j].cid) { same.push(pairScore(obs[i], obs[j])); continue; }
    if (seen++ % stride !== 0) continue; // fixed stride, not sampled at random
    cross.push(pairScore(obs[i], obs[j]));
  }
}
same.sort((a, b) => a - b);
cross.sort((a, b) => a - b);

console.log(`circle=${circle}   ${obs.length} observations, ${new Set(obs.map((o) => o.cid)).size} concepts   granularity=${useSegments ? "SEGMENT" : "whole-observation"}`);
console.log(`thresholds: tauAmbiguous=${TAU_AMBIGUOUS}  tauAttach=${TAU_ATTACH}\n`);
console.log(`  population      n        p05     p25     p50     p75     p95`);
for (const [name, xs] of [["SAME-concept", same], ["CROSS-concept", cross]] as const) {
  console.log(`  ${name.padEnd(14)} ${String(xs.length).padStart(7)}   ` +
    [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => pct(xs, p).toFixed(4)).join("  "));
}
console.log(`\n  share of pairs at or above each band`);
console.log(`  population      >= tauAmbiguous   >= tauAttach`);
for (const [name, xs] of [["SAME-concept", same], ["CROSS-concept", cross]] as const) {
  console.log(`  ${name.padEnd(14)} ${share(xs, TAU_AMBIGUOUS).padStart(14)}%  ${share(xs, TAU_ATTACH).padStart(12)}%`);
}
console.log(`\n  CROSS-concept pairs are the ones attach must REFUSE.`);
console.log(`  A separating threshold would need to sit above the CROSS p95 (${pct(cross, 0.95).toFixed(4)})`);
console.log(`  and below the SAME p05 (${pct(same, 0.05).toFixed(4)}) — ` +
  (pct(cross, 0.95) < pct(same, 0.05) ? `that window EXISTS.` : `NO SUCH WINDOW EXISTS: the populations overlap.`));
db.close();
