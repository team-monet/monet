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
import { cosine, isZeroVector, jsonToEmb, normalizeVector } from "../src/embedding";
import { blendLexical, lexicalOverlap, lexicalTokens, tokenIdf } from "../src/lexical-overlap";
import { printStoreHeader, requireTrustableSpace } from "./measure-header";

const DB = process.env.MONET_DB!;
const TAU = Number(process.env.TAU ?? "0.70");
const TAU_AMBIGUOUS = Number(process.env.TAU_AMBIGUOUS ?? "0.50");
const DELTAS = (process.env.DELTAS ?? "0,0.01,0.02,0.03,0.05,0.08,0.12,0.20")
  .split(",").map((s) => Number(s.trim()));

const db = new Database(DB, { readonly: true });
const storeSpace = printStoreHeader(db, DB);
// consumesStoredVectors=TRUE (the default): every figure below is scored from vectors read out
// of this store, so an unattributable one must abort before any measurement work happens.
requireTrustableSpace(storeSpace);
const circle = process.env.CIRCLE ?? (db.prepare(
  `SELECT circle, COUNT(*) n FROM concepts WHERE kind!='source' AND status!='retired' GROUP BY circle ORDER BY n DESC LIMIT 1`,
).get() as { circle: string }).circle;

const segmentRows = db.prepare(
  `SELECT o.concept_id AS cid, o.id AS oid, s.embedding AS emb
     FROM observation_segments s
     JOIN observations o ON o.id = s.observation_id
     JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.status != 'retired' AND c.circle = ?
    ORDER BY o.id, s.segment_index`,
).all(circle) as Array<{ cid: string; oid: string; emb: string }>;

const kindRows = db.prepare(
  `SELECT o.id AS oid, o.kind AS kind
     FROM observations o JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.status != 'retired' AND c.circle = ?`,
).all(circle) as Array<{ oid: string; kind: string | null }>;

const obsVecRows = db.prepare(
  `SELECT o.id AS oid, o.concept_id AS cid, o.embedding AS emb
     FROM observations o JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.status != 'retired' AND c.circle = ?`,
).all(circle) as Array<{ oid: string; cid: string; emb: string }>;

const contentRows = db.prepare(
  `SELECT o.id AS oid, o.content AS content
     FROM observations o JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.status != 'retired' AND c.circle = ?`,
).all(circle) as Array<{ oid: string; content: string }>;
db.close();

interface Obs { oid: string; cid: string; vecs: Float32Array[]; toks: Set<string>; whole?: Float32Array }
const byObs = new Map<string, Obs>();
// SEEDED FROM WHOLE-OBSERVATION ROWS, not from segments (Codex P2, round 4). A pre-backfill store
// holds observations with no `observation_segments` at all, and the production scorer explicitly
// falls back to `observations.embedding` for exactly those. Seeding from segments dropped them as
// probes AND as candidate evidence, so the sweep silently replayed a different corpus than the one
// the store resolves.
for (const r of obsVecRows) {
  const vec = jsonToEmb(r.emb);
  if (isZeroVector(vec)) continue;
  byObs.set(r.oid, { oid: r.oid, cid: r.cid, vecs: [], toks: new Set<string>(), whole: vec });
}
for (const r of segmentRows) {
  const vec = jsonToEmb(r.emb);
  if (isZeroVector(vec)) continue;
  byObs.get(r.oid)?.vecs.push(vec);
}
// The candidate unit falls back to the whole-observation vector where no segment exists.
for (const o of byObs.values()) if (o.vecs.length === 0 && o.whole !== undefined) o.vecs.push(o.whole);
for (const r of contentRows) {
  const entry = byObs.get(r.oid);
  if (entry !== undefined) entry.toks = lexicalTokens(r.content);
}
/**
 * NORMATIVE PROBES ARE OUT OF THE CALIBRATION (Codex P2, round 3, and John's declaration ruling).
 * The shipped path filters illegal landings — wrong species, another stage, a blocking or superseded
 * rule — before it looks at the margin, and this sweep cannot reproduce those without rule bindings
 * and supersession state. Counting them anyway prices an ineligible winner as a wrong merge where
 * production takes species-fork, and lets an ineligible runner-up inflate the ask rate.
 *
 * Excluding them is not a convenience: declarations are exempt from the gate outright, and the
 * remaining normative captures are the population whose landings the eligibility filter narrows
 * hardest. What is left is the population the threshold actually governs.
 */
const DECLARED_KINDS = new Set(["rule", "principle", "preference"]);
const kindOf = new Map(kindRows.map((r) => [r.oid, r.kind ?? ""]));
// EVERY live observation stays as candidate EVIDENCE. Filtering the set before `byConcept` is built
// removed normative rows from the corpus itself, changing max cosines, lexical overlap, centroids
// and even homeSize for ordinary probes — production's scorer and centroid recomputation read every
// live observation regardless of kind (Codex P2, round 4).
const observations = [...byObs.values()];
// Only the PROBE iteration narrows, and only to the kinds the gate cannot govern: rule, principle
// and preference arrive through `declare()`, which is exempt outright. CORRECTIONS ARE BACK IN —
// grouping them with declarations was wrong, since a correction landing on an ordinary concept has
// no fork reason and reaches the ask exactly like any other write (Codex P2, round 4).
const probeSet = observations.filter((o) => !DECLARED_KINDS.has(kindOf.get(o.oid) ?? ""));
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

/**
 * The scorer's own statistic: the incoming observation's WHOLE-CONTENT vector against each stored
 * segment, max over the segments.
 *
 * NOT max over the probe's segments too (Codex P1, round 3). storeInternal embeds the content once
 * (`checkedEmbed`) and hands that single vector to scoreNativeConceptsByObservation, which cosines
 * it against stored segment vectors — so letting any probe segment win measures a comparison the
 * store never makes, and it can move the winner, the tauAttach verdict and especially the margin.
 * measure-attach-thresholds.ts has the same shape and the same defect; re-deriving tauAttach is a
 * separate exercise from this one.
 */
const best = (probe: Obs, other: Obs): number => {
  const p = probe.whole;
  if (p === undefined) return -Infinity;
  let m = -Infinity;
  for (const y of other.vecs) { const c = cosine(p, y); if (c > m) m = c; }
  return m;
};

/** One probe's full candidate table, computed ONCE; every sweep below is arithmetic over it. */
/**
 * The concept's centroid with the probe WITHHELD — what the shipped decision confirms against, and
 * what the first draft of this script omitted entirely (Codex P1, PR #87). `concepts.embedding` is
 * the blend of everything the concept has absorbed INCLUDING the probe, so reading it would leak the
 * withheld observation back into its own confirmation. recomputeNativeConceptProjection derives a
 * native concept's vector by centroiding its live observations, so the mean of the survivors is the
 * reconstruction of that same quantity.
 *
 * NORMALIZED, and it was not before (findings 2026-08-25 §3.1). `cosine` below is a bare dot
 * product, so an un-normalised mean prices every `centroid` column SHORT — a mean of members that
 * disagree is under 1.0 long, and on monet-hq's own concepts that deflation ran to ~24%. The
 * engine's recompute carried the identical omission and now normalizes too, so this reconstruction
 * and the quantity it reconstructs stay the same thing. Centroid columns from runs BEFORE this
 * change are not comparable with runs after it.
 */
const centroidWithout = (members: Obs[], excludeOid: string): Float32Array | null => {
  const vecs = members.filter((m) => m.oid !== excludeOid && m.whole !== undefined).map((m) => m.whole!);
  if (vecs.length === 0) return null;
  const out = new Float32Array(vecs[0]!.length);
  for (const v of vecs) for (let i = 0; i < out.length; i++) out[i]! += v[i]!;
  for (let i = 0; i < out.length; i++) out[i]! /= vecs.length;
  return normalizeVector(out);
};

interface Candidate { cid: string; score: number; rank: number; centroid: number }
interface Probe { homeCid: string; homeSize: number; candidates: Candidate[] }
const probes: Probe[] = [];
for (const probe of probeSet) {
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
    const c = centroidWithout(members, probe.oid);
    const probeWhole = probe.whole;
    candidates.push({
      cid,
      score: bestCos,
      rank: blendLexical(bestCos, bestOverlap),
      centroid: c !== null && probeWhole !== undefined ? cosine(probeWhole, c) : -Infinity,
    });
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
    // THE SHIPPED ORDER: tauAttach, then the centroid confirmation, then the margin. Skipping the
    // middle one counted fork-signal cases as attaches and contaminated every column.
    if (r[0]!.score < TAU || r[0]!.centroid < TAU_AMBIGUOUS || sep < delta) fork++;
    else if (r[0]!.cid === p.homeCid) right++;
    else wrong++;
  }
  for (const p of noHome) {
    const r = ranked(p, true);
    if (r.length === 0) { created++; continue; }
    const sep = r[1] !== undefined ? r[0]!.rank - r[1]!.rank : Infinity;
    if (r[0]!.score >= TAU && r[0]!.centroid >= TAU_AMBIGUOUS && sep >= delta) absorbed++;
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
