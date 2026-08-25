/**
 * HOW MUCH SEPARABILITY IS RECOVERABLE BY CHANGING WHAT WE EMBED? The ceiling measurement for
 * input normalization, run on the live store in the shipping embedding space.
 *
 * WHY THIS EXISTS. measure-threshold-headroom.ts establishes that on the live corpus the
 * SAME-concept and CROSS-concept observation-pair cosine distributions OVERLAP — CROSS p95 sits
 * above SAME p05 — so no choice of tauAttach separates them and store-time resolution is deciding
 * on margins of ~0.01. A threshold cannot fix a signal that carries no separation. The open
 * question is whether the signal is weak because of the EMBEDDER, or because of WHAT WE FEED IT:
 * native observations are embedded WHOLE (mean 1,583 chars here, p95 3,138, model window 512
 * tokens), so every vector is a heavy mean-pool over a long document whose opening is the same
 * shared scaffolding in every row — an ALL-CAPS header, a parenthetical of dates and actor names —
 * and the p95 row is truncated mid-document besides.
 *
 * Note what the codebase already ratified for the OTHER half of the store: #54 chunks source files
 * into per-section retrieval units and scores MAX over chunks, and src/retrieval.ts states native
 * and source "now share ONE retrieval architecture". They do not share it at the INPUT: native
 * observations are still one vector per whole observation. `chunked` below is that ratified shape
 * applied natively, and it is the variant with a real shipping story behind it.
 *
 * THE METRIC: AUC — the probability that a randomly chosen SAME-concept pair outscores a randomly
 * chosen CROSS-concept pair (Mann-Whitney U / rank-sum, computed exactly, not sampled). It is
 * threshold-free, which is the point: the previous measurement showed that no threshold works, so
 * the ceiling has to be measured in a way that does not presuppose one. 0.5 = the signal carries no
 * information about whether two observations belong together; 1.0 = perfectly separable.
 *
 * READ THE DELTA, NOT THE ABSOLUTE. The SAME/CROSS labels come from the store's own concept
 * assignment, which is exactly what is under suspicion: an over-absorbed concept contributes
 * genuinely-unrelated pairs labeled SAME, and a duplicate pair contributes genuinely-same pairs
 * labeled CROSS. Both drag absolute AUC toward 0.5, so the absolute number is a LOWER BOUND on
 * what clean labels would show. The labels are IDENTICAL across variants, however, so the
 * DIFFERENCE between variants is not contaminated by that — and the difference is the ceiling this
 * script exists to measure.
 *
 * Read-only on a store snapshot; re-embeds in memory, writes nothing, mutates nothing.
 */
import Database from "better-sqlite3";
import { cosine, type EmbeddingProvider } from "../src/embedding";
import { printEmbedderHeader, printStoreHeader, requireTrustableSpace } from "./measure-header";

const DB = process.env.PROBE_DB!;
/** Cross-concept pairs sampled on a fixed stride (no clock, no RNG). Same budget for every variant
 *  so the AUC comparison is like-for-like; the chunked variant costs chunks×chunks per pair. */
const MAX_CROSS = Number(process.env.MAX_CROSS ?? 40_000);
const HEAD_CHARS = Number(process.env.HEAD_CHARS ?? 400);
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS ?? 350);

/**
 * Strip the shared scaffolding every observation opens with: a leading ALL-CAPS run (the header),
 * and a leading parenthetical (the "(actor, date, context)" clause). Deliberately conservative —
 * it only touches the OPENING, never the body, so anything it removes is structure rather than
 * content. Purely a measurement transform; nothing here is proposed for the write path as-is.
 */
function stripPreamble(text: string): string {
  let s = text.replace(/^[^a-z]{12,}?(?=[a-z])/u, ""); // leading caps/punct/digit run before the first lowercase
  s = s.replace(/^\s*\([^)]{0,200}\)\s*/u, "");        // a leading parenthetical, if one survives
  return s.trim() || text.trim();                       // never hand back an empty string
}

/**
 * Pack sentences into ~CHUNK_CHARS units. Not src/source-chunker.ts: that splits MARKDOWN BY
 * HEADING, which is the right unit for a file and the wrong one for a single prose observation
 * that has no headings at all.
 */
function chunk(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+|\n+/u).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (cur && cur.length + p.length + 1 > CHUNK_CHARS) { out.push(cur); cur = p; }
    else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) out.push(cur);
  return out.length ? out : [text.slice(0, CHUNK_CHARS)];
}

const VARIANTS: Array<{ name: string; note: string; parts: (t: string) => string[] }> = [
  { name: "stored", note: "whole observation, one vector — SHIPPING", parts: (t) => [t] },
  { name: "head", note: `first ${HEAD_CHARS} chars`, parts: (t) => [t.slice(0, HEAD_CHARS)] },
  { name: "no-preamble", note: "header + leading parenthetical removed", parts: (t) => [stripPreamble(t)] },
  { name: "chunked", note: `~${CHUNK_CHARS}-char chunks, pair score = MAX over chunk pairs (#54 shape)`, parts: chunk },
];

/** Exact Mann-Whitney AUC with tie correction: P(same > cross) + 0.5*P(same == cross). */
function auc(same: number[], cross: number[]): number {
  const tagged = [...same.map((v) => [v, 1] as const), ...cross.map((v) => [v, 0] as const)]
    .sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  for (let i = 0; i < tagged.length; ) {
    let j = i;
    while (j + 1 < tagged.length && tagged[j + 1][0] === tagged[i][0]) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based, averaged across the tie block
    for (let k = i; k <= j; k++) if (tagged[k][1] === 1) rankSum += avgRank;
    i = j + 1;
  }
  const n1 = same.length, n2 = cross.length;
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n2);
}

const pctl = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];

async function main() {
  const db = new Database(DB, { readonly: true });
  const storeSpace = printStoreHeader(db, DB);
  // consumesStoredVectors=FALSE: the query below selects `o.content` and no embedding column, the
  // handle is closed before the model loads, and every vector scored is produced here from text. A
  // mixed store cannot reach these numbers, so an unattributable one is reported and not refused.
  requireTrustableSpace(storeSpace, false);
  const circle = (db.prepare(
    `SELECT circle, COUNT(*) n FROM concepts WHERE kind!='source' GROUP BY circle ORDER BY n DESC LIMIT 1`,
  ).get() as { circle: string }).circle;
  const rows = db.prepare(
    `SELECT o.concept_id AS cid, o.content AS content
       FROM observations o JOIN concepts c ON c.id = o.concept_id
      WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL
        AND o.kind != 'source' AND c.circle = ? AND c.kind != 'source'
      ORDER BY o.id`,
  ).all(circle) as Array<{ cid: string; content: string }>;
  db.close();

  const { OnnxEmbeddingProvider } = await import("../src/embedding-onnx");
  const onnx: EmbeddingProvider = new OnnxEmbeddingProvider();
  const warmup = await onnx.embed("warmup"); // kept for its LENGTH — see printEmbedderHeader
  const th = onnx.recommendedThresholds;

  console.log(`circle=${circle}   ${rows.length} observations, ${new Set(rows.map((r) => r.cid)).size} concepts`);
  // BOTH SIDES ARE EMBEDDED FROM TEXT here: the query above selects `o.content` and no embedding
  // column, and the handle is closed before the model loads. No stored vector is ever read, so the
  // results are wholly in the loaded space — the store supplies the corpus, not the vectors.
  printEmbedderHeader(storeSpace, onnx, "replaces-stored-vectors", warmup.length);
  console.log(`tauAttach=${th?.tauAttach}  cross-pair budget=${MAX_CROSS}\n`);

  // Which (i, j) pairs to score — decided ONCE so every variant is measured on identical pairs.
  const samePairs: Array<[number, number]> = [];
  const crossAll: Array<[number, number]> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      (rows[i].cid === rows[j].cid ? samePairs : crossAll).push([i, j]);
    }
  }
  const stride = Math.max(1, Math.ceil(crossAll.length / MAX_CROSS));
  const crossPairs = crossAll.filter((_, k) => k % stride === 0);
  console.log(`pairs: ${samePairs.length} same-concept, ${crossPairs.length} cross-concept (stride ${stride} of ${crossAll.length})\n`);

  /**
   * THE CLEAN-LABEL CONTROL, and the reason this script can distinguish two very different fixes.
   *
   * A weak AUC has two candidate explanations that call for opposite work: the EMBEDDER cannot
   * discriminate this corpus (fix the signal), or the LABELS are polluted because over-absorbed
   * concepts contribute genuinely-unrelated pairs marked SAME (fix the corpus). Restricting to
   * pairs where BOTH observations live in a small concept removes most of the second: a concept
   * that never over-absorbed is one whose members really do belong together.
   *
   * If AUC rises sharply on this subset the signal is fine and the blobs are the problem. If it
   * does not move, the embedding space genuinely does not separate this corpus and no amount of
   * corpus surgery will make a cosine threshold reliable.
   */
  const CLEAN_MAX = Number(process.env.CLEAN_MAX ?? 10);
  const conceptSize = new Map<string, number>();
  for (const r of rows) conceptSize.set(r.cid, (conceptSize.get(r.cid) ?? 0) + 1);
  const isClean = (p: [number, number]) =>
    (conceptSize.get(rows[p[0]].cid) ?? 0) < CLEAN_MAX && (conceptSize.get(rows[p[1]].cid) ?? 0) < CLEAN_MAX;
  const sameClean = samePairs.filter(isClean);
  const crossClean = crossPairs.filter(isClean);
  console.log(`clean subset (both concepts < ${CLEAN_MAX} obs): ${sameClean.length} same, ${crossClean.length} cross\n`);

  const only = process.env.ONLY_VARIANTS?.split(",").map((s) => s.trim());
  const selected = only ? VARIANTS.filter((v) => only.includes(v.name)) : VARIANTS;

  console.log(`  variant       AUC      AUC(clean)  SAME p50   CROSS p50   CROSS>=tau   separating window?`);
  const results: Array<{ name: string; auc: number }> = [];

  for (const variant of selected) {
    // Embed every part of every observation once. Cache by text: identical parts are common.
    const cache = new Map<string, Float32Array>();
    const vecs: Float32Array[][] = [];
    for (const row of rows) {
      const parts = variant.parts(row.content);
      const embedded: Float32Array[] = [];
      for (const part of parts) {
        let v = cache.get(part);
        if (v === undefined) { v = await onnx.embed(part); cache.set(part, v); }
        embedded.push(v);
      }
      vecs.push(embedded);
    }
    // Pair score: MAX over the cross product of the two observations' parts. For single-part
    // variants that is exactly the plain observation-vs-observation cosine shipping uses today.
    const score = (a: number, b: number): number => {
      let m = -Infinity;
      for (const x of vecs[a]) for (const y of vecs[b]) { const c = cosine(x, y); if (c > m) m = c; }
      return m;
    };
    const same = samePairs.map(([a, b]) => score(a, b)).sort((x, y) => x - y);
    const cross = crossPairs.map(([a, b]) => score(a, b)).sort((x, y) => x - y);
    const a = auc(same, cross);
    const aClean = auc(
      sameClean.map(([x, y]) => score(x, y)).sort((p, q) => p - q),
      crossClean.map(([x, y]) => score(x, y)).sort((p, q) => p - q),
    );
    results.push({ name: variant.name, auc: a });
    const overTau = th ? `${((cross.filter((c) => c >= th.tauAttach).length / cross.length) * 100).toFixed(1)}%` : "-";
    const window = pctl(cross, 0.95) < pctl(same, 0.05) ? "YES" : "no (overlap)";
    console.log(`  ${variant.name.padEnd(13)} ${a.toFixed(4)}   ${aClean.toFixed(4)}      ${pctl(same, 0.5).toFixed(4)}     ${pctl(cross, 0.5).toFixed(4)}      ${overTau.padStart(6)}       ${window}`);
  }

  const base = results.find((r) => r.name === "stored")!.auc;
  console.log(`\n  CEILING — change in separability vs the shipping input:`);
  for (const r of results) {
    if (r.name === "stored") continue;
    const lift = r.auc - base;
    const closed = ((lift / (1 - base)) * 100).toFixed(1);
    console.log(`  ${r.name.padEnd(13)} ${lift >= 0 ? "+" : ""}${lift.toFixed(4)} AUC  (${closed}% of the gap to perfect separation)`);
  }
  for (const v of VARIANTS) console.log(`\n  ${v.name}: ${v.note}`);
}
void main();
