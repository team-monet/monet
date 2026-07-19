/**
 * Run monet-core as a local MCP server (stdio).
 *
 *   pnpm --filter @monet/core mcp           # dev
 *
 * Point a host agent at this command. Storage resolves to ./.monet/monet-core.db
 * (project) or ~/.monet/monet-core.db, overridable with MONET_STORAGE_DIR.
 */
import path from "node:path";
import fs from "node:fs";
import { MonetCore } from "../src/engine";
import { readStoredEmbedderPin } from "../src/storage";
import { createLocalEmbedder, instantiateEmbedderForPin, UnsatisfiableEmbedderError } from "../src/embedding-onnx";
import type { EmbeddingProvider } from "../src/embedding";
import { createMonetCoreMcpServer } from "../src/mcp-server";
import { deriveCircle } from "../src/circle";

function resolveDbPath(): string {
  const projectDir = path.join(process.cwd(), ".monet");
  const dir =
    process.env.MONET_STORAGE_DIR ??
    (fs.existsSync(projectDir) ? projectDir : path.join(process.env.HOME ?? process.cwd(), ".monet"));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "monet-core.db");
}

/**
 * Chooses which embedder to construct at startup, based on whatever `dbPath` is ALREADY pinned to
 * (Codex review, PR #51 round 7, FIX U). Previously this CLI unconditionally awaited
 * createLocalEmbedder() — which honors MONET_EMBEDDER — BEFORE ever constructing a MonetCore or
 * reading the store's own pin, coupling startup availability to a model the store might not even
 * use: with MONET_EMBEDDER=onnx, a store already pinned to hashing would still pay (and could fail)
 * an ONNX warmup it was never going to keep.
 *
 * Pin present: instantiate STRICTLY against it (instantiateEmbedderForPin — the same strict, no-
 * fallback loader ensureEmbedderPin itself uses), never createLocalEmbedder's MONET_EMBEDDER-driven
 * guess. The constructor-time guard never arms (the embedder already matches the pin by
 * construction) and createMonetCoreMcpServer's own ensureEmbedderPin() call is trivially satisfied
 * — a hashing-pinned store no longer touches ONNX at all, faster startup as a bonus.
 *
 * Codex review (PR #51 round 8, FIX Z): a loader failure here is NOT always the loud, correct
 * outcome round 7 assumed. ensureEmbedderPin() has its own recovery for exactly this shape (FIX O,
 * round 5): a genuinely EMPTY store pinned to a stale/unloadable model has no committed vector space
 * to protect, so it re-pins to the live constructor embedder and serves normally instead of failing
 * forever. That recovery only runs INSIDE ensureEmbedderPin() — but round 7 moved the strict load to
 * BEFORE MonetCore is even constructed, so an empty store with a bad pin now throws right here,
 * before construction, before ensureEmbedderPin ever gets a chance to run its own recovery. A
 * regression: this CLI would now exit loudly on exactly the store FIX O was built to save.
 *
 * Fixed by catching ONLY UnsatisfiableEmbedderError (never a different exception — that would still
 * be a genuine bug in instantiateEmbedderForPin surfacing, and must not be silently swallowed) and
 * falling back to createLocalEmbedder(), letting construction proceed. ensureEmbedderPin() (called
 * by createMonetCoreMcpServer, in main() below) then does the deciding: an empty store gets FIX O's
 * recovery and serves; a genuinely non-empty store with an unsatisfiable pin still throws the exact
 * same UnsatisfiableEmbedderError it always would have — just surfaced at ensure time instead of
 * pre-construction, an identical end state to today for that case. One stderr line logs the fallback
 * so an operator watching startup output sees WHY a different embedder got chosen.
 *
 * Pin absent (NULL — a genuinely fresh store, a pre-pin legacy store, or one opened with
 * deferCreatedPin at some earlier inspection): current behavior EXACTLY — createLocalEmbedder()
 * honoring MONET_EMBEDDER as it always has. The backfill (or fresh-store 'created' stamp) still
 * decides the pin later, inside the MonetCore constructor / ensureEmbedderPin, exactly as today.
 *
 * Exported for testability — main()'s own invocation is guarded behind an import.meta.url entry-
 * point check (same established pattern as scripts/migrate-file-concept.ts's preflightEmbedder,
 * round 6) so this can be imported and unit-tested without starting a real stdio MCP server.
 */
export async function chooseStartupEmbedder(dbPath: string): Promise<EmbeddingProvider> {
  const pin = readStoredEmbedderPin(dbPath);
  if (pin === null) return createLocalEmbedder();
  try {
    return await instantiateEmbedderForPin(pin);
  } catch (e) {
    if (!(e instanceof UnsatisfiableEmbedderError)) throw e;
    console.error(`[monet-core] pin '${pin}' could not be loaded (${e.message}); deferring to engine recovery.`);
    return createLocalEmbedder();
  }
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  // Per-project circle so a shared ~/.monet store isolates per project (MONET_CIRCLE overrides).
  const circle = process.env.MONET_CIRCLE || deriveCircle();
  const core = new MonetCore(dbPath, {
    embedder: await chooseStartupEmbedder(dbPath),
    scopeContext: process.cwd(),
    defaultCircle: circle,
  });
  await createMonetCoreMcpServer(core);
  // stderr so it doesn't corrupt the stdio MCP channel
  console.error(`monet-core MCP server running (stdio) · ${dbPath} · circle=${circle}`);
}

// Run only when invoked directly, never as a side effect of importing chooseStartupEmbedder
// elsewhere (Codex review, PR #51 round 7, FIX U's test coverage imports it from src/__tests__ —
// that import must not also start a real stdio MCP server). Same established pattern as
// scripts/migrate-file-concept.ts (round 6) / scrub-corpus.mjs / scrub-db.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
