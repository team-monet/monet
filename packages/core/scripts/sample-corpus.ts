/**
 * Phase 1 corpus derivation — step 1: subsample.
 *
 *   tsx scripts/sample-corpus.ts [--source=eval-corpus/source/monet.db] [--out=eval-corpus/db]
 *
 * Reads the real-store copy at --source (NEVER the live ~/.monet/monet.db — see corpus-sample.ts's
 * module doc for the safety rule) and derives one self-contained Monet-compatible .db per sweep
 * size (25/50/100/full) under --out/<size>/monet.db. Prints per-size concept/edge/observation
 * counts and the exact strata cell allocations so a human can sanity-check the sample without
 * opening a debugger.
 *
 * This script is intentionally the ONLY place the source .db path is hardcoded as a default —
 * every other module in this pipeline takes paths as explicit parameters.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { assertSafeToWipe, deriveAllSizes, SWEEP_SIZES, FULL_LABEL } from "../src/eval/corpus-sample";
import { CORPUS_CIRCLES, corpusScopeWhereFragment } from "../src/eval/corpus-scope.mjs";

// P2-a fix (round 2): REPO_ROOT is new in this fix round (assertSafeToWipe needs it) — this
// script runs as an ES module (via tsx), where the CommonJS __dirname global doesn't exist, so
// it's derived from import.meta.url the same way scrub-corpus.mjs already does (that file's own
// REPO_ROOT derivation is the exact precedent this mirrors), rather than assuming a CommonJS
// global that would throw at runtime.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_SOURCE = "eval-corpus/source/monet.db";
const DEFAULT_OUT = "eval-corpus/db";

// Defense-in-depth: never let this script touch the live store, even if invoked with a
// mistaken --source. This is a belt-and-suspenders check — the classifier that blocks direct
// access to ~/.monet/monet.db is the actual enforcement point, this is just a second, cheap,
// script-level guard against an obviously-wrong invocation.
const LIVE_STORE_MARKERS = [".monet/monet.db", ".monet\\monet.db"];

function parseArgs(argv: string[]): { source: string; out: string } {
  let source = DEFAULT_SOURCE;
  let out = DEFAULT_OUT;
  for (const arg of argv) {
    if (arg.startsWith("--source=")) source = arg.slice("--source=".length);
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
  }
  return { source, out };
}

function assertNotLiveStore(path: string): void {
  const resolved = resolve(path);
  for (const marker of LIVE_STORE_MARKERS) {
    if (resolved.includes(marker.replace("\\", "/")) || resolved.includes(marker)) {
      throw new Error(
        `Refusing to read from a path that looks like the live Monet store (${resolved}). ` +
          `This pipeline only ever operates on a .backup'd copy under eval-corpus/source/. ` +
          `If this is genuinely a safe copy, rename it so it doesn't match the live-store path shape.`,
      );
    }
  }
}

function main(): void {
  const { source, out } = parseArgs(process.argv.slice(2));
  const sourcePath = resolve(source);
  const outDir = resolve(out);

  assertNotLiveStore(sourcePath);
  if (!existsSync(sourcePath)) {
    throw new Error(`Source db not found at ${sourcePath}. Expected a .backup'd read-only copy (see eval-corpus/source/).`);
  }

  // Confirm FULL count ourselves at run time (never trust a hardcoded figure from a briefing/spec).
  // F4 fix: "eligible" is now MONET-CIRCLE-SCOPED (CORPUS_CIRCLES), not every circle in the store
  // — this is the one query of the three duplicates that lived in this file; it now shares the
  // same corpus-scope.mjs definition corpus-sample.ts's deriveAllSizes() uses, instead of a second,
  // independently-hand-copied `kind != 'workstream'` filter with no circle scope at all.
  const probe = new Database(sourcePath, { readonly: true });
  const total = (probe.prepare(`SELECT COUNT(*) AS n FROM concepts`).get() as { n: number }).n;
  const { fragment, params } = corpusScopeWhereFragment();
  const eligible = (probe.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE kind != 'workstream' AND ${fragment}`).get(...params) as { n: number })
    .n;
  probe.close();
  console.log(`Source: ${sourcePath}`);
  console.log(`  total concepts in store (all circles, incl. workstream): ${total}`);
  console.log(`  eligible concepts (kind != 'workstream', circle IN [${CORPUS_CIRCLES.join(", ")}]): ${eligible}  ← this is FULL for the sweep`);
  if (eligible < Math.max(...SWEEP_SIZES)) {
    console.log(
      `  NOTE: FULL (${eligible}) is below the largest fixed sweep size (${Math.max(...SWEEP_SIZES)}). ` +
        `This run uses sweep sizes [${SWEEP_SIZES.join(", ")}, ${FULL_LABEL}]. The sweep tops out at the ` +
        `real monet-scoped store size rather than padding with synthetic content or widening scope to hit a round number.`,
    );
  }

  // Fresh derivation: wipe any prior derived dbs under outDir so a re-run can't leave stale
  // sibling files from a previous source/config around (determinism check requires this too —
  // otherwise a second run could "pass" by never overwriting a stale first-run artifact).
  // P2-a fix: assert containment BEFORE the recursive delete — --out is fully user-supplied, so a
  // broad/misconfigured value (--out=eval-corpus, --out=., or a path that escapes eval-corpus/ via
  // ..) must fail fast here rather than wiping the source corpus directory or the checkout.
  if (existsSync(outDir)) {
    assertSafeToWipe(outDir, REPO_ROOT);
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  const outDirBuilder = (label: string): string => {
    const dir = join(outDir, label);
    mkdirSync(dir, { recursive: true });
    return join(dir, "monet.db");
  };

  const results = deriveAllSizes(sourcePath, outDirBuilder);

  console.log("\n=== Derivation results ===");
  for (const r of results) {
    console.log(`\n[${r.label}] requested=${r.requestedSize ?? "(full — no sampling)"} achieved=${r.selection.achievedSize}`);
    console.log(`  concepts=${r.result.conceptCount} edges=${r.result.edgeCount} observations=${r.result.observationCount}`);
    console.log(`  source circle mix: ${JSON.stringify(r.result.sourceCircleCounts)}`);
    console.log(`  strata cells (kind x recency-tercile, available -> taken):`);
    for (const c of r.selection.cellAllocations) {
      if (c.taken === 0 && c.available === 0) continue;
      console.log(`    ${c.kind.padEnd(12)} tercile=${c.tercile}  ${c.available} -> ${c.taken}`);
    }
  }

  console.log(`\nWritten under ${outDir}/<size>/monet.db for sizes: ${[...SWEEP_SIZES, FULL_LABEL].join(", ")}`);
}

main();
