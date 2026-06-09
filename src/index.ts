import { MonetCore, createLocalEmbedder, createMonetCoreMcpServer, deriveCircle } from "@team-monet/core";
import { ensureMonetDir, getDbPath } from "./db/index.js";

async function main() {
  ensureMonetDir();
  // Derive a per-project circle from the working tree so one shared store isolates each repo.
  const circle = deriveCircle(process.cwd());
  const core = new MonetCore(getDbPath(), {
    embedder: await createLocalEmbedder(),
    scopeContext: process.cwd(),
    defaultCircle: circle,
  });
  await createMonetCoreMcpServer(core);
  console.error(`Monet MCP server running on stdio · ${getDbPath()}`);
  console.error(`Circle: ${circle}`);
}

main().catch((err) => {
  console.error("Failed to start Monet:", err);
  process.exit(1);
});
