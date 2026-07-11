#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { MonetCore, createLocalEmbedder, createMonetCoreMcpServer } from "@team-monet/core";
import { ensureMonetDir, getDbPath } from "./db/index.js";
import { deriveCircle } from "./circle.js";
import { registerSourceCommands, SourceCliError } from "./source-cli.js";

// Read version from package.json so it can never drift from the published version.
// esbuild inlines the import.meta.url-relative path at bundle time; the bundled
// dist/cli.js ends up alongside the package root, so this resolves correctly at runtime.
const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

const program = new Command();

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
    const projectDir = process.env.MONET_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const circle = deriveCircle(projectDir);
    const core = new MonetCore(getDbPath(), {
      embedder: await createLocalEmbedder(),
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
    const core = new MonetCore(getDbPath());
    const s = core.stats(options.circle);
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
    const config = generateAgentConfig(options.agent);

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

// YAML helper for Hermes
function toYaml(obj: Record<string, unknown>, indent = 0): string {
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

// Generate MCP configuration for different agents
function generateAgentConfig(agentType: string): Record<string, unknown> {
  const env = { MONET_STORAGE_DIR: path.resolve(process.cwd(), ".monet") };
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
    return new MonetCore(getDbPath(), { sourceStorageDir: path.join(monetDir, "sources") });
  },
  deriveCircle,
  projectDir() {
    return path.resolve(process.env.MONET_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  },
});

void program.parseAsync().catch((error: unknown) => {
  if (error instanceof SourceCliError) {
    console.error(`monet source: ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
