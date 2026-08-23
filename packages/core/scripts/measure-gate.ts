/**
 * Derive `tauMargin` — the margin gate on the attach decision (#86).
 *
 *   MONET_DB=/path/to/copy.db npx tsx scripts/measure-gate.ts
 *
 * Read-only. Point it at a COPY: it opens the database read-only, but a live store is being written
 * underneath a run that takes minutes.
 *
 * WHY A SECOND GATE AND NOT A HIGHER FIRST ONE. `tauAttach` asks whether incoming evidence is
 * similar enough to an existing concept. It never asks whether the evidence identifies WHICH one.
 * measure-attach-thresholds.ts shows the consequence: attach precision is flat across the entire
 * tauAttach sweep, so moving that threshold trades correct attaches for forks without changing which
 * concept wins. The distance between the winner and the RUNNER-UP does discriminate, and this script
 * prices it.
 *
 * TWO POPULATIONS, SWEPT TOGETHER, because either one alone gives an answer that looks good and is
 * wrong:
 *
 *   HAS-HOME    every observation in a concept of size >= 2, withheld from its own concept. A right
 *               answer exists. Errors here are attaching to the wrong concept, and forks are the
 *               recoverable failure.
 *   NO-HOME     every observation whose concept holds only it. Withholding removes the home
 *               entirely, so the store's own answer was CREATE. Errors here are being absorbed into
 *               some existing concept — the failure a has-home-only sweep cannot see at all, and the
 *               one that builds blobs.
 *
 * Raising tauAttach looks fine on the first population and catastrophic on the second; the margin
 * gate is what improves both. The reported column is UNRECOVERABLE merges (wrong home + absorbed new
 * topic) because `resolution.ts` states the asymmetry this whole decision turns on: a wrong fork is
 * recoverable by merge, a wrong merge is not. Forks are therefore priced separately and not charged.
 *
 * WHAT THE RATE IS NOT. "wrong home" here is raw DISAGREEMENT with the store's existing placement,
 * not adjudicated error. On the corpus this was first run against, a blinded hand-adjudication of 60
 * of the disagreements found the store right 66.7%, the scorer right 20.0%, neither 8.3% and either
 * 5.0% — so roughly two thirds of this column is real and the rest is the scorer correctly rejecting
 * an old misfile. Read the sweep for SHAPE and for where the curve turns, not as an error rate.
 *
 * NOT VALID FOR CJK, and this script cannot tell you so. `rank` is `cosine * (1 + LEXICAL_BOOST *
 * overlap)` and `lexicalTokens` reads no CJK, so a CJK probe's ranks collapse to raw cosines and its
 * margins are a different quantity in a different scale. A corpus that is entirely Latin-script — as
 * the first one was — cannot exhibit that, and a value derived on it governs only Latin input. The
 * engine leaves the margin undefined when a probe yields no lexical tokens for exactly this reason.
 */
import Database from "better-sqlite3";
import { cosine, isZeroVector, jsonToEmb } from "../src/embedding";
import { blendLexical, lexicalOverlap, lexicalTokens, tokenIdf } from "../src/lexical-overlap";

const DB = process.env.MONET_DB!;
const TAU = Number(process.env.TAU ?? "0.70");
const DELTAS = (process.env.DELTAS ?? "0,0.01,0.02,0.03,0.05,0.08,0.12,0.20")
  .split(",").map((s) => Number(s.trim()));

const db = new Database(DB, { readonly: true });
const circle = process.env.CIRCLE ?? (db.prepare(
  `SELECT circle, COUNT(*) n FROM concepts WHERE kind!='source' GROUP BY circle ORDER BY n DESC LIMIT 1`,
).get() as { circle: string }).circle;

const segmentRows = db.prepare(
  `SELECT o.concept_id AS cid, o.id AS oid, s.embedding AS emb
     FROM observation_segments s
     JOIN observations o ON o.id = s.observation_id
     JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.circle = ?
    ORDER BY o.id, s.segment_index`,
).all(circle) as Array<{ cid: string; oid: string; emb: string }>;

const contentRows = db.prepare(
  `SELECT o.id AS oid, o.content AS content
     FROM observations o JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.circle = ?`,
).all(circle) as Array<{ oid: string; content: string }>;
db.close();

interface Obs { oid: string; cid: string; vecs: Float32Array[]; toks: Set<string> }
const byObs = new Map<string, Obs>();
for (const r of segmentRows) {
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

// Document frequency over CONCEPTS — the population the ranking decides among, matching the engine.
const df = new Map<string, number>();
for (const members of byConcept.values()) {
  const seen = new Set<string>();
  for (const m of members) for (const t of m.toks) seen.add(t);
  for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
}
const idfOf = (t: string): number => tokenIdf(byConcept.size, df.get(t) ?? 0);

/** Best cosine between a probe's segments and any segment of `other`. The scorer's own statistic. */
const best = (probe: Obs, other: Obs): number => {
  let m = -Infinity;
  for (const x of probe.vecs) for (const y of other.vecs) { const c = cosine(x, y); if (c > m) m = c; }
  return m;
};

/** One probe's full candidate table, computed ONCE; every sweep below is arithmetic over it. */
interface Candidate { cid: string; score: number; rank: number }
interface Probe { homeCid: string; homeSize: number; candidates: Candidate[] }
const probes: Probe[] = [];
for (const probe of observations) {
  const homeSize = (byConcept.get(probe.cid) ?? []).length;
  const candidates: Candidate[] = [];
  for (const [cid, members] of byConcept) {
    let bestCos = -Infinity;
    let bestOverlap = 0;
    for (const other of members) {
      if (other.oid === probe.oid) continue; // withheld — this is the whole method
      const c = best(probe, other);
      if (c > bestCos) bestCos = c;
      const o = lexicalOverlap(probe.toks, other.toks, idfOf);
      if (o > bestOverlap) bestOverlap = o;
    }
    if (bestCos === -Infinity) continue; // the home of a singleton vanishes here, by construction
    candidates.push({ cid, score: bestCos, rank: blendLexical(bestCos, bestOverlap) });
  }
  if (candidates.length > 0) probes.push({ homeCid: probe.cid, homeSize, candidates });
}

const hasHome = probes.filter((p) => p.homeSize >= 2);
const noHome = probes.filter((p) => p.homeSize === 1);
console.log(`circle=${circle}   ${observations.length} observations / ${byConcept.size} concepts`);
console.log(`has-home ${hasHome.length} (a right answer exists)   no-home ${noHome.length} (the right answer is CREATE)`);
console.log(`tauAttach=${TAU}\n`);

const ranked = (p: Probe, excludeHome: boolean): Candidate[] =>
  p.candidates.filter((c) => !excludeHome || c.cid !== p.homeCid).sort((a, b) => b.rank - a.rank);

const pc = (x: number, d: number): string => `${((100 * x) / Math.max(d, 1)).toFixed(1)}%`;

console.log(`  delta   RIGHT home   WRONG home     fork  |  correct CREATE   absorbed  |  UNRECOVERABLE`);
for (const delta of DELTAS) {
  let right = 0, wrong = 0, fork = 0, created = 0, absorbed = 0;
  for (const p of hasHome) {
    const r = ranked(p, false);
    const sep = r[1] !== undefined ? r[0]!.rank - r[1]!.rank : Infinity;
    if (r[0]!.score < TAU || sep < delta) fork++;
    else if (r[0]!.cid === p.homeCid) right++;
    else wrong++;
  }
  for (const p of noHome) {
    const r = ranked(p, true);
    if (r.length === 0) { created++; continue; }
    const sep = r[1] !== undefined ? r[0]!.rank - r[1]!.rank : Infinity;
    if (r[0]!.score >= TAU && sep >= delta) absorbed++;
    else created++;
  }
  const total = hasHome.length + noHome.length;
  console.log(
    `  ${delta.toFixed(2)}   ${pc(right, hasHome.length).padStart(10)}   ${pc(wrong, hasHome.length).padStart(10)}   ` +
      `${pc(fork, hasHome.length).padStart(6)}  |  ${pc(created, noHome.length).padStart(14)}   ` +
      `${pc(absorbed, noHome.length).padStart(8)}  |  ${pc(wrong + absorbed, total).padStart(14)}`,
  );
}

console.log(`\n  UNRECOVERABLE counts only merges a split cannot undo — a wrong home plus an absorbed`);
console.log(`  new topic. A fork is curation debt and is deliberately not charged here.`);
console.log(`\n  Read DOWN the UNRECOVERABLE column and stop where the fork column stops being payable,`);
console.log(`  not where any single number peaks.`);
