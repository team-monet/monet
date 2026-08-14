// THE load-bearing experiment behind the bounded retrieval unit: does cosine
// discrimination collapse as text gets longer?
//
// Committed because the design leans on its output twice — to keep the thresholds (they measure
// correct on short text) and to pick a segment budget under the model window. Numbers quoted in a
// document nobody can re-run are assertions, not evidence.
//
// Method. Sample live observations, bin them by character length, and within each bin score random
// pairs drawn from DIFFERENT circles. Cross-circle is a proxy for "unrelated", not ground truth —
// this store is one person's work on adjacent problems, so some cross-circle pairs are genuinely
// related and the unrelated tail is somewhat overstated. Stated rather than hidden; it does not
// explain a rate that goes from 0% to 93% across bins.
//
// Deterministic: fixed seed, fixed bins, fixed pair budget. Read-only, no network.
//   PROBE_DB=~/.monet/monet.db PROBE_CACHE=~/.monet/models node scripts/repros/length-bands.mjs
import { execFileSync } from "node:child_process";
import { env, pipeline } from "@huggingface/transformers";

env.allowRemoteModels = false; // fail closed rather than fetch — see the other probes

const DB = process.env.PROBE_DB;
const TAU_ATTACH = Number(process.env.TAU_ATTACH ?? 0.72);
const SAMPLE = Number(process.env.SAMPLE ?? 1200);
const PAIRS_PER_BAND = Number(process.env.PAIRS_PER_BAND ?? 600);
const SEED = Number(process.env.SEED ?? 11);

const BANDS = [
  [0, 300, "< 300 chars"],
  [300, 1000, "300 - 1k"],
  [1000, 3000, "1k - 3k"],
  [3000, Number.MAX_SAFE_INTEGER, "> 3k"],
];

// Deterministic PRNG — Math.random() would make the reported percentiles unreproducible.
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

const rows = JSON.parse(
  execFileSync("sqlite3", [
    "-json", `file:${DB}?mode=ro`, ".timeout 30000",
    // Live rows only, by the engine's OWN predicate (Codex review, PR #133): a terminally retired
    // observation keeps superseded_by NULL and sets superseded_at, so the shorter test lets history
    // into a sample described as live. Verified against this store: it changes 5 rows of 4,044 and
    // moved none of the figures below, but a probe cited for load-bearing numbers should not depend
    // on that being true.
    `SELECT id, circle, length(content) AS len, content, embedding FROM observations
      WHERE superseded_by IS NULL AND superseded_at IS NULL AND instr(embedding,'.')>0
      ORDER BY id LIMIT ${SAMPLE}`,
  ], { maxBuffer: 1 << 30 }).toString() || "[]",
).map((r) => ({ ...r, v: JSON.parse(r.embedding) }));

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

// VERIFY THE SPACE BEFORE MEASURING IT (Codex review, PR #133). A store can hold dense vectors from
// a PREVIOUS model — the population space-scan.mjs exists to find — and a cosine between two model
// spaces is not a similarity, it is noise. Measuring length bands over such a store would attribute
// model-space contamination to text length and drive the segment budget from a corrupted table.
// Re-embedding every sampled row is the only way to know, and it is also the repair, so the probe
// simply refuses to report until the sample is verified in the pinned space.
const IN_SPACE = 0.95;
const extract = await pipeline("feature-extraction", process.env.MODEL ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2", {
  cache_dir: process.env.PROBE_CACHE,
});
const foreign = [];
for (const r of rows) {
  const out = await extract(r.content, { pooling: "mean", normalize: true });
  if (cos(Array.from(out.data), r.v) < IN_SPACE) foreign.push(r.id);
}
if (foreign.length > 0) {
  console.error(
    `REFUSING TO REPORT: ${foreign.length} of ${rows.length} sampled rows are not in the pinned vector ` +
    `space. Cosines across model spaces are noise, and this table is cited as evidence. Run ` +
    `scripts/repros/reembed-repair.mjs first, or restrict the sample.`,
  );
  process.exit(1);
}
console.log(`space check: all ${rows.length} sampled rows verified in the pinned space\n`);

console.log(`sampled ${rows.length} live dense observations; tauAttach=${TAU_ATTACH}; seed=${SEED}\n`);
console.log(`${"band".padEnd(14)}${"n".padStart(6)}${"median".padStart(9)}${"p95".padStart(8)}${">=tauAttach".padStart(13)}`);
for (const [lo, hi, label] of BANDS) {
  const pool = rows.filter((r) => r.len >= lo && r.len < hi);
  const rand = mulberry32(SEED);
  const scores = [];
  for (let tries = 0; tries < PAIRS_PER_BAND * 20 && scores.length < PAIRS_PER_BAND; tries++) {
    const a = pool[Math.floor(rand() * pool.length)];
    const b = pool[Math.floor(rand() * pool.length)];
    if (!a || !b || a === b || a.circle === b.circle) continue;
    scores.push(cos(a.v, b.v));
  }
  if (scores.length < 30) { console.log(`${label.padEnd(14)}${String(scores.length).padStart(6)}   (too few cross-circle pairs)`); continue; }
  const s = scores.sort((x, y) => x - y);
  const rate = (s.filter((x) => x >= TAU_ATTACH).length / s.length) * 100;
  console.log(
    `${label.padEnd(14)}${String(s.length).padStart(6)}${pct(s, 0.5).toFixed(3).padStart(9)}` +
    `${pct(s, 0.95).toFixed(3).padStart(8)}${(rate.toFixed(1) + "%").padStart(13)}`,
  );
}
