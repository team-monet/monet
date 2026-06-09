import { MonetCore, createLocalEmbedder, createMonetCoreMcpServer, deriveCircle } from "@team-monet/core";
import { ensureMonetDir, getDbPath } from "./db/index.js";

async function main() {
  ensureMonetDir();
  // Prefer an explicit project dir over cwd — a host may spawn this server elsewhere.
  // (Claude Code sets CLAUDE_PROJECT_DIR for stdio MCP servers and discourages relying on cwd.)
  const projectDir = process.env.MONET_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const circle = deriveCircle(projectDir);
  const core = new MonetCore(getDbPath(), {
    embedder: await createLocalEmbedder(),
    scopeContext: projectDir,
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
