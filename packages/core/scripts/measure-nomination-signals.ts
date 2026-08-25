/**
 * WOULD A SECOND SIGNAL PICK THE RIGHT CONCEPT WHERE COSINE CANNOT? (#155)
 *
 *   MONET_DB=/path/to/backfilled.db npx tsx scripts/measure-nomination-signals.ts
 *
 * WHY MEASURE BEFORE BUILDING. Two proxies already misled this issue. `top2mean` was supposed to
 * kill an extreme-value bias and moved argmax accuracy 42.1% -> 43.8%. A clean-label AUC of 0.9119
 * was supposed to mean segmenting would fix nomination, and it landed at 46.7% — because AUC scores
 * PAIRWISE ranking while nomination is top-1 over hundreds of concepts. Both looked like the
 * decision and were measured beside it. So this scores candidate signals on the decision itself:
 * leave-one-out replay, argmax over every concept in the circle, "did it come home".
 *
 * THE SIGNALS
 *   cosine    MAX cosine over the candidate concept's segment vectors — what ships today.
 *   entity    Weighted Jaccard over extracted entities. The probe's own contribution is REMOVED
 *             from its home concept before scoring (see below), so home earns nothing for free.
 *   lexical   Weighted overlap of content tokens, IDF-style: a term shared by few concepts counts
 *             for more than one shared by many. A cheap discriminator that needs no extraction.
 *   hybrid    cosine rescored by the second signal.
 *
 * THE LEAKAGE THIS AVOIDS. `concept_entities` is CONCEPT-level and already contains whatever the
 * probe observation contributed, so overlapping against it would let every probe recognise its own
 * fingerprint and report a triumphant, meaningless score. Entity sets are therefore rebuilt here
 * per observation and unioned per concept with the withheld observation excluded — the same
 * discipline the cosine arm gets from dropping the probe's own segments.
 *
 * Read-only. Reports only; changes nothing.
 */
import Database from "better-sqlite3";
import { cosine, isZeroVector, jsonToEmb } from "../src/embedding";
import { extractEntities } from "../src/extract-entities";
import { printStoreHeader, requireTrustableSpace } from "./measure-header";

const DB = process.env.MONET_DB!;
const db = new Database(DB, { readonly: true });
const storeSpace = printStoreHeader(db, DB);
// consumesStoredVectors=TRUE (the default): every figure below is scored from vectors read out
// of this store, so an unattributable one must abort before any measurement work happens.
requireTrustableSpace(storeSpace);
const circle = (db.prepare(
  `SELECT circle, COUNT(*) n FROM concepts WHERE kind!='source' GROUP BY circle ORDER BY n DESC LIMIT 1`,
).get() as { circle: string }).circle;

const obsRows = db.prepare(
  `SELECT o.id AS oid, o.concept_id AS cid, o.content AS content
     FROM observations o JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.circle = ?`,
).all(circle) as Array<{ oid: string; cid: string; content: string }>;

const segRows = db.prepare(
  `SELECT s.observation_id AS oid, s.embedding AS emb FROM observation_segments s
     JOIN observations o ON o.id = s.observation_id
     JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.kind != 'source' AND c.circle = ?`,
).all(circle) as Array<{ oid: string; emb: string }>;
db.close();

const TOKEN = /[a-z0-9][a-z0-9_-]{2,}/gu;
const tokensOf = (text: string): Set<string> => new Set(text.toLowerCase().match(TOKEN) ?? []);

interface Obs { oid: string; cid: string; vecs: Float32Array[]; ents: Map<string, number>; toks: Set<string> }
const byObs = new Map<string, Obs>();
for (const r of obsRows) {
  const ents = new Map<string, number>();
  for (const e of extractEntities(r.content)) ents.set(e.key, Math.max(ents.get(e.key) ?? 0, e.weight));
  byObs.set(r.oid, { oid: r.oid, cid: r.cid, vecs: [], ents, toks: tokensOf(r.content) });
}
for (const r of segRows) {
  const vec = jsonToEmb(r.emb);
  if (!isZeroVector(vec)) byObs.get(r.oid)?.vecs.push(vec);
}
const observations = [...byObs.values()].filter((o) => o.vecs.length > 0);
const byConcept = new Map<string, Obs[]>();
for (const o of observations) byConcept.set(o.cid, [...(byConcept.get(o.cid) ?? []), o]);

// Document frequency over CONCEPTS, so a term everything mentions cannot decide anything.
const conceptCount = byConcept.size;
const df = new Map<string, number>();
for (const members of byConcept.values()) {
  const seen = new Set<string>();
  for (const m of members) for (const t of m.toks) seen.add(t);
  for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
}
const idf = (t: string): number => Math.log(conceptCount / (1 + (df.get(t) ?? 0)));

console.log(`circle=${circle}   ${observations.length} observations / ${conceptCount} concepts`);
console.log(`entities: ${new Set([...observations.flatMap((o) => [...o.ents.keys()])]).size} distinct\n`);

const STRATEGIES = ["cosine", "entity", "lexical", "cos+entity", "cos*(1+0.15L)", "cos*(1+0.25L)", "cos*(1+0.35L)", "cos*(1+0.5L)", "cos*(1+1L)", "cos*(1+2L)", "cos*(1+4L)", "lex*(1+cos)", "0.5cos+0.5lex", "0.3cos+0.7lex"] as const;
type Strategy = (typeof STRATEGIES)[number];
const hits = new Map<Strategy, number>(STRATEGIES.map((s) => [s, 0]));
let evaluated = 0;

for (const probe of observations) {
  const homeMembers = byConcept.get(probe.cid) ?? [];
  if (homeMembers.length < 2) continue; // un-nominatable once withheld
  evaluated++;

  const winners = new Map<Strategy, { cid: string; score: number }>();
  for (const [cid, members] of byConcept) {
    const others = members.filter((m) => m.oid !== probe.oid); // withheld — no self-credit anywhere
    if (others.length === 0) continue;

    let cos = -Infinity;
    for (const other of others) for (const x of probe.vecs) for (const y of other.vecs) {
      const c = cosine(x, y); if (c > cos) cos = c;
    }

    // Entity set rebuilt from the REMAINING observations only, so the probe's own fingerprint is gone.
    const cEnts = new Map<string, number>();
    for (const other of others) for (const [k, w] of other.ents) cEnts.set(k, Math.max(cEnts.get(k) ?? 0, w));
    let inter = 0, union = 0;
    for (const [k, w] of probe.ents) { if (cEnts.has(k)) inter += w; union += w; }
    for (const [k, w] of cEnts) if (!probe.ents.has(k)) union += w;
    const ent = union === 0 ? 0 : inter / union;

    // Observation-unit MAX, matching the shipped applyLexicalArm. A concept-union overlap grows with
    // concept size until a large concept overlaps everything, which is the size bias #155 removes.
    let lex = 0;
    for (const other of others) {
      let num = 0, den = 0;
      for (const t of probe.toks) { const w = idf(t); den += w; if (other.toks.has(t)) num += w; }
      const o = den === 0 ? 0 : num / den;
      if (o > lex) lex = o;
    }

    const scores: Record<Strategy, number> = {
      cosine: cos,
      entity: ent,
      lexical: lex,
      "cos+entity": cos * (1 + ent),
      "cos*(1+0.15L)": cos * (1 + 0.15 * lex),
      "cos*(1+0.25L)": cos * (1 + 0.25 * lex),
      "cos*(1+0.35L)": cos * (1 + 0.35 * lex),
      "cos*(1+0.5L)": cos * (1 + 0.5 * lex),
      "cos*(1+1L)": cos * (1 + lex),
      "cos*(1+2L)": cos * (1 + 2 * lex),
      "cos*(1+4L)": cos * (1 + 4 * lex),
      "lex*(1+cos)": lex * (1 + cos),
      "0.5cos+0.5lex": 0.5 * cos + 0.5 * lex,
      "0.3cos+0.7lex": 0.3 * cos + 0.7 * lex,
    };
    for (const s of STRATEGIES) {
      const prior = winners.get(s);
      if (prior === undefined || scores[s] > prior.score || (scores[s] === prior.score && cid < prior.cid)) {
        winners.set(s, { cid, score: scores[s] });
      }
    }
  }
  for (const s of STRATEGIES) if (winners.get(s)?.cid === probe.cid) hits.set(s, (hits.get(s) ?? 0) + 1);
}

console.log(`replayed ${evaluated} observations (concepts of size >= 2)\n`);
console.log(`  signal          returned home`);
for (const s of STRATEGIES) {
  console.log(`  ${s.padEnd(14)}  ${`${(((hits.get(s) ?? 0) / evaluated) * 100).toFixed(1)}%`.padStart(6)}`);
}
console.log(`\n  Top-1 over ${conceptCount} concepts is the decision nomination actually makes.`);
console.log(`  A signal that does not move this number does not fix the misfiling, whatever it`);
console.log(`  does to a pairwise or distributional score.`);
