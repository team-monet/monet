/**
 * Validate the real MiniLM embedder AND the dedup thresholds calibrated to it, so we
 * tune resolve-or-create (ADR §4.1) on real vectors instead of guessing.
 *
 *   pnpm --filter @monet/core embed:check
 *
 * Part 1 prints the cosine distribution (near-dup / paraphrase / related / unrelated).
 * Part 2 drives the actual engine with MiniLM and asserts each store resolves correctly:
 * near-dup + paraphrase ATTACH to the base concept; related + unrelated FORK to new ones.
 *
 * Requires @huggingface/transformers (downloads MiniLM once on first run). Exits non-zero
 * if the calibration regresses, so it can gate threshold changes.
 */
import { OnnxEmbeddingProvider } from "./embedding-onnx.js";
import { cosine } from "./embedding.js";
import { MonetCore } from "./engine.js";

const BASE = "We decided to use SQLite as the storage backend for Monet Local.";
const cases: Array<[string, string]> = [
  ["near-dup", "Monet Local uses SQLite for its local storage backend."],
  ["paraphrase", "Monet Local persists its data in an embedded SQL database file."],
  ["related", "The local runtime keeps memories in a file on disk."],
  ["unrelated", "The team prefers pytest with httpx for Python testing."],
  ["query", "what does monet local use for storage"],
];

async function main(): Promise<void> {
  const e = new OnnxEmbeddingProvider();
  console.log(`model: all-MiniLM-L6-v2 (${e.dim}-dim)\nbase:  "${BASE}"\n`);
  const base = await e.embed(BASE);
  for (const [label, text] of cases) {
    const v = await e.embed(text);
    console.log(`  ${label.padEnd(11)} cosine = ${cosine(base, v).toFixed(3)}   "${text}"`);
  }

  const t = e.recommendedThresholds;
  console.log(`\nthresholds: tauAttach=${t.tauAttach}  tauAmbiguous=${t.tauAmbiguous}`);
  console.log("validating resolve-or-create decisions through the engine…\n");

  // Drive the real engine with the real embedder — same provider the local runtime now uses.
  const core = new MonetCore(":memory:", { embedder: e });
  const baseRes = await core.store(BASE, { kind: "decision" });
  const decisions: Array<{ label: string; action: string; attachedToBase: boolean }> = [];
  for (const [label, text] of cases) {
    if (label === "query") continue; // a query is a read, not a store
    const r = await core.store(text);
    decisions.push({ label, action: r.action, attachedToBase: r.conceptId === baseRes.conceptId });
    console.log(`  ${label.padEnd(11)} → ${r.action.padEnd(9)} (score ${r.score.toFixed(3)}, ${r.conceptId === baseRes.conceptId ? "same concept" : "NEW concept"})`);
  }

  // Expectations: near-dup + paraphrase fold into base; related + unrelated fork out.
  const shouldAttach = new Set(["near-dup", "paraphrase"]);
  const failures: string[] = [];
  for (const d of decisions) {
    const want = shouldAttach.has(d.label);
    if (d.attachedToBase !== want) {
      failures.push(`${d.label}: expected ${want ? "ATTACH to base" : "NEW concept"}, got ${d.attachedToBase ? "attach" : "new"} (${d.action})`);
    }
  }
  const conceptCount = core.conceptCount();
  if (conceptCount !== 3) failures.push(`expected 3 concepts (base+related+unrelated), got ${conceptCount}`);
  core.close();

  if (failures.length) {
    console.error("\n❌ calibration FAILED:");
    for (const f of failures) console.error("   - " + f);
    console.error("\nRe-tune OnnxEmbeddingProvider.recommendedThresholds against the cosines above.");
    process.exit(1);
  }
  console.log(`\n✅ calibration OK — ${conceptCount} concepts: near-dup+paraphrase merged, related+unrelated forked.`);
}

main();
