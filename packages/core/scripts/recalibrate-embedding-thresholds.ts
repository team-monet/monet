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
 *   2. Reports percentile summaries per category and a recommended tauAttach/tauAmbiguous,
 *      mirroring the existing thresholds' own placement logic (tauAttach just under the
 *      high-similarity category's low end; tauAmbiguous well above the distinct category's high
 *      end — ADR's conservative-dedup rule: prefer a duplicate over a bad merge).
 *
 * REPORT ONLY. Nothing here writes to recommendedThresholds or any store — the recommendation is
 * a decision for the John gate, not an automatic change.
 *
 * THE REAL-CORPUS PHASE RETIRED WITH THE SOURCE SUBSYSTEM (#16). It sampled `kind='source'`
 * concepts and same-file chunk pairs out of `source_chunks`, so with the subsystem gone it has no
 * population and its table is dropped — it would fail with `no such table` rather than produce
 * numbers. It is removed rather than repointed at native concepts: "chunk pairs from the same
 * file" has no native equivalent, and silently swapping the population would change what the
 * percentiles mean with no measurement behind the change. Re-grounding these thresholds on a
 * native corpus is a measurement to design, not a rename.
 *
 * Usage:
 *   tsx scripts/recalibrate-embedding-thresholds.ts
 */
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

async function main(): Promise<void> {
  await runCuratedBaseline();

  console.log("\n=== Recommendation (NOT auto-applied — decide at the John gate) ===");
  console.log("Compare the NEW model's curated near-dup/paraphrase gap against its unrelated gap");
  console.log("above. Placement mirrors the existing (stale) thresholds' own derivation: tauAttach just");
  console.log("under the paraphrase score, tauAmbiguous comfortably above the unrelated high end.");
  console.log("");
  console.log("CURATED ENGLISH SENTENCES ONLY. The real-corpus half retired with the source subsystem");
  console.log("(#16) and is not replaced here, so these numbers are not grounded in this store's own");
  console.log("Korean/English-mixed content — the exact case the model swap targets. Treat the");
  console.log("recommendation as a baseline, not a calibration, until a native-corpus sample exists.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
