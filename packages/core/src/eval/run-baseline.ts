/**
 * md-baseline eval CLI — pnpm eval:baseline [--json] [--verbose] [--embedder=auto|onnx|hashing]
 *
 * Reports the SAME STARTER_SUITE (spec §2.5: no scenarios.ts changes, no real-store export in
 * Phase 0) against six arms: the three existing engine arms (no-memory, monet-search,
 * monet-gather) + bm25 (ported, concept-granularity) + chunk-cosine-rag + md-tree (both
 * chunk-granularity, scored via harness-baseline.ts's separate chunk-id scoring pass).
 *
 * Deliberately a SEPARATE script/entry from run.ts (spec §2.4/§2.6) — `pnpm eval` and
 * DEFAULT_ARMS are untouched by this file's existence. Mirrors run.ts's flag parsing and
 * --embedder=onnx semantics (forces createLocalEmbedder() to throw on load failure, so a
 * broken MiniLM install fails loudly instead of silently downgrading to lexical) exactly, so
 * the two CLIs behave identically from an operator's perspective.
 */
import { createLocalEmbedder } from "../embedding-onnx";
import { HashingEmbeddingProvider, type EmbeddingProvider } from "../embedding";
import { STARTER_SUITE } from "./scenarios";
import { runBaselineSuite } from "./harness-baseline";
import { formatBaselineReport } from "./report-baseline";

interface Flags {
  json: boolean;
  verbose: boolean;
  embedder: "auto" | "onnx" | "hashing";
}

const EMBEDDER_FLAG_PREFIX = "--embedder=";

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { json: false, verbose: false, embedder: "auto" };
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg === "--verbose" || arg === "-v") flags.verbose = true;
    else if (arg.startsWith(EMBEDDER_FLAG_PREFIX)) {
      const v = arg.slice(EMBEDDER_FLAG_PREFIX.length).toLowerCase();
      if (v === "onnx" || v === "hashing" || v === "auto") flags.embedder = v;
    }
  }
  return flags;
}

async function pickEmbedder(pref: Flags["embedder"]): Promise<{ embedder: EmbeddingProvider; name: string }> {
  if (pref === "hashing") return { embedder: new HashingEmbeddingProvider(), name: "HashingEmbeddingProvider (lexical)" };
  if (pref === "onnx") process.env.MONET_EMBEDDER = "onnx"; // make createLocalEmbedder throw if MiniLM can't load
  // Eval auto mode intentionally preserves createLocalEmbedder's lexical fallback for reportability.
  const embedder = await createLocalEmbedder();
  const semantic = embedder.constructor.name === "OnnxEmbeddingProvider";
  return { embedder, name: `${embedder.constructor.name}${semantic ? " (MiniLM, semantic)" : " (lexical fallback)"}` };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const { embedder, name } = await pickEmbedder(flags.embedder);
  const report = await runBaselineSuite(STARTER_SUITE, embedder, { embedderName: name });

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatBaselineReport(report, { verbose: flags.verbose }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
