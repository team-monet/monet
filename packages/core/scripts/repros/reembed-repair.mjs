// Repair pass: rewrite the embedding of every observation whose stored vector is NOT in the store's
// pinned space, using that observation's own `content` and the pinned model.
//
// Two populations, one cause (the 2026-07-18 model swap, monet-core#79):
//   - sparse-int vectors written by the hashing fallback during the download window
//   - dense vectors left behind in the previous model's space
// Both are 384-dim, so no dimension guard can see either; the only detector is re-embedding and
// comparing, which is also the repair.
//
// Scope is deliberately narrow: it touches `observations.embedding` and nothing else. Concept
// centroids are NOT recomputed — `blend()` normalizes at every step, so a centroid is path-dependent
// and cannot be reconstructed from its members; any "recompute" would be a new approximation, which
// is a judgment call and not part of a repair. Recall already ranks on observation vectors (the
// recall unit split), so this fixes retrieval directly; centroids serve resolution confirmation and
// are reported separately.
//
// Idempotent: a row already in the pinned space is verified and skipped. Safe to re-run.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { env, pipeline } from "@huggingface/transformers";

const DB = process.env.DB;
const IN_SPACE = 0.95;
const APPLY = process.env.APPLY === "1";

const q = (sql, ro = true) =>
  JSON.parse(execFileSync("sqlite3", ["-json", `file:${DB}${ro ? "?mode=ro" : ""}`, ".timeout 60000", sql], {
    maxBuffer: 1 << 30,
  }).toString() || "[]");

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

const pin = q(`SELECT embedder_model_id AS m FROM sync_meta WHERE singleton=1`)[0].m;
console.error(`store pin: ${pin}`);
// Fail closed rather than fetch (Codex review, PR #133): a probe that silently downloads a
// missing model mutates the cache it is measuring and breaks the no-network reproducibility
// this document claims. Set BEFORE any load.
env.allowRemoteModels = false;

const extract = await pipeline("feature-extraction", pin, { cache_dir: process.env.CACHE });

// Candidates: every sparse-int row (hashing, definitionally wrong space) plus every dense row the
// census flagged. Re-verified here rather than trusted, so the census cannot cause a bad write.
const censusIds = JSON.parse(process.env.FOREIGN_IDS_JSON).map((x) => `'${x.replace(/'/g, "''")}'`);
const ids = q(
  `SELECT id FROM observations WHERE instr(embedding,'.')=0 OR id IN (${censusIds.join(",")}) ORDER BY created_at`,
).map((r) => r.id);
console.error(`candidates: ${ids.length}${APPLY ? "" : "  (DRY RUN — no writes)"}`);

let repaired = 0, alreadyOk = 0, failed = 0;
const changed = [];
for (let i = 0; i < ids.length; i += 100) {
  const batch = ids.slice(i, i + 100).map((x) => `'${x.replace(/'/g, "''")}'`);
  const rows = q(`SELECT id, circle, content, embedding FROM observations WHERE id IN (${batch.join(",")})`);
  const updates = [];
  for (const r of rows) {
    try {
      const out = await extract(r.content, { pooling: "mean", normalize: true });
      const fresh = Array.from(out.data);
      if (cos(fresh, JSON.parse(r.embedding)) >= IN_SPACE) { alreadyOk++; continue; }
      // Round-trip through the same JSON shape the engine writes.
      updates.push([r.id, JSON.stringify(fresh)]);
      changed.push({ id: r.id, circle: r.circle });
    } catch (e) {
      failed++;
      console.error(`  FAILED ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (APPLY && updates.length) {
    const sql = "BEGIN IMMEDIATE;\n" +
      updates.map(([id, vec]) =>
        `UPDATE observations SET embedding='${vec}' WHERE id='${id.replace(/'/g, "''")}';`).join("\n") +
      "\nCOMMIT;";
    execFileSync("sqlite3", [DB, ".timeout 60000", sql]);
  }
  repaired += updates.length;
  console.error(`  ${Math.min(i + 100, ids.length)}/${ids.length} — repaired ${repaired}, already ok ${alreadyOk}, failed ${failed}`);
}

const byCircle = {};
for (const c of changed) byCircle[c.circle] = (byCircle[c.circle] ?? 0) + 1;
const summary = { pin, applied: APPLY, candidates: ids.length, repaired, alreadyOk, failed, byCircle };
writeFileSync(process.env.OUT, JSON.stringify({ summary, changed }, null, 2));
console.log(JSON.stringify(summary, null, 2));
