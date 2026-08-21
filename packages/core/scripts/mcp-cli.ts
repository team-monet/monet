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
import { chooseStoreEmbedder } from "../src/store-embedder";
import type { EmbeddingProvider } from "../src/embedding";
import { createMonetCoreMcpServer } from "../src/mcp-server";
import { deriveCircle } from "../src/circle";
import { inStartupPhase, recordStartupFailure } from "../src/startup-diagnosis";

/** Exported so a script can REFUSE the live store by asking the resolver that owns the path,
 *  rather than reimplementing its precedence and getting a subset of it right (#160). */
export function resolveDbPath(): string {
  const projectDir = path.join(process.cwd(), ".monet");
  const dir =
    process.env.MONET_STORAGE_DIR ??
    (fs.existsSync(projectDir) ? projectDir : path.join(process.env.HOME ?? process.cwd(), ".monet"));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "monet-core.db");
}

/** Core-owned store-aware selector, retained as a script export for existing CLI tests/callers. */
export async function chooseStartupEmbedder(dbPath: string): Promise<EmbeddingProvider> {
  return chooseStoreEmbedder(dbPath);
}

/** Set once the factory returns — see the same flag in the client's own entry points (#13). */
let transportConnected = false;
/** The store this run resolved, remembered for the failure handler. Null means the failure happened
 *  in resolveDbPath itself — the one case where there is no directory to write a record into. */
let startedDbPath: string | null = null;

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  startedDbPath = dbPath;
  // Per-project circle so a shared ~/.monet store isolates per project (MONET_CIRCLE overrides).
  const circle = process.env.MONET_CIRCLE || deriveCircle();
  // Phase-tagged for the same reason the client's openServedCore tags its own two steps (#13): a
  // model load and a store open fail for unrelated reasons, and are indistinguishable at the host.
  const embedder = await inStartupPhase("embedder-selection", () => chooseStartupEmbedder(dbPath));
  const core = await inStartupPhase("store-open", () => new MonetCore(dbPath, {
    embedder,
    scopeContext: process.cwd(),
    defaultCircle: circle,
    // THE JOURNAL'S ONLY PRODUCTION WIRING (Codex P1 on PR #144, and it was right). `gateJournalPath`
    // has no default — deliberately, so no MonetCore ever built by a test or a one-off script writes
    // into a real store — but that meant nothing anywhere set it, and core's own mouths journaled
    // nothing in a normal MCP session. The never-fired query and the conformance pass had no
    // production input at all: a record layer that existed only in its tests.
    //
    // Beside the resolved database, so it follows the store it describes rather than the process's
    // cwd — the same reasoning that keeps the host-side hook off the cwd rung.
  }));
  await createMonetCoreMcpServer(core);
  transportConnected = true;
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
    // #13: stderr is at the host's discretion — leave the cause beside the store too. Same record,
    // same filename, same directory as the shipped entry points write, so one reader finds either.
    // Keyed on the store, which for THIS script is `monet-core.db` — a different database from the
    // shipped CLI's `monet.db`, routinely in the same directory. That is why the record's path is
    // derived from the store rather than its directory (see startup-diagnosis.ts).
    const written = startedDbPath === null
      ? null
      : recordStartupFailure({
          store: startedDbPath,
          error: e,
          fallbackPhase: transportConnected ? "post-connect" : "unknown",
        });
    if (written !== null) console.error(`monet-core: the full startup diagnosis is at ${written}`);
    process.exit(1);
  });
}
