import path from "node:path";
import { createMonetCoreMcpServer, FreshStoreEmbedderUnavailableError } from "@team-monet/core";
import { ensureMonetDir, getDbPath } from "./db/index.js";
import { deriveCircle, deriveCallerId, deriveProjectId } from "./circle.js";
import { openServedCore } from "./bootstrap.js";

async function main() {
  ensureMonetDir();
  // Prefer an explicit project dir over cwd — a host may spawn this server elsewhere.
  // (Claude Code sets CLAUDE_PROJECT_DIR for stdio MCP servers and discourages relying on cwd.)
  const projectDir = path.resolve(process.env.MONET_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const circle = deriveCircle(projectDir);
  // @team-monet/core's createMonetCoreMcpServer derives its source-authorization context ONLY
  // from these two env vars (no options-object seam exists for it) — without both set, every
  // source_* tool fails closed. Assign UNCONDITIONALLY (not setIfBlank/??=): deriveCallerId/
  // deriveProjectId already implement the full precedence themselves (non-blank override wins,
  // TRIMMED; blank/unset → derived default), so reassigning process.env through them also
  // normalizes a whitespace-padded operator override in place instead of leaving it raw for
  // @team-monet/core's deriveOptsFromEnv (which does not trim) to deny every ACL match against.
  // See circle.ts for details.
  process.env.MONET_CALLER_ID = deriveCallerId();
  process.env.MONET_PROJECT_ID = deriveProjectId(projectDir);
  const core = await openServedCore(getDbPath(), {
    scopeContext: projectDir,
    defaultCircle: circle,
  });
  await createMonetCoreMcpServer(core);
  console.error(`Monet MCP server running on stdio · ${getDbPath()}`);
  console.error(`Circle: ${circle}`);
}

main().catch((error: unknown) => {
  if (error instanceof FreshStoreEmbedderUnavailableError) {
    console.error(error.message);
  } else {
    console.error("Failed to start Monet:", error);
  }
  process.exit(1);
});
