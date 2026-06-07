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
import { createLocalEmbedder } from "../src/embedding-onnx";
import { createMonetCoreMcpServer } from "../src/mcp-server";

function resolveDbPath(): string {
  const projectDir = path.join(process.cwd(), ".monet");
  const dir =
    process.env.MONET_STORAGE_DIR ??
    (fs.existsSync(projectDir) ? projectDir : path.join(process.env.HOME ?? process.cwd(), ".monet"));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "monet-core.db");
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const core = new MonetCore(dbPath, { embedder: await createLocalEmbedder(), scopeContext: process.cwd() });
  await createMonetCoreMcpServer(core);
  // stderr so it doesn't corrupt the stdio MCP channel
  console.error(`monet-core MCP server running (stdio) · ${dbPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
