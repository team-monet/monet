import path from "node:path";
import { createMonetCoreMcpServer, FreshStoreEmbedderUnavailableError } from "@team-monet/core";
import { ensureMonetDir, getDbPath, getGateMirrorPath } from "./db/index.js";
import { deriveCircle, deriveCallerId, deriveProjectId } from "./circle.js";
import { openServedCore } from "./bootstrap.js";

async function main() {
  // Prefer an explicit project dir over cwd — a host may spawn this server elsewhere.
  // (Claude Code sets CLAUDE_PROJECT_DIR for stdio MCP servers and discourages relying on cwd.)
  const projectDir = path.resolve(process.env.MONET_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  // P1-1 (Codex round 3 on PR #42): ensureMonetDir(projectDir), matching cli.ts's own `start`
  // action fix exactly (moved below projectDir's own computation, same reasoning) — see that
  // file's comment for the full CANTOPEN explanation.
  ensureMonetDir(projectDir);
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
  // COMPONENT B (4b-D), extended here too: this is the SAME long-running serving process as
  // cli.ts's `start` action, just a second launch path (this file's own generated config is not
  // what `monet config` emits today — see this slice's report — but the two are equivalent
  // servers and leaving this one without mirror maintenance would silently depend on WHICH launch
  // path a host happens to use, exactly the kind of divergence this slice exists to close).
  //
  // FIX 1 (Codex round 2 on PR #42): getDbPath(projectDir), matching cli.ts's own `start` action
  // fix exactly — see that file's comment for the full wrong-project-class explanation. Bare
  // getDbPath() would open the served store at cwd while gateSidecarPath already materialized the
  // mirror at projectDir; a declaration made through this session would land in the wrong store's
  // mirror. Same fix, same reasoning, second launch path.
  const core = await openServedCore(getDbPath(projectDir), {
    scopeContext: projectDir,
    defaultCircle: circle,
    gateSidecarPath: getGateMirrorPath(projectDir),
  });
  await createMonetCoreMcpServer(core);
  console.error(`Monet MCP server running on stdio · ${getDbPath(projectDir)}`);
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
