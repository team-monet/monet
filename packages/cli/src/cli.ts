#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createMonetCoreMcpServer, FreshStoreEmbedderUnavailableError } from "@team-monet/core";
import { ensureMonetDir, getDbPath, getGateMirrorPath, getMonetDir } from "./db/index.js";
import { deriveCircle, deriveCallerId, deriveProjectId } from "./circle.js";
import { printStoreLine, registerSourceCommands, SourceCliError } from "./source-cli.js";
import { generateAgentConfig, toYaml } from "./config-cli.js";
import { openServedCore, openSourceCore, openStatusCore } from "./bootstrap.js";
import { registerRecoveryCommands } from "./repair-cli.js";
import { registerGateCommands } from "./gate-cli.js";
import { registerInstallCommands } from "./install-cli.js";
import { MaterializeCliError, registerMaterializeCommands } from "./materialize-cli.js";
import { resolveProjectDir } from "./project-dir.js";

// Read version from package.json so it can never drift from the published version.
// esbuild inlines the import.meta.url-relative path at bundle time; the bundled
// dist/cli.js ends up alongside the package root, so this resolves correctly at runtime.
const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

const program = new Command();

function selectedCommand(command: Command): Command {
  const subcommandName = command.args[0];
  const subcommand = command.commands.find(
    (candidate) => candidate.name() === subcommandName || candidate.aliases().includes(subcommandName),
  );
  return subcommand === undefined ? command : selectedCommand(subcommand);
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current !== null; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(" ");
}

program
  .name("monet")
  .description("Monet — local-first memory for AI agents (state-centric substrate)")
  .version(version)
  .configureOutput({
    outputError: (text, write) => write(text.replace(/^error:/, `${commandPath(selectedCommand(program))}:`)),
  });

program
  .command("start")
  .description("Start the Monet MCP server")
  .option("-d, --dir <directory>", "Storage directory (default: .monet or ~/.monet)")
  .action(async (options) => {
    if (options.dir) {
      process.env.MONET_STORAGE_DIR = path.resolve(options.dir);
    }
    // Identify the project we're serving so one shared store (e.g. ~/.monet) organizes each repo
    // into its own circle. A host may spawn this stdio server from a cwd that isn't the user's
    // repo — Claude Code sets CLAUDE_PROJECT_DIR and documents that servers shouldn't rely on cwd
    // — so prefer an explicit project dir, then fall back to cwd.
    const projectDir = resolveProjectDir();
    // P1-1 (Codex round 3 on PR #42): ensureMonetDir(projectDir) — NOT bare ensureMonetDir() —
    // and computed AFTER projectDir (moved down from above), so it creates the SAME directory
    // getDbPath(projectDir) below will open. Bare ensureMonetDir() created (or no-op'd on) the
    // CWD-rooted .monet dir; with projectDir !== cwd (cwd has its own .monet, the target does
    // not), the target's parent directory never got created and better-sqlite3's own open call
    // failed CANTOPEN — it does not create missing parent directories, only the file.
    ensureMonetDir(projectDir);
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
    // COMPONENT B (4b-D): wire mirror materialization into the ONE long-running serving process.
    // Rooted at `projectDir` (not bare cwd) via getGateMirrorPath's own baseDir parameter — the
    // SAME project dir `circle` was just derived from, and the SAME default `monet gate` itself
    // resolves to when nothing overrides it (gate-cli.ts's own defaultGateCliDependencies) — one
    // project notion, three call sites. See bootstrap.ts's ServedCoreOptions.gateSidecarPath for
    // why this is the only writer surface.
    //
    // FIX 1 (Codex round 2 on PR #42): getDbPath(projectDir) — NOT bare getDbPath() — is the fix
    // itself. Bare getDbPath() resolves via getMonetDir()'s own internal process.cwd() default, a
    // SEPARATE "which project" notion from `projectDir` (resolveProjectDir(): MONET_PROJECT_DIR /
    // CLAUDE_PROJECT_DIR, falling back to cwd — see that function's own doc comment, "a host may
    // spawn monet from elsewhere"). With MONET_PROJECT_DIR=A and cwd=B (both with their own
    // project-local .monet dirs), the OLD code opened the SERVED STORE at B (bare getDbPath()) while
    // materializing the MIRROR at A (getGateMirrorPath(projectDir) already used projectDir) — a
    // declaration made through this exact session would land in B's store but refresh A's mirror,
    // the wrong-project class again, one layer deeper than the P1-B/round-1 fix (which paired
    // circle.ts's OWN internal store lookup with projectDir; this pairs the SERVED CORE's store with
    // it too). Rooting the store and the mirror at the SAME projectDir is what makes "one project
    // notion, three call sites" (this comment's own opening line) actually true, not just asserted.
    const core = await openServedCore(getDbPath(projectDir), {
      scopeContext: projectDir,
      defaultCircle: circle,
      gateSidecarPath: getGateMirrorPath(projectDir),
    });
    console.error(`Monet started`);
    console.error(`Storage: ${getDbPath(projectDir)}`);
    console.error(`Circle:  ${circle}`);
    await createMonetCoreMcpServer(core);
  });

program
  .command("status")
  .description("Show Monet status and statistics (optionally scoped to a circle)")
  .option("--circle <name>", "Scope stats to a named circle")
  .action(async (options) => {
    // P1-B/P2-D (Codex round 4 on PR #42): root at resolveProjectDir(), NOT bare cwd — matching
    // `start`'s own projectDir comment above. `status` must open/describe the SAME store `start`
    // serves and `source` commands write to; a bare getDbPath() here diverged from all three under
    // a MONET_PROJECT_DIR/CLAUDE_PROJECT_DIR override, reporting the wrong project's numbers with
    // no visible sign anything was wrong. No --dir/--project flag exists on this command to check
    // first — an operator wanting a specific store still reaches it via MONET_STORAGE_DIR (its own
    // higher-priority rung in getMonetDir's resolution chain, unaffected by this fix).
    const projectDir = resolveProjectDir();
    ensureMonetDir(projectDir);
    const core = openStatusCore(getDbPath(projectDir));
    const s = core.stats(options.circle);
    printStoreLine(getDbPath(projectDir));
    console.log(`Monet Status`);
    console.log(`------------------`);
    console.log(`Storage:       ${getDbPath(projectDir)}`);
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
    //
    // P1-B/P2-D (Codex round 4 on PR #42, "anything else"): getMonetDir() was called BARE here
    // while the line's own arg 2 already resolves projectDir via resolveProjectDir() — two
    // different "current project" notions in the same emitted config. Under a MONET_PROJECT_DIR
    // override, the config would have named the CORRECT project but the WRONG storage dir (cwd's,
    // not the project's) — self-inconsistent output. One resolveProjectDir() call, reused for both.
    const projectDir = resolveProjectDir();
    const config = generateAgentConfig(options.agent, projectDir, path.resolve(getMonetDir(projectDir)), {
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
    // P1-B/P2-D (Codex round 4 on PR #42): root at resolveProjectDir(), NOT bare cwd — see
    // status's own comment above. --dir (just above) still wins outright: it sets
    // MONET_STORAGE_DIR, which getMonetDir checks BEFORE ever consulting the baseDir this passes,
    // so the explicit flag needs no extra branching here to take priority.
    ensureMonetDir(resolveProjectDir());
    const { startDashboard } = await import("./dashboard/server.js");
    startDashboard(port);
  });

registerSourceCommands(program, {
  // P1-B (Codex round 4 on PR #42): both callbacks now root their ELSE branch (no explicit --dir)
  // at resolveProjectDir(), NOT bare cwd — this is the store createSource/updateSource/etc.
  // actually OPEN and WRITE to. source-cli.ts's own deriveCircle calls already root their
  // storeDir at this SAME resolved projectDir (P1-2, round 3) — but that only fixed what
  // deriveCircle itself CONSULTED; the store openCore actually OPENED was still bare/cwd-rooted,
  // so the two could diverge under a MONET_PROJECT_DIR/CLAUDE_PROJECT_DIR override: a circle
  // resolved against project A, with the resulting row written into project B's store. Rooting
  // both at the identical resolveProjectDir() call closes that — the store opened and the store
  // consulted are now provably the same object (see circle.ts's own "THE FINAL MATRIX" comment
  // for the full per-caller audit). storageDir (the `source` command's own -d/--dir flag) still
  // wins outright when given: it sets MONET_STORAGE_DIR, which getMonetDir checks BEFORE ever
  // consulting the baseDir passed alongside it, so no extra branching is needed for the flag to
  // take priority — matching install's own existing precedent for "an explicit flag wins".
  openCore(storageDir) {
    if (storageDir) process.env.MONET_STORAGE_DIR = path.resolve(storageDir);
    const projectDir = resolveProjectDir();
    const monetDir = ensureMonetDir(projectDir);
    return openSourceCore(getDbPath(projectDir), path.join(monetDir, "sources"));
  },
  dbPath(storageDir) {
    return storageDir ? path.join(path.resolve(storageDir), "monet.db") : path.resolve(getDbPath(resolveProjectDir()));
  },
  deriveCircle,
  deriveCallerId,
  deriveProjectId,
  projectDir: resolveProjectDir,
});

registerRecoveryCommands(program);
registerGateCommands(program);
registerInstallCommands(program);
registerMaterializeCommands(program);

void program.parseAsync().catch((error: unknown) => {
  if (error instanceof FreshStoreEmbedderUnavailableError) {
    console.error(error.message);
  } else if (error instanceof SourceCliError) {
    console.error(`monet source: ${error.message}`);
  } else if (error instanceof MaterializeCliError) {
    console.error(`monet materialize: ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
