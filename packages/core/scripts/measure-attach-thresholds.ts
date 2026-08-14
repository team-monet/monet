/**
 * Re-derive tauAttach on the SEGMENTED live corpus (#155).
 *
 *   MONET_DB=/path/to/backfilled.db npx tsx scripts/measure-attach-thresholds.ts
 *
 * WHY THIS EXISTS RATHER THAN A CARRIED-OVER NUMBER. tauAttach arrived as the embedder's
 * `recommendedThresholds`, derived for obs-vs-centroid cosine and then applied to obs-vs-obs, on the
 * argument that obs-vs-obs runs higher so the same number is "stricter". It is not: a fixed threshold
 * under a quantity that shifts UPWARD gets easier to clear. That reasoning was checked against
 * STARTER_SUITE, whose 1.0-1.1 observations/concept makes it structurally unable to exhibit the
 * effect — and #155 measured the result on the live store: 41.5% of observation pairs from DIFFERENT
 * concepts cleared tauAttach. Segmenting moves the whole scale again (to 3.6%), so carrying 0.72
 * across would invert the failure from "everything attaches" to "everything forks" — same mistake,
 * opposite sign. The number has to come from the corpus it will govern.
 *
 * WHAT IS MEASURED: the DECISION, not a pair distribution. Every live observation is replayed as if
 * arriving now — withheld from its own concept, then nominated by argmax over each concept's best
 * SEGMENT cosine, exactly as nominateByObservation + scoreNativeConceptsByObservation do. At each
 * candidate threshold the outcome is one of:
 *
 *   ATTACH-CORRECT  cleared the bar and the winner was its own concept
 *   ATTACH-WRONG    cleared the bar and the winner was NOT its own concept  <- the expensive one
 *   FORK            did not clear the bar: a new concept, plus a possible-duplicate edge
 *
 * THE OBJECTIVE IS ASYMMETRIC, and resolution.ts states why: "a wrong fork is recoverable by merge;
 * a wrong merge loses provenance." A fork is curation debt a human can pay later; a wrong attach
 * silently fuses two things and the split cannot restore what was blended. So this does NOT optimize
 * accuracy — it reports the frontier and lets the wrong-attach rate be the binding constraint.
 *
 * Singletons are excluded: withholding a one-observation concept's only observation leaves it
 * un-nominatable by construction, so counting it would score a structural impossibility as an error.
 */
import Database from "better-sqlite3";
import { cosine, isZeroVector, jsonToEmb } from "../src/embedding";
import { blendLexical, lexicalOverlap, lexicalTokens, tokenIdf } from "../src/lexical-overlap";

const DB = process.env.MONET_DB!;
const CANDIDATES = (process.env.TAUS ?? "0.50,0.55,0.58,0.60,0.62,0.65,0.68,0.70,0.72,0.75")
  .split(",").map((s) => Number(s.trim()));

const db = new Database(DB, { readonly: true });
const circle = (db.prepare(
  `SELECT circle, COUNT(*) n FROM concepts WHERE kind!='source' GROUP BY circle ORDER BY n DESC LIMIT 1`,
).get() as { circle: string }).circle;

const rows = db.prepare(
  `SELECT o.concept_id AS cid, o.id AS oid, s.embedding AS emb, s.content AS segcontent
     FROM observation_segments s
     JOIN observations o ON o.id = s.observation_id
     JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.circle = ?
    ORDER BY o.id, s.segment_index`,
).all(circle) as Array<{ cid: string; oid: string; emb: string; segcontent: string }>;

const contentRows = db.prepare(
  `SELECT o.id AS oid, o.content AS content
     FROM observations o JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.circle = ?`,
).all(circle) as Array<{ oid: string; content: string }>;
db.close();

interface Obs { oid: string; cid: string; vecs: Float32Array[]; toks: Set<string> }
const byObs = new Map<string, Obs>();
for (const r of rows) {
  const vec = jsonToEmb(r.emb);
  if (isZeroVector(vec)) continue;
  const entry = byObs.get(r.oid) ?? { oid: r.oid, cid: r.cid, vecs: [], toks: new Set<string>() };
  entry.vecs.push(vec);
  byObs.set(r.oid, entry);
}
for (const r of contentRows) {
  const entry = byObs.get(r.oid);
  if (entry !== undefined) entry.toks = lexicalTokens(r.content);
}
const observations = [...byObs.values()];
const byConcept = new Map<string, Obs[]>();
for (const o of observations) byConcept.set(o.cid, [...(byConcept.get(o.cid) ?? []), o]);

console.log(`circle=${circle}   ${observations.length} observations / ${byConcept.size} concepts / ${rows.length} segments`);
console.log(`(${(rows.length / observations.length).toFixed(2)} segments per observation)\n`);

/** Best cosine between a probe's segments and any segment of `other`. The scorer's own statistic. */
const best = (probe: Obs, other: Obs): number => {
  let m = -Infinity;
  for (const x of probe.vecs) for (const y of other.vecs) { const c = cosine(x, y); if (c > m) m = c; }
  return m;
};

// Document frequency over CONCEPTS — the population the ranking decides among, matching the engine.
const df = new Map<string, number>();
for (const members of byConcept.values()) {
  const seen = new Set<string>();
  for (const m of members) for (const t of m.toks) seen.add(t);
  for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
}
const idfOf = (t: string): number => tokenIdf(byConcept.size, df.get(t) ?? 0);

// One nomination per probe, computed ONCE; the threshold sweep is then pure arithmetic over it.
const nominations: Array<{ homeIsWinner: boolean; score: number }> = [];
const detailed: Array<{ homeIsWinner: boolean; homeSize: number; winnerSize: number }> = [];
for (const probe of observations) {
  if ((byConcept.get(probe.cid) ?? []).length < 2) continue; // un-nominatable by construction
  // THE SHIPPED DECISION, exactly: the winner is chosen on `rank` (cosine re-ordered by the lexical
  // arm), and the band comparison then reads that winner's RAW cosine. Sweeping the raw cosine of a
  // cosine-argmax winner would be measuring a decision the engine no longer makes.
  let winner: { cid: string; score: number; rank: number } | null = null;
  for (const [cid, members] of byConcept) {
    let m = -Infinity;
    const cToks = new Set<string>();
    let maxObsOverlap = 0;
    for (const other of members) {
      if (other.oid === probe.oid) continue; // withheld
      const c = best(probe, other);
      if (c > m) m = c;
      for (const t of other.toks) cToks.add(t);
      const o = lexicalOverlap(probe.toks, other.toks, idfOf);
      if (o > maxObsOverlap) maxObsOverlap = o;
    }
    if (m === -Infinity) continue;
    // Observation-unit MAX, matching the shipped applyLexicalArm. LEX_UNIT=union reproduces the
    // earlier concept-union form, which reintroduced a size bias and is kept only for comparison.
    const overlap = process.env.LEX_UNIT === "union" ? lexicalOverlap(probe.toks, cToks, idfOf) : maxObsOverlap;
    const rank = blendLexical(m, overlap);
    if (winner === null || rank > winner.rank || (rank === winner.rank && cid < winner.cid)) {
      winner = { cid, score: m, rank };
    }
  }
  if (winner !== null) {
    nominations.push({ homeIsWinner: winner.cid === probe.cid, score: winner.score });
    detailed.push({
      homeIsWinner: winner.cid === probe.cid,
      homeSize: (byConcept.get(probe.cid) ?? []).length,
      winnerSize: (byConcept.get(winner.cid) ?? []).length,
    });
  }
}

const n = nominations.length;
console.log(`replayed ${n} observations (concepts of size >= 2)\n`);
console.log(`  tauAttach   attach-correct   ATTACH-WRONG   fork    precision of attaches`);
for (const tau of CANDIDATES) {
  const attached = nominations.filter((x) => x.score >= tau);
  const correct = attached.filter((x) => x.homeIsWinner).length;
  const wrong = attached.length - correct;
  const fork = n - attached.length;
  const precision = attached.length === 0 ? NaN : (correct / attached.length) * 100;
  console.log(
    `  ${tau.toFixed(2).padStart(9)}   ${`${((correct / n) * 100).toFixed(1)}%`.padStart(14)}   ` +
      `${`${((wrong / n) * 100).toFixed(1)}%`.padStart(12)}   ${`${((fork / n) * 100).toFixed(1)}%`.padStart(5)}   ` +
      `${`${precision.toFixed(1)}%`.padStart(21)}`,
  );
}

/*
 * IS THE REMAINING ERROR THE SCORER, OR THE CORPUS? The sweep above is flat in precision, which says
 * no threshold fixes it — but not WHY. Split the same nominations by how big the probe's own concept
 * is, and by whether the concept that stole it is an over-absorbed one. If accuracy is high among
 * small concepts and collapses only where blobs are involved, the scorer is fine and the corpus is
 * the binding constraint; if it is flat everywhere, the signal itself is still too weak.
 */
const BINS: Array<[string, (n: number) => boolean]> = [
  ["2-4", (x) => x <= 4], ["5-9", (x) => x >= 5 && x <= 9], ["10-19", (x) => x >= 10 && x <= 19], ["20+", (x) => x >= 20],
];
console.log(`\n  ACCURACY BY HOME CONCEPT SIZE (threshold-independent — argmax only)`);
console.log(`  home size      n   returned home   stolen by a 20+ concept`);
for (const [label, pred] of BINS) {
  const subset = detailed.filter((x) => pred(x.homeSize));
  if (subset.length === 0) continue;
  const home = subset.filter((x) => x.homeIsWinner).length;
  const toBlob = subset.filter((x) => !x.homeIsWinner && x.winnerSize >= 20).length;
  console.log(
    `  ${label.padEnd(9)} ${String(subset.length).padStart(5)}   ${`${((home / subset.length) * 100).toFixed(1)}%`.padStart(13)}   ` +
      `${`${((toBlob / subset.length) * 100).toFixed(1)}%`.padStart(23)}`,
  );
}
const blobless = detailed.filter((x) => x.homeSize < 20 && x.winnerSize < 20);
console.log(
  `\n  EXCLUDING BLOBS ENTIRELY (neither home nor winner has 20+ observations): ` +
    `${blobless.filter((x) => x.homeIsWinner).length}/${blobless.length} ` +
    `= ${((blobless.filter((x) => x.homeIsWinner).length / Math.max(blobless.length, 1)) * 100).toFixed(1)}% returned home`,
);

console.log(`\n  A wrong attach is unrecoverable (a split cannot restore blended provenance);`);
console.log(`  a fork is curation debt. Read DOWN the ATTACH-WRONG column and stop where its cost`);
console.log(`  is acceptable — not where accuracy peaks.`);
