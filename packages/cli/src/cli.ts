#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createMonetCoreMcpServer, FreshStoreEmbedderUnavailableError } from "@team-monet/core";
import { ensureMonetDir, getDbPath, getMonetDir } from "./db/index.js";
import { deriveCircle, deriveCallerId, deriveProjectId } from "./circle.js";
import { printStoreLine, registerSourceCommands, SourceCliError } from "./source-cli.js";
import { generateAgentConfig, toYaml } from "./config-cli.js";
import { openServedCore, openSourceCore, openStatusCore } from "./bootstrap.js";
import { registerRecoveryCommands } from "./repair-cli.js";

// Read version from package.json so it can never drift from the published version.
// esbuild inlines the import.meta.url-relative path at bundle time; the bundled
// dist/cli.js ends up alongside the package root, so this resolves correctly at runtime.
const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

const program = new Command();

// Resolve the project directory this invocation is serving. Prefer an explicit override over
// cwd — a host may spawn `monet` from elsewhere (Claude Code sets CLAUDE_PROJECT_DIR for stdio
// MCP servers and documents that servers shouldn't rely on cwd). Shared by the `start` action,
// the `config` command (so a generated config pins the project the config was made for — see
// config-cli.ts), and the source commands.
function resolveProjectDir(): string {
  return path.resolve(process.env.MONET_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

program
  .name("monet")
  .description("Monet — local-first memory for AI agents (state-centric substrate)")
  .version(version);

program
  .command("start")
  .description("Start the Monet MCP server")
  .option("-d, --dir <directory>", "Storage directory (default: .monet or ~/.monet)")
  .action(async (options) => {
    if (options.dir) {
      process.env.MONET_STORAGE_DIR = path.resolve(options.dir);
    }
    ensureMonetDir();
    // Identify the project we're serving so one shared store (e.g. ~/.monet) organizes each repo
    // into its own circle. A host may spawn this stdio server from a cwd that isn't the user's
    // repo — Claude Code sets CLAUDE_PROJECT_DIR and documents that servers shouldn't rely on cwd
    // — so prefer an explicit project dir, then fall back to cwd.
    const projectDir = resolveProjectDir();
    const circle = deriveCircle(projectDir);
    // See src/index.ts / src/circle.ts: @team-monet/core only picks up source-authorization
    // context from these two env vars (no options-object seam), so every entry point that
    // constructs the server must set them before createMonetCoreMcpServer runs. Assign
    // UNCONDITIONALLY (not setIfBlank/??=): deriveCallerId/deriveProjectId already implement the
    // full precedence (non-blank override wins, TRIMMED; blank/unset → derived default), so
    // reassigning here also normalizes a whitespace-padded operator override in place instead of
    // leaving it raw for @team-monet/core's deriveOptsFromEnv (which does not trim) to deny every
    // ACL match against.
    process.env.MONET_CALLER_ID = deriveCallerId();
    process.env.MONET_PROJECT_ID = deriveProjectId(projectDir);
    const core = await openServedCore(getDbPath(), {
      scopeContext: projectDir,
      defaultCircle: circle,
    });
    console.error(`Monet started`);
    console.error(`Storage: ${getDbPath()}`);
    console.error(`Circle:  ${circle}`);
    await createMonetCoreMcpServer(core);
  });

program
  .command("status")
  .description("Show Monet status and statistics (optionally scoped to a circle)")
  .option("--circle <name>", "Scope stats to a named circle")
  .action(async (options) => {
    ensureMonetDir();
    const core = openStatusCore(getDbPath());
    const s = core.stats(options.circle);
    printStoreLine(getDbPath());
    console.log(`Monet Status`);
    console.log(`------------------`);
    console.log(`Storage:       ${getDbPath()}`);
    if (s.circle !== undefined) {
      const circleLabel = s.resolvedFrom !== undefined
        ? `${s.circle} (resolved from ${s.resolvedFrom})`
        : s.circle;
      console.log(`Circle:        ${circleLabel}`);
    }
    console.log(`Concepts:      ${s.concepts}`);
    console.log(`Observations:  ${s.observations}`);
    console.log(`Workstreams:   ${s.workstreams}`);
    console.log(`Unsynthesized: ${s.dirty}`);
    core.close();
  });

program
  .command("config")
  .description("Generate MCP configuration for an agent")
  .option("-a, --agent <type>", "Agent type (claude-code, cursor, hermes, openclaw)", "claude-code")
  .option("-o, --output <file>", "Output file path")
  .option("--yaml", "Output YAML format (for Hermes)", false)
  .action(async (options) => {
    // Propagate any explicit auth-identity overrides active right now into the emitted config,
    // so a host launched from it presents the same identity (see config-cli.ts).
    const callerIdOverride = process.env.MONET_CALLER_ID?.trim();
    const projectIdOverride = process.env.MONET_PROJECT_ID?.trim();
    // getMonetDir() is the same resolution the server and source CLI use — the emitted config
    // must point at the store sources are actually registered in (see config-cli.ts).
    // path.resolve: a RELATIVE MONET_STORAGE_DIR override comes back verbatim from getMonetDir()
    // and would otherwise re-resolve against whatever cwd the launching host spawns from.
    const config = generateAgentConfig(options.agent, resolveProjectDir(), path.resolve(getMonetDir()), {
      ...(callerIdOverride ? { callerId: callerIdOverride } : {}),
      ...(projectIdOverride ? { projectId: projectIdOverride } : {}),
    });

    if (options.output) {
      if (options.yaml) {
        fs.writeFileSync(options.output, toYaml(config));
      } else {
        fs.writeFileSync(options.output, JSON.stringify(config, null, 2));
      }
      console.log(`Configuration written to ${options.output}`);
    } else {
      if (options.yaml) {
        console.log(toYaml(config));
      } else {
        console.log(JSON.stringify(config, null, 2));
      }
    }
  });

program
  .command("dashboard")
  .description("Open the Monet memory dashboard in your browser")
  .option("-p, --port <number>", "Port to listen on", "7373")
  .option("-d, --dir <path>", "Storage directory (default: .monet or ~/.monet)")
  .action(async (options) => {
    const port = parseInt(process.env.PORT || options.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${options.port}`);
      process.exit(1);
    }
    if (options.dir) {
      process.env.MONET_STORAGE_DIR = path.resolve(options.dir);
    }
    ensureMonetDir();
    const { startDashboard } = await import("./dashboard/server.js");
    startDashboard(port);
  });

registerSourceCommands(program, {
  openCore(storageDir) {
    if (storageDir) process.env.MONET_STORAGE_DIR = path.resolve(storageDir);
    const monetDir = ensureMonetDir();
    return openSourceCore(getDbPath(), path.join(monetDir, "sources"));
  },
  dbPath(storageDir) {
    return storageDir ? path.join(path.resolve(storageDir), "monet.db") : path.resolve(getDbPath());
  },
  deriveCircle,
  deriveCallerId,
  deriveProjectId,
  projectDir: resolveProjectDir,
});

registerRecoveryCommands(program);

void program.parseAsync().catch((error: unknown) => {
  if (error instanceof FreshStoreEmbedderUnavailableError) {
    console.error(error.message);
  } else if (error instanceof SourceCliError) {
    console.error(`monet source: ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
