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
import { GATE_JOURNAL_FILENAME } from "../src/gate-journal";
import { deriveCircle } from "../src/circle";

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

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  // Per-project circle so a shared ~/.monet store isolates per project (MONET_CIRCLE overrides).
  const circle = process.env.MONET_CIRCLE || deriveCircle();
  const core = new MonetCore(dbPath, {
    embedder: await chooseStartupEmbedder(dbPath),
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
    gateJournalPath: path.join(path.dirname(dbPath), GATE_JOURNAL_FILENAME),
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
