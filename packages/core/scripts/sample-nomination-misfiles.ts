/**
 * Show, in the store's own words, WHAT a misfiled nomination actually matched.
 *
 * measure-nomination-size-bias.ts establishes that leave-one-out nomination sends most evidence to
 * a bigger concept, and that replacing max-over-observations with a top-2 mean does NOT fix it —
 * which rules out "a big concept won on one lucky outlier draw" as the mechanism. The remaining
 * explanation is that the big concepts genuinely contain near-neighbours for most of the corpus.
 * That is a claim about CONTENT, so it has to be read, not inferred: this prints the withheld
 * observation next to the observation that outscored its home.
 *
 * Read-only, sample-only, never mutates.
 */
import Database from "better-sqlite3";
import { cosine, isZeroVector, jsonToEmb } from "../src/embedding";

const DB = process.env.PROBE_DB!;
const SAMPLE = Number(process.env.SAMPLE ?? 8);
const CUT = Number(process.env.CUT ?? 100);
const clip = (s: string) => s.replace(/\s+/g, " ").slice(0, CUT);

const db = new Database(DB, { readonly: true });
const circle = (db.prepare(
  `SELECT circle, COUNT(*) n FROM concepts WHERE kind!='source' GROUP BY circle ORDER BY n DESC LIMIT 1`,
).get() as { circle: string }).circle;

const rows = db.prepare(
  `SELECT o.id, o.concept_id AS cid, o.embedding AS emb, o.content, c.slug
     FROM observations o JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
      AND o.kind != 'source' AND c.circle = ? AND c.kind != 'source'`,
).all(circle) as Array<{ id: string; cid: string; emb: string; content: string; slug: string }>;

interface Obs { id: string; cid: string; vec: Float32Array; content: string; slug: string }
const all: Obs[] = [];
for (const r of rows) {
  const vec = jsonToEmb(r.emb);
  if (isZeroVector(vec)) continue;
  all.push({ id: r.id, cid: r.cid, vec, content: r.content, slug: r.slug });
}
const size = new Map<string, number>();
for (const o of all) size.set(o.cid, (size.get(o.cid) ?? 0) + 1);

// Deterministic spread across the population — no clock, no RNG, reproducible run to run.
const probes = all.filter((o) => (size.get(o.cid) ?? 0) >= 2 && (size.get(o.cid) ?? 0) < 20);
const step = Math.max(1, Math.floor(probes.length / SAMPLE));

console.log(`circle=${circle}  population=${all.length} observations / ${size.size} concepts\n`);
let shown = 0;
for (let k = 0; k < probes.length && shown < SAMPLE; k += step) {
  const probe = probes[k];
  let best: { o: Obs; score: number } | null = null;
  let homeBest = -Infinity;
  for (const cand of all) {
    if (cand.id === probe.id) continue; // withheld
    const c = cosine(probe.vec, cand.vec);
    if (cand.cid === probe.cid && c > homeBest) homeBest = c;
    if (best === null || c > best.score) best = { o: cand, score: c };
  }
  if (best === null || best.o.cid === probe.cid) continue; // returned home — not a misfile
  shown++;
  console.log(`── misfile ${shown} ─────────────────────────────────────────────`);
  console.log(`  WITHHELD  [${probe.slug.slice(0, 34)} · ${size.get(probe.cid)} obs]`);
  console.log(`            ${clip(probe.content)}`);
  console.log(`  WON BY    [${best.o.slug.slice(0, 34)} · ${size.get(best.o.cid)} obs]  cos ${best.score.toFixed(4)}`);
  console.log(`            ${clip(best.o.content)}`);
  console.log(`  home best cos ${homeBest.toFixed(4)}   margin ${(best.score - homeBest).toFixed(4)}\n`);
}
db.close();
