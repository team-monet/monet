/**
 * Eval CLI —  pnpm eval  [--json] [--verbose] [--embedder=auto|onnx|hashing]
 *
 * Reports how much the substrate's recall actually helps a coding agent, versus an agent
 * with no memory, on the starter scenario suite (recall@1/3/5 ladder). Defaults to the REAL
 * shipping recall path (MiniLM via createLocalEmbedder; first run downloads the model once)
 * so the numbers are credible; `--embedder=hashing` forces the deterministic lexical fallback.
 *
 * This is a reporting tool (always exits 0 on success). The enforced regression gate lives
 * in the unit test (eval.test.ts), which runs the deterministic hashing arm in CI.
 */
import { createLocalEmbedder } from "../embedding-onnx";
import { HashingEmbeddingProvider, type EmbeddingProvider } from "../embedding";
import { STARTER_SUITE } from "./scenarios";
import { DEFAULT_ARMS } from "./strategies";
import { runSuite, restorationReachability } from "./harness";
import { formatReport } from "./report";

interface Flags {
  json: boolean;
  verbose: boolean;
  embedder: "auto" | "onnx" | "hashing";
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { json: false, verbose: false, embedder: "auto" };
  for (const arg of argv) {
    if (arg === "--json") flags.json = true;
    else if (arg === "--verbose" || arg === "-v") flags.verbose = true;
    else if (arg.startsWith("--embedder=")) {
      const v = arg.slice(11).toLowerCase();
      if (v === "onnx" || v === "hashing" || v === "auto") flags.embedder = v;
    }
  }
  return flags;
}

async function pickEmbedder(pref: Flags["embedder"]): Promise<{ embedder: EmbeddingProvider; name: string }> {
  if (pref === "hashing") return { embedder: new HashingEmbeddingProvider(), name: "HashingEmbeddingProvider (lexical)" };
  if (pref === "onnx") process.env.MONET_EMBEDDER = "onnx"; // make createLocalEmbedder throw if MiniLM can't load
  const embedder = await createLocalEmbedder();
  const semantic = embedder.constructor.name === "OnnxEmbeddingProvider";
  return { embedder, name: `${embedder.constructor.name}${semantic ? " (MiniLM, semantic)" : " (lexical fallback)"}` };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const { embedder, name } = await pickEmbedder(flags.embedder);
  const report = await runSuite(STARTER_SUITE, DEFAULT_ARMS, embedder, { embedderName: name });

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  process.stdout.write(formatReport(report, { verbose: flags.verbose }));

  if (flags.verbose) {
    const reach = await restorationReachability(STARTER_SUITE, embedder);
    const lines = ["restoration thread reachability — gold members reachable from one, per edge type (≤2 hops):", ""];
    for (const r of reach) {
      const cells = Object.entries(r.byType)
        .filter(([, v]) => v > 0)
        .map(([t, v]) => `${t} ${v}/${r.goldCount}`)
        .join(" · ");
      lines.push(`  ${r.scenarioId.padEnd(16)} ${cells}`);
    }
    lines.push(
      "",
      "→ co_occurred carries the divergent-vocabulary threads; about carries the entity-cohesive one",
      "  (checkout-thread) and only partially connects the rest — which signal earns the recall, per thread.",
      "",
    );
    process.stdout.write(lines.join("\n") + "\n");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
