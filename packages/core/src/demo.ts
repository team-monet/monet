/**
 * Keystone spike demo — run live:  pnpm --filter @monet/core demo
 *
 *   1. resolve-or-create  — similar evidence collapses into ONE concept (#239)
 *   2. lazy enrichment    — store is cheap + leaves the concept "dirty"; synthesis runs
 *                           only when an agent TOUCHES it (fetch/checkpoint)
 *   3. no answer-leak     — search returns a CARD (shape, not content), so the agent
 *                           can't fake understanding from a summary — it must fetch (#232)
 */
import { MonetCore } from "./engine.js";

function line(): void {
  console.log("─".repeat(72));
}

async function main(): Promise<void> {
  const core = new MonetCore(":memory:");

  console.log("\n## 1. Resolve-or-create: similar evidence → one concept (Sift, inline)\n");
  const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.", {
    kind: "decision",
  });
  console.log(`store A → ${a.action.padEnd(9)} dirty=${a.concept.dirty}`);
  const b = await core.store("Monet Local uses SQLite for its local storage backend.", { kind: "decision" });
  console.log(`store B → ${b.action.padEnd(9)} dirty=${b.concept.dirty}  (score=${b.score.toFixed(3)})`);
  const c = await core.store("For Monet Local persistence we went with a SQLite database file.", {
    kind: "decision",
  });
  console.log(`store C → ${c.action.padEnd(9)} dirty=${c.concept.dirty}  (score=${c.score.toFixed(3)})`);
  await core.store("The team prefers pytest with httpx for Python testing.", { kind: "preference" });
  line();
  console.log(`Concepts: ${core.conceptCount()} (want 2)   Observations: ${core.observationCount()} (want 4)`);

  console.log("\n## 2. Search returns a CARD — what it is + how much, NEVER the claim (#232)\n");
  const hits = await core.search("what does monet local use for storage");
  for (const h of hits) {
    console.log(`  ${h.score.toFixed(3)}  [${h.kind}] ${h.slug}`);
    console.log(`          ${h.supportCount} obs · conf ${h.confidence.toFixed(2)} · → ${h.fetchHint}`);
  }
  console.log(`\n  card fields = ${Object.keys(hits[0]).join(", ")}`);
  console.log(`  ↳ no "body", no "summary" — the answer is NOT in the search result.`);

  console.log("\n## 3. To actually read it, you must FETCH (Tier-2 touch → synthesis on demand)\n");
  const fetched = (await core.getConcept(hits[0].id))!;
  console.log(`fetch → synthesizedNow=${fetched.synthesizedNow}  dirty=${fetched.dirty}  revisions=${fetched.revisions}`);
  console.log(`now the content is here (${fetched.observations.length} observations preserved):`);
  for (const l of fetched.body.split("\n")) console.log(`   • ${l}`);

  console.log("\n## 4. Checkpoint cleans whatever's still dirty in one batch\n");
  console.log(`checkpoint() → synthesized ${await core.checkpoint()} dirty concept(s)`);
  console.log();

  core.close();
}

main();
