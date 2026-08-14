/**
 * Threshold recalibration report for the multilingual embedding swap (item 9, ratified).
 *
 * OnnxEmbeddingProvider's default model moved all-MiniLM-L6-v2 -> paraphrase-multilingual-
 * MiniLM-L12-v2 (embedding-onnx.ts) so non-English content stops silently degrading. The two
 * models' cosine distributions are NOT the same, so the recommendedThresholds calibrated for the
 * old model (tauAttach=0.72, tauAmbiguous=0.5 — see embedding-onnx.ts's own "STALE PENDING
 * RECALIBRATION" comment) are not assumed valid for the new one. This script:
 *
 *   1. Reproduces embed-check.ts's own curated near-dup/paraphrase/related/unrelated English
 *      sentence categories under BOTH models side by side — a controlled, directly comparable
 *      baseline against the existing (already-validated) thresholds' own derivation methodology.
 *   2. Samples REAL content from a store (concept titles/bodies) under the NEW model only, for
 *      grounding beyond curated English sentences — this repo's real corpus is heavily Korean/
 *      English-mixed, exactly the case the swap targets and the curated set can't exercise:
 *        - "distinct": random cross-concept pairs (different files entirely).
 *        - "same-file section": chunk pairs from the SAME file/concept, different headings —
 *          topically related, not near-duplicate; a realistic "should NOT merge" upper bound.
 *   3. Reports percentile summaries per category and a recommended tauAttach/tauAmbiguous,
 *      mirroring the existing thresholds' own placement logic (tauAttach just under the
 *      high-similarity category's low end; tauAmbiguous well above the distinct category's high
 *      end — ADR's conservative-dedup rule: prefer a duplicate over a bad merge).
 *
 * REPORT ONLY. Nothing here writes to recommendedThresholds or any store — the recommendation is
 * a decision for the John gate, not an automatic change.
 *
 * Usage:
 *   tsx scripts/recalibrate-embedding-thresholds.ts [db-path]
 *   (db-path optional — omit to run the curated-sentence baseline only, no real-data sampling)
 */
import Database from "better-sqlite3";
import { cosine } from "../src/embedding";
import { OnnxEmbeddingProvider } from "../src/embedding-onnx";

const OLD_MODEL = "Xenova/all-MiniLM-L6-v2";
const NEW_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

const BASE = "We decided to use SQLite as the storage backend for Monet Local.";
const CURATED: Array<[string, string]> = [
  ["near-dup", "Monet Local uses SQLite for its local storage backend."],
  ["paraphrase", "Monet Local persists its data in an embedded SQL database file."],
  ["related", "The local runtime keeps memories in a file on disk."],
  ["unrelated", "The team prefers pytest with httpx for Python testing."],
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

function summarize(label: string, values: number[]): void {
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    `  ${label.padEnd(18)} n=${String(sorted.length).padEnd(5)} ` +
      `min=${percentile(sorted, 0).toFixed(3)} p25=${percentile(sorted, 0.25).toFixed(3)} ` +
      `median=${percentile(sorted, 0.5).toFixed(3)} p75=${percentile(sorted, 0.75).toFixed(3)} ` +
      `max=${percentile(sorted, 1).toFixed(3)}`,
  );
}

async function runCuratedBaseline(): Promise<void> {
  console.log("=== Part 1: curated English sentence categories (embed-check.ts's own set) ===\n");
  for (const [modelLabel, modelId] of [["OLD (all-MiniLM-L6-v2)", OLD_MODEL], ["NEW (paraphrase-multilingual-MiniLM-L12-v2)", NEW_MODEL]] as const) {
    const embedder = new OnnxEmbeddingProvider({ model: modelId });
    console.log(`${modelLabel}:`);
    const base = await embedder.embed(BASE);
    for (const [label, text] of CURATED) {
      const v = await embedder.embed(text);
      console.log(`  ${label.padEnd(11)} cosine = ${cosine(base, v).toFixed(3)}   "${text}"`);
    }
    console.log("");
  }
}

interface ConceptRow {
  id: string;
  title: string;
  body: string;
}

function sampleRealConcepts(dbPath: string, limit: number): ConceptRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, title, body FROM concepts
         WHERE kind='source' AND status='active' AND length(body) > 40
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(limit) as ConceptRow[];
  } finally {
    db.close();
  }
}

function sampleSameFileChunkPairs(dbPath: string, limit: number): Array<[string, string]> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const files = db
      .prepare(
        `SELECT concept_id FROM source_chunks WHERE lifecycle='active'
         GROUP BY concept_id HAVING COUNT(*) >= 2 ORDER BY RANDOM() LIMIT ?`,
      )
      .all(limit) as Array<{ concept_id: string }>;
    const pairs: Array<[string, string]> = [];
    for (const { concept_id } of files) {
      const chunks = db
        .prepare(`SELECT content FROM source_chunks WHERE concept_id=? AND lifecycle='active' ORDER BY document_sequence LIMIT 2`)
        .all(concept_id) as Array<{ content: string }>;
      if (chunks.length === 2 && chunks[0].content.length > 40 && chunks[1].content.length > 40) {
        pairs.push([chunks[0].content, chunks[1].content]);
      }
    }
    return pairs;
  } finally {
    db.close();
  }
}

async function runRealDataSample(dbPath: string): Promise<void> {
  console.log("=== Part 2: real corpus sample, NEW model only (multilingual grounding) ===\n");
  const embedder = new OnnxEmbeddingProvider({ model: NEW_MODEL });

  const concepts = sampleRealConcepts(dbPath, 40);
  console.log(`Sampled ${concepts.length} real concepts for the "distinct" category.`);
  const conceptVectors = await Promise.all(concepts.map((c) => embedder.embed(c.body.slice(0, 2000))));
  const distinctScores: number[] = [];
  for (let i = 0; i < conceptVectors.length; i++) {
    for (let j = i + 1; j < conceptVectors.length; j++) {
      distinctScores.push(cosine(conceptVectors[i], conceptVectors[j]));
    }
  }

  const sameFilePairs = sampleSameFileChunkPairs(dbPath, 30);
  console.log(`Sampled ${sameFilePairs.length} same-file section pairs for the "related (same file)" category.\n`);
  const sameFileScores: number[] = [];
  for (const [a, b] of sameFilePairs) {
    const [va, vb] = await Promise.all([embedder.embed(a.slice(0, 2000)), embedder.embed(b.slice(0, 2000))]);
    sameFileScores.push(cosine(va, vb));
  }

  console.log("Distributions (NEW model):");
  summarize("distinct", distinctScores);
  summarize("related (same file)", sameFileScores);
  console.log("");

  const distinctP95 = percentile([...distinctScores].sort((a, b) => a - b), 0.95);
  const relatedP75 = percentile([...sameFileScores].sort((a, b) => a - b), 0.75);
  console.log(`  distinct p95 = ${distinctP95.toFixed(3)} (tauAmbiguous should sit above this)`);
  console.log(`  same-file p75 = ${relatedP75.toFixed(3)} (a reference point — same-file sections are`);
  console.log(`    topically related by construction and should mostly stay BELOW tauAmbiguous too,`);
  console.log(`    since they are different headings, not restatements of the same content)`);
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];

  await runCuratedBaseline();
  if (dbPath) {
    await runRealDataSample(dbPath);
  } else {
    console.log("(no db-path given — skipping Part 2 real-corpus sample)");
  }

  console.log("\n=== Recommendation (NOT auto-applied — decide at the John gate) ===");
  console.log("Compare the NEW model's curated near-dup/paraphrase gap against its distinct/same-file");
  console.log("gap above. Placement mirrors the existing (stale) thresholds' own derivation: tauAttach");
  console.log("just under the paraphrase score, tauAmbiguous comfortably above the distinct p95 and the");
  console.log("same-file p75 — never below either, so two different files' sections never silently merge.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
