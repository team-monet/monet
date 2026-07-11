import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { Command, Option } from "commander";
import type {
  CreateSourceInput,
  KnowledgeSource,
  SourceTransportScheme,
  UpdateSourceInput,
} from "@team-monet/core";

export interface SourceCore {
  createSource(input: CreateSourceInput): KnowledgeSource;
  updateSource(id: string, patch: UpdateSourceInput): KnowledgeSource;
  listSources(options?: { includeTombstoned?: boolean }): KnowledgeSource[];
  getSource(id: string, options?: { includeTombstoned?: boolean }): KnowledgeSource | null;
  removeSource(id: string): KnowledgeSource | null;
  close(): void;
}

export interface SourceCliDependencies {
  openCore(storageDir?: string): SourceCore;
  deriveCircle(projectDir: string): string;
  projectDir(): string;
}

export class SourceCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceCliError";
  }
}

interface SourceParentOptions {
  dir?: string;
}

interface AddOptions {
  type: "repo-md" | "git-md";
  circle?: string;
  path?: string;
  remote?: string;
  branch?: string;
  include?: string[];
  exclude?: string[];
  allowCaller: string[];
  allowProject: string[];
  allowScheme?: SourceTransportScheme[];
  allowHost?: string[];
  writeBack?: "none" | "pull-request";
  refresh?: "manual" | "interval";
  intervalSeconds?: string;
  autoDetect?: string;
}

interface UpdateOptions {
  name?: string;
  include?: string[];
  exclude?: string[];
  clearIncludes?: boolean;
  clearExcludes?: boolean;
  allowCaller?: string[];
  allowProject?: string[];
  allowScheme?: SourceTransportScheme[];
  allowHost?: string[];
  writeBack?: "none" | "pull-request";
  refresh?: "manual" | "interval";
  intervalSeconds?: string;
  autoDetect?: string;
}

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new SourceCliError(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new SourceCliError(`${flag} must be a positive integer`);
  return parsed;
}

function parseBoolean(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new SourceCliError(`${flag} must be true or false`);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function resolveRepoRoot(projectDir: string, configuredPath: string | undefined): string {
  const resolved = path.resolve(projectDir, configuredPath ?? projectDir);
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
}

function printSource(source: KnowledgeSource): void {
  console.log(`Source:     ${source.id}`);
  console.log(`Name:       ${source.name}`);
  console.log(`Type:       ${source.type}`);
  console.log(`Circle:     ${source.circle}`);
  console.log(`Status:     ${source.status}`);
  console.log(`Local path: ${source.localPath}`);
  if (source.remoteUrl !== undefined) console.log(`Remote:     ${source.remoteUrl}`);
  if (source.branch !== undefined) console.log(`Branch:     ${source.branch}`);
  console.log(`Callers:    ${source.access.allowedCallerIds.join(", ")}`);
  console.log(`Projects:   ${source.access.allowedProjectIds.join(", ")}`);
  console.log(`Include:    ${source.include.join(", ") || "(all Markdown paths)"}`);
  console.log(`Exclude:    ${source.exclude.join(", ") || "(none)"}`);
}

function printSourceTable(sources: KnowledgeSource[]): void {
  const headers = ["ID", "NAME", "TYPE", "CIRCLE", "STATUS", "LOCAL PATH"];
  const rows = sources.map((source) => [
    source.id,
    source.name,
    source.type,
    source.circle,
    source.status,
    source.localPath,
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index].length)));
  const render = (row: string[]) => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd();
  console.log(render(headers));
  for (const row of rows) console.log(render(row));
}

function parentOptions(command: Command): SourceParentOptions {
  return command.optsWithGlobals() as SourceParentOptions;
}

function withCore<T>(command: Command, dependencies: SourceCliDependencies, action: (core: SourceCore) => T): T {
  let core: SourceCore | undefined;
  try {
    core = dependencies.openCore(parentOptions(command).dir);
    return action(core);
  } catch (error) {
    if (error instanceof SourceCliError) throw error;
    throw new SourceCliError(messageFrom(error));
  } finally {
    core?.close();
  }
}

function addRepeatableOption(command: Command, flags: string, description: string, mandatory = false): Command {
  const option = new Option(flags, description).argParser(collect);
  if (mandatory) option.makeOptionMandatory();
  return command.addOption(option);
}

function addTransportOptions(command: Command, update = false): Command {
  command.addOption(
    new Option(
      "--allow-scheme <https|ssh>",
      update ? "Replace allowed Git URL schemes (repeatable)" : "Allowed Git URL scheme (repeatable; required for git-md)",
    ).argParser((value, previous: string[] | undefined) => {
      if (value !== "https" && value !== "ssh") throw new Error("allowed choices are https, ssh");
      return collect(value, previous);
    }),
  );
  addRepeatableOption(
    command,
    "--allow-host <hostname>",
    update ? "Replace allowed Git hosts (repeatable)" : "Allowed Git host (repeatable; required for git-md)",
  );
  return command;
}

function buildRefresh(
  options: Pick<AddOptions, "refresh" | "intervalSeconds">,
  current?: KnowledgeSource["refresh"],
): KnowledgeSource["refresh"] | undefined {
  const seconds = parsePositiveInteger(options.intervalSeconds, "--interval-seconds");
  if (options.refresh === undefined && seconds === undefined) return undefined;
  const mode = options.refresh ?? "interval";
  if (mode === "manual") {
    if (seconds !== undefined) throw new SourceCliError("--interval-seconds is valid only with --refresh interval");
    return { mode: "manual" };
  }
  const intervalSeconds = seconds ?? (current?.mode === "interval" ? current.intervalSeconds : undefined);
  if (intervalSeconds === undefined) throw new SourceCliError("--refresh interval requires --interval-seconds");
  return { mode: "interval", intervalSeconds };
}

export function registerSourceCommands(program: Command, dependencies: SourceCliDependencies): Command {
  const source = program
    .command("source")
    .description("Configure registered Markdown sources (registry only; does not sync content)")
    .option("-d, --dir <directory>", "Storage directory (default: .monet or ~/.monet)")
    .configureOutput({
      outputError: (text, write) => write(text.replace(/^error:/, "monet source:")),
    });

  const add = source
    .command("add <name>")
    .description("Register a Markdown source without syncing it")
    .addOption(new Option("--type <repo-md|git-md>", "Source type").choices(["repo-md", "git-md"]).makeOptionMandatory())
    .option("--circle <circle>", "Source circle (repo-md defaults from its root; git-md defaults from the invocation project)")
    .option("--path <path>", "repo-md root (default: resolved project directory)")
    .option("--remote <url>", "Credential-free git-md https or ssh URL")
    .option("--branch <branch>", "Explicit git-md branch")
    .option("--write-back <mode>", "Write-back policy", "none")
    .option("--refresh <mode>", "Refresh policy", "manual")
    .option("--interval-seconds <seconds>", "Refresh interval when --refresh interval")
    .option("--auto-detect <true|false>", "Enable or disable future automatic path detection");
  add.options.find((option) => option.long === "--write-back")?.choices(["none", "pull-request"]);
  add.options.find((option) => option.long === "--refresh")?.choices(["manual", "interval"]);
  addRepeatableOption(add, "--include <pattern>", "Included Markdown path pattern (repeatable)");
  addRepeatableOption(add, "--exclude <pattern>", "Excluded path pattern (repeatable)");
  addRepeatableOption(add, "--allow-caller <caller-id>", "Allowed caller ID (repeatable)", true);
  addRepeatableOption(add, "--allow-project <project-id>", "Allowed project ID (repeatable)", true);
  addTransportOptions(add);
  add.action((name: string, options: AddOptions, command: Command) => withCore(command, dependencies, (core) => {
    const projectDir = path.resolve(dependencies.projectDir());
    const autoDetect = parseBoolean(options.autoDetect, "--auto-detect");
    const refresh = buildRefresh(options) ?? { mode: "manual" as const };
    let input: CreateSourceInput;

    if (options.type === "repo-md") {
      if (options.remote !== undefined || options.branch !== undefined || options.allowScheme !== undefined || options.allowHost !== undefined) {
        throw new SourceCliError("repo-md does not accept --remote, --branch, --allow-scheme, or --allow-host");
      }
      const localPath = resolveRepoRoot(projectDir, options.path);
      input = {
        type: "repo-md",
        name,
        localPath,
        circle: options.circle ?? dependencies.deriveCircle(localPath),
        include: options.include,
        exclude: options.exclude,
        access: { allowedCallerIds: options.allowCaller, allowedProjectIds: options.allowProject },
        writeBack: options.writeBack,
        refresh,
        ...(autoDetect === undefined ? {} : { autoDetect }),
      };
    } else {
      if (options.path !== undefined) throw new SourceCliError("git-md local paths are allocated by Monet; omit --path");
      if (options.remote === undefined) throw new SourceCliError("git-md requires --remote");
      if (options.branch === undefined) throw new SourceCliError("git-md requires --branch");
      if (options.allowScheme === undefined || options.allowScheme.length === 0) {
        throw new SourceCliError("git-md requires at least one --allow-scheme");
      }
      if (options.allowHost === undefined || options.allowHost.length === 0) {
        throw new SourceCliError("git-md requires at least one --allow-host");
      }
      input = {
        type: "git-md",
        name,
        remoteUrl: options.remote,
        branch: options.branch,
        circle: options.circle ?? dependencies.deriveCircle(projectDir),
        include: options.include,
        exclude: options.exclude,
        access: { allowedCallerIds: options.allowCaller, allowedProjectIds: options.allowProject },
        transport: { allowedUrlSchemes: options.allowScheme, allowedHosts: options.allowHost },
        writeBack: options.writeBack,
        refresh,
        ...(autoDetect === undefined ? {} : { autoDetect }),
      };
    }

    const created = core.createSource(input);
    console.log(`Configured source ${created.id} (${created.name})`);
    console.log(`Status: ${created.status}`);
    console.log(`Local path: ${created.localPath}`);
    console.log("Content sync: not run");
  }));

  source
    .command("list")
    .description("List registered sources")
    .option("--include-tombstoned", "Include removed sources", false)
    .option("--json", "Print stable JSON", false)
    .action((options: { includeTombstoned: boolean; json: boolean }, command: Command) => withCore(command, dependencies, (core) => {
      const sources = core.listSources({ includeTombstoned: options.includeTombstoned });
      if (options.json) printJson(sources);
      else printSourceTable(sources);
    }));

  source
    .command("show <source-id>")
    .description("Show one registered source")
    .option("--include-tombstoned", "Allow showing a removed source", false)
    .option("--json", "Print stable JSON", false)
    .option("--path-only", "Print exactly the absolute local path", false)
    .action((sourceId: string, options: { includeTombstoned: boolean; json: boolean; pathOnly: boolean }, command: Command) =>
      withCore(command, dependencies, (core) => {
        if (options.json && options.pathOnly) throw new SourceCliError("--json and --path-only cannot be used together");
        const registered = core.getSource(sourceId, { includeTombstoned: options.includeTombstoned });
        if (registered === null) throw new SourceCliError(`source not found: ${sourceId}`);
        if (options.pathOnly) console.log(registered.localPath);
        else if (options.json) printJson(registered);
        else printSource(registered);
      }),
    );

  const update = source
    .command("update <source-id>")
    .description("Update mutable source configuration")
    .option("--name <name>", "Replace source display name")
    .option("--clear-includes", "Replace include patterns with an empty list", false)
    .option("--clear-excludes", "Replace exclude patterns with an empty list", false)
    .option("--write-back <mode>", "Replace write-back policy")
    .option("--refresh <mode>", "Replace refresh policy")
    .option("--interval-seconds <seconds>", "Refresh interval when --refresh interval")
    .option("--auto-detect <true|false>", "Enable or disable future automatic path detection");
  update.options.find((option) => option.long === "--write-back")?.choices(["none", "pull-request"]);
  update.options.find((option) => option.long === "--refresh")?.choices(["manual", "interval"]);
  addRepeatableOption(update, "--include <pattern>", "Replace include patterns (repeatable)");
  addRepeatableOption(update, "--exclude <pattern>", "Replace exclude patterns (repeatable)");
  addRepeatableOption(update, "--allow-caller <caller-id>", "Replace allowed caller IDs (repeatable)");
  addRepeatableOption(update, "--allow-project <project-id>", "Replace allowed project IDs (repeatable)");
  addTransportOptions(update, true);
  update.action((sourceId: string, options: UpdateOptions, command: Command) => withCore(command, dependencies, (core) => {
    if (options.include !== undefined && options.clearIncludes) {
      throw new SourceCliError("--include and --clear-includes cannot be used together");
    }
    if (options.exclude !== undefined && options.clearExcludes) {
      throw new SourceCliError("--exclude and --clear-excludes cannot be used together");
    }
    const current = core.getSource(sourceId);
    if (current === null) throw new SourceCliError(`source not found: ${sourceId}`);
    if (current.type === "repo-md" && (options.allowScheme !== undefined || options.allowHost !== undefined)) {
      throw new SourceCliError("repo-md does not have a Git transport policy");
    }

    const patch: UpdateSourceInput = {};
    if (options.name !== undefined) patch.name = options.name;
    if (options.include !== undefined || options.clearIncludes) patch.include = options.clearIncludes ? [] : options.include;
    if (options.exclude !== undefined || options.clearExcludes) patch.exclude = options.clearExcludes ? [] : options.exclude;
    if (options.allowCaller !== undefined || options.allowProject !== undefined) {
      patch.access = {
        allowedCallerIds: options.allowCaller ?? current.access.allowedCallerIds,
        allowedProjectIds: options.allowProject ?? current.access.allowedProjectIds,
      };
    }
    if (options.allowScheme !== undefined || options.allowHost !== undefined) {
      patch.transport = {
        allowedUrlSchemes: options.allowScheme ?? current.transport!.allowedUrlSchemes,
        allowedHosts: options.allowHost ?? current.transport!.allowedHosts,
      };
    }
    if (options.writeBack !== undefined) patch.writeBack = options.writeBack;
    const refresh = buildRefresh(options, current.refresh);
    if (refresh !== undefined) patch.refresh = refresh;
    const autoDetect = parseBoolean(options.autoDetect, "--auto-detect");
    if (autoDetect !== undefined) patch.autoDetect = autoDetect;
    if (Object.keys(patch).length === 0) throw new SourceCliError("no mutable source fields were provided");

    const updated = core.updateSource(sourceId, patch);
    console.log(`Updated source ${updated.id}`);
    console.log(`Status: ${updated.status}`);
  }));

  source
    .command("remove <source-id>")
    .description("Tombstone a registered source without deleting its path")
    .requiredOption("--yes", "Confirm source removal")
    .action((sourceId: string, _options: { yes: boolean }, command: Command) => withCore(command, dependencies, (core) => {
      const removed = core.removeSource(sourceId);
      if (removed === null) throw new SourceCliError(`source not found: ${sourceId}`);
      console.log(`Removed source ${removed.id}`);
      console.log(`Status: ${removed.status}`);
      console.log("Local path was not deleted");
    }));

  return source;
}
