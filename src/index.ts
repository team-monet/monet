import { MonetCore, createLocalEmbedder, createMonetCoreMcpServer } from "@team-monet/core";
import { ensureMonetDir, getDbPath } from "./db/index.js";

async function main() {
  ensureMonetDir();
  const core = new MonetCore(getDbPath(), { embedder: await createLocalEmbedder(), scopeContext: process.cwd() });
  await createMonetCoreMcpServer(core);
  console.error(`Monet MCP server running on stdio · ${getDbPath()}`);
  console.error("Tools: memory_store, memory_search, memory_fetch, memory_synthesize, memory_checkpoint, agent_context");
}

main().catch((err) => {
  console.error("Failed to start Monet:", err);
  process.exit(1);
});
