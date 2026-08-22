import path from "node:path";

/**
 * Resolve the project directory the current invocation is serving. Prefer an explicit override
 * over cwd — a host may spawn `monet` from elsewhere (Claude Code sets CLAUDE_PROJECT_DIR for
 * stdio MCP servers and documents that servers shouldn't rely on cwd).
 *
 * Its own module rather than living in cli.ts: cli.ts is the executable entry point (it calls
 * `program.parseAsync()` at the bottom of the file, an unconditional top-level side effect), so
 * anything that needs this resolution — another command's module, tests — must import it from
 * somewhere that does NOT also run the whole CLI on import. Shared by the `start` action, the
 * `config` command (config-cli.ts pins the project a config was generated for), the recovery and
 * materialize commands, and the dashboard server — one resolution, so two entry points can never
 * disagree about which project they are looking at.
 */
export function resolveProjectDir(): string {
  return path.resolve(process.env.MONET_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}
