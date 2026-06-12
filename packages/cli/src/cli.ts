#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { MonetCore, createLocalEmbedder, createMonetCoreMcpServer, deriveCircle } from "@team-monet/core";
import { ensureMonetDir, getDbPath } from "./db/index.js";

const program = new Command();

program
  .name("monet")
  .description("Monet — local-first memory for AI agents (state-centric substrate)")
  .version("0.6.1");

program
  .command("start")
  .description("Start the Monet MCP server")
  .option("-d, --dir <directory>", "Storage directory (default: .monet or ~/.monet)")
  .action(async (options) => {
    if (options.dir) {
      process.env.MONET_STORAGE_DIR = path.resolve(options.dir);
    }
    ensureMonetDir();
    // Identify the project we're serving so one shared store (e.g. ~/.monet) isolates each repo
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
  .description("Show Monet status and statistics")
  .action(async () => {
    ensureMonetDir();
    const core = new MonetCore(getDbPath());
    const s = core.stats();
    console.log(`Monet Status`);
    console.log(`------------------`);
    console.log(`Storage:       ${getDbPath()}`);
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

program.parse();
