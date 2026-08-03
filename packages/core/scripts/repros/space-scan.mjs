// Full census of the live store's DENSE vectors against the pinned model's space.
// A row whose re-embedded content does NOT reproduce its stored vector is in a
// FOREIGN space — invisible to every dimension guard, because both spaces are 384-dim.
// Read-only: opens the DB in ro mode and never writes.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { env, pipeline } from "@huggingface/transformers";

env.cacheDir = process.env.PROBE_CACHE;
env.allowRemoteModels = false; // must not open a download window while probing

const DB = process.env.PROBE_DB;
const OUT = process.env.PROBE_OUT;
const IN_SPACE = 0.95;

const q = (sql) =>
  JSON.parse(execFileSync("sqlite3", ["-json", `file:${DB}?mode=ro`, ".timeout 30000", sql], {
    maxBuffer: 1 << 30,
  }).toString() || "[]");

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

const ids = q(`SELECT id FROM observations WHERE instr(embedding,'.')>0 ORDER BY created_at`).map((r) => r.id);
console.error(`dense rows to probe: ${ids.length}`);

const extract = await pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2");

const foreign = [];
let done = 0, inSpace = 0;
for (let i = 0; i < ids.length; i += 200) {
  const batch = ids.slice(i, i + 200);
  const rows = q(
    `SELECT id, circle, created_at, content, embedding FROM observations WHERE id IN (${
      batch.map((x) => `'${x.replace(/'/g, "''")}'`).join(",")
    })`,
  );
  for (const r of rows) {
    const out = await extract(r.content, { pooling: "mean", normalize: true });
    const s = cos(Array.from(out.data), JSON.parse(r.embedding));
    if (s >= IN_SPACE) inSpace++;
    else foreign.push({ id: r.id, circle: r.circle, created_at: r.created_at, score: Number(s.toFixed(4)) });
    done++;
  }
  console.error(`  ${done}/${ids.length} probed — foreign so far: ${foreign.length}`);
}

const byCircle = {};
for (const f of foreign) {
  const d = new Date(f.created_at).toISOString().slice(0, 10);
  byCircle[f.circle] ??= { n: 0, first: d, last: d };
  const b = byCircle[f.circle];
  b.n++;
  if (d < b.first) b.first = d;
  if (d > b.last) b.last = d;
}
const summary = { probed: done, inSpace, foreign: foreign.length, byCircle };
writeFileSync(OUT, JSON.stringify({ summary, foreign }, null, 2));
console.log(JSON.stringify(summary, null, 2));
