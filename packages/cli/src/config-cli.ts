/**
 * MCP configuration generation for the `monet config` command. Split out of cli.ts (which
 * executes `program.parseAsync()` as an import-time side effect and so can't be imported
 * directly in tests) so this pure, side-effect-free logic is independently unit-testable —
 * mirrors source-cli.ts's separation from cli.ts.
 */

/**
 * Generate MCP configuration for an agent host.
 *
 * `projectDir` is the resolved project directory AT GENERATION TIME (cli.ts's
 * `resolveProjectDir()`: `MONET_PROJECT_DIR` override, then `CLAUDE_PROJECT_DIR`, then cwd) and
 * is pinned into the emitted config as `MONET_PROJECT_DIR`. Without it, a host that spawns
 * `monet start` from a different cwd than where `monet config` was run — any non-Claude-Code
 * host, or a Claude Code host that for some reason doesn't have `CLAUDE_PROJECT_DIR` set —
 * silently falls back to whatever cwd it happens to spawn from, which re-derives a DIFFERENT
 * circle and source-authorization projectId than the one the operator configured ACLs against
 * (see circle.ts's deriveCircle / deriveProjectId), so `source_*` tool calls end up denied.
 * Pinning MONET_PROJECT_DIR here makes the generated config self-sufficient: `monet start`
 * always resolves the SAME project identity it was configured for, regardless of the spawning
 * host's cwd behavior.
 *
 * `storageDir` is the RESOLVED storage directory at generation time (cli.ts passes
 * `getMonetDir()`: MONET_STORAGE_DIR override → ./.monet if it exists → ~/.monet). Pinning the
 * resolved value — rather than assuming `<cwd>/.monet` — keeps the launched server on the SAME
 * store the source CLI registers sources into; a fresh checkout without ./.monet would otherwise
 * get a config pointing at an empty store that has none of the operator's registered sources.
 *
 * `identityOverrides` propagates any MONET_CALLER_ID / MONET_PROJECT_ID overrides active in the
 * GENERATING environment into the emitted config, so a host launched from it presents the same
 * source-authorization identity the operator was using when they generated it. Only explicit
 * overrides are pinned — when absent, the keys are omitted so the server derives them fresh at
 * runtime from the pinned MONET_PROJECT_DIR (which keeps derived identity auto-correct if e.g.
 * the repo's remote later changes).
 */
export function generateAgentConfig(
  agentType: string,
  projectDir: string,
  storageDir: string,
  identityOverrides: { callerId?: string; projectId?: string } = {},
): Record<string, unknown> {
  const env: Record<string, string> = {
    MONET_STORAGE_DIR: storageDir,
  };
  // claude-code reliably supplies CLAUDE_PROJECT_DIR per project at spawn time, and its configs
  // are often installed at user scope (shared across projects) — pinning MONET_PROJECT_DIR there
  // would force EVERY project onto this one directory's identity (shared-circle bug class).
  // Other hosts don't supply a project dir, so their configs pin it (self-sufficiency, see above).
  if (agentType !== "claude-code") env.MONET_PROJECT_DIR = projectDir;
  if (identityOverrides.callerId) env.MONET_CALLER_ID = identityOverrides.callerId;
  if (identityOverrides.projectId) env.MONET_PROJECT_ID = identityOverrides.projectId;
  // Use the globally-installed `monet` bin (npm i -g @team-monet/monet) so the
  // config is portable regardless of where the package is installed.
  const server = { command: "monet", args: ["start"], env };

  switch (agentType) {
    case "claude-code":
      return { mcpServers: { monet: server } };
    case "cursor":
      return { mcp_servers: { Monet: server } };
    case "hermes":
      return { mcp_servers: { monet: server } };
    case "openclaw":
      return server;
    default:
      return server;
  }
}

// YAML helper for Hermes
export function toYaml(obj: Record<string, unknown>, indent = 0): string {
  const spaces = " ".repeat(indent);
  let result = "";
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      result += `${spaces}${key}: null\n`;
    } else if (Array.isArray(value)) {
      result += `${spaces}${key}:\n`;
      for (const item of value) {
        if (typeof item === "object" && item !== null) {
          result += toYaml(item as Record<string, unknown>, indent + 2);
        } else {
          result += `${spaces}  - ${item}\n`;
        }
      }
    } else if (typeof value === "object") {
      result += `${spaces}${key}:\n${toYaml(value as Record<string, unknown>, indent + 2)}`;
    } else {
      result += `${spaces}${key}: ${value}\n`;
    }
  }
  return result;
}
