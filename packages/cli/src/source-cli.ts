import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
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
  /** P1-2 (Codex round 3 on PR #42): `opts.storeDir` roots the SQLITE CONSULTATION separately from
   *  `projectDir`'s GIT-IDENTITY root — see circle.ts's own deriveCircle for the full contract and
   *  the final per-caller matrix. Used below at the two worktree (repo-md) call sites, where the
   *  identity root (the worktree) and the store `createSource` actually writes into (the invoking
   *  project) are genuinely different directories. */
  deriveCircle(projectDir: string, opts?: { storeDir?: string }): string;
  projectDir(): string;
  /**
   * Source-authorization identity THIS machine's server will present when it calls `source_*`
   * tools — distinct from `deriveCircle` (memory-partition slug). Used to surface, at
   * registration time, the caller/project values an operator's `--allow-caller`/`--allow-project`
   * ACLs must actually match (see circle.ts's deriveCallerId/deriveProjectId).
   */
  deriveCallerId(): string;
  deriveProjectId(projectDir: string): string;
  dbPath(storageDir?: string): string;
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
  type?: "repo-md" | "git-md";
  name?: string;
  circle?: string;
  path?: string;
  remote?: string;
  branch?: string;
  include?: string[];
  exclude?: string[];
  allowCaller?: string[];
  allowProject?: string[];
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

export function printStoreLine(dbPath: string): void {
  console.error(`store: ${path.resolve(dbPath)}`);
}

function printStore(command: Command, dependencies: SourceCliDependencies): void {
  printStoreLine(dependencies.dbPath(parentOptions(command).dir));
}

interface InferredRemoteOrigin {
  remoteUrl: string;
  scheme: SourceTransportScheme;
  host: string;
  name: string;
}

function derivedRemoteName(pathname: string): string {
  const rawName = pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "") ?? "";
  if (rawName.length === 0) throw new SourceCliError("remote origin must identify a Git repository");
  try {
    return decodeURIComponent(rawName);
  } catch {
    throw new SourceCliError("remote origin contains invalid URL encoding");
  }
}

function validateSourceName(name: string): void {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    throw new SourceCliError("source name must not contain terminal control characters");
  }
}

function parseAbsoluteRemote(origin: string): InferredRemoteOrigin {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new SourceCliError("remote origin must be an absolute credential-free https or ssh URL");
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "https" && scheme !== "ssh") {
    throw new SourceCliError("remote origin scheme must be https or ssh");
  }
  if (url.password || (scheme === "https" && url.username)) {
    throw new SourceCliError("remote origin must not contain embedded credentials");
  }
  if (scheme === "ssh" && url.username && !/^[A-Za-z0-9._-]+$/.test(url.username)) {
    throw new SourceCliError("remote origin SSH user must be a credential-free username");
  }
  if (!url.hostname || url.port || url.search || url.hash) {
    throw new SourceCliError("remote origin must use an exact hostname without a port, query, or fragment");
  }
  if (/%2f|%5c/i.test(url.pathname)) {
    throw new SourceCliError("remote origin repository path must not contain encoded separators");
  }
  return {
    remoteUrl: origin,
    scheme,
    host: url.hostname.toLowerCase(),
    name: derivedRemoteName(url.pathname),
  };
}

function parseScpRemote(origin: string): InferredRemoteOrigin | undefined {
  if (!/^[^@\s]+@[^:\s]+:/.test(origin)) return undefined;
  const match = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(origin);
  if (match === null) {
    throw new SourceCliError(
      "SCP shorthand supports only git@github.com:<owner>/<repo>[.git]; use an explicit ssh:// URL otherwise",
    );
  }
  const [, owner, rawRepository] = match;
  const repository = rawRepository.replace(/\.git$/i, "");
  if (
    !/^[A-Za-z0-9._-]+$/.test(owner) ||
    !/^[A-Za-z0-9._-]+$/.test(repository) ||
    owner === "." || owner === ".." || repository === "." || repository === ".."
  ) {
    throw new SourceCliError(
      "SCP shorthand supports only git@github.com:<owner>/<repo>[.git]; use an explicit ssh:// URL otherwise",
    );
  }
  return {
    remoteUrl: `ssh://git@github.com/${owner}/${repository}`,
    scheme: "ssh",
    host: "github.com",
    name: repository,
  };
}

function inferRemoteOrigin(origin: string): InferredRemoteOrigin | undefined {
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(origin);
  if (schemeMatch !== null) return parseAbsoluteRemote(origin);
  const scp = parseScpRemote(origin);
  if (scp !== undefined) return scp;
  if (origin.includes(":") || origin.includes("@")) {
    throw new SourceCliError(
      "ambiguous remote origin; use https://, ssh://, or git@github.com:<owner>/<repo>.git",
    );
  }
  return undefined;
}

function resolveGitWorktreeRoot(projectDir: string, origin: string): string {
  const resolved = path.resolve(projectDir, origin);
  if (!existsSync(resolved)) throw new SourceCliError(`local Git origin does not exist: ${resolved}`);
  let canonical: string;
  try {
    if (!statSync(resolved).isDirectory()) throw new SourceCliError(`local Git origin is not a directory: ${resolved}`);
    canonical = realpathSync.native(resolved);
  } catch (error) {
    if (error instanceof SourceCliError) throw error;
    throw new SourceCliError(`cannot inspect local Git origin ${resolved}: ${messageFrom(error)}`);
  }

  let worktreeRoot: string;
  try {
    const output = execFileSync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    worktreeRoot = realpathSync.native(output);
  } catch {
    throw new SourceCliError(`local origin is not a Git worktree: ${canonical}`);
  }
  if (worktreeRoot !== canonical) {
    throw new SourceCliError(`local origin must be the Git worktree root: ${worktreeRoot}`);
  }
  try {
    execFileSync("git", ["-C", canonical, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new SourceCliError(`local Git origin must have a committed HEAD: ${canonical}`);
  }
  return canonical;
}

/** The caller/project identity THIS machine's server will actually present — see printSource. */
interface ServerIdentity {
  callerId: string;
  projectId: string;
}

function formatServerIdentity(identity: ServerIdentity): string {
  return `Server identity: caller ${identity.callerId} · project ${identity.projectId}`;
}

function printSource(source: KnowledgeSource, identity: ServerIdentity): void {
  console.log(`Source:     ${source.id}`);
  console.log(`Name:       ${source.name}`);
  console.log(`Type:       ${source.type}`);
  console.log(`Circle:     ${source.circle}`);
  console.log(`Status:     ${source.status}`);
  console.log(`Local path: ${source.localPath}`);
  if (source.remoteUrl !== undefined) console.log(`Remote:     ${source.remoteUrl}`);
  if (source.branch !== undefined) console.log(`Branch:     ${source.branch}`);
  // Printed right before the ACL lists it must be compared against: this is what the server
  // actually presents, Callers/Projects below are what it's allowed to be.
  console.log(formatServerIdentity(identity));
  console.log(`Callers:    ${source.access.allowedCallerIds.join(", ")}`);
  console.log(`Projects:   ${source.access.allowedProjectIds.join(", ")}`);
  console.log(`Include:    ${source.include.join(", ") || "(all Markdown paths)"}`);
  console.log(`Exclude:    ${source.exclude.join(", ") || "(none)"}`);
}

function formatRefresh(refresh: KnowledgeSource["refresh"]): string {
  if (refresh.mode === "manual") return "manual (sync only when explicitly requested)";
  const intervalSeconds = refresh.intervalSeconds!;
  const minutes = intervalSeconds / 60;
  const cadence = Number.isInteger(minutes) ? `every ${minutes}m` : `every ${intervalSeconds}s`;
  return `${cadence} (first sync runs when a server is up — \`monet start\`)`;
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
    printStore(command, dependencies);
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
      update
        ? "Replace allowed Git URL schemes (repeatable)"
        : "Allowed Git URL scheme (repeatable; required only with explicit --type git-md)",
    ).argParser((value, previous: string[] | undefined) => {
      if (value !== "https" && value !== "ssh") throw new Error("allowed choices are https, ssh");
      return collect(value, previous);
    }),
  );
  addRepeatableOption(
    command,
    "--allow-host <hostname>",
    update
      ? "Replace allowed Git hosts (repeatable)"
      : "Allowed Git host (repeatable; required only with explicit --type git-md)",
  );
  return command;
}

function buildRefresh(
  options: Pick<AddOptions, "refresh" | "intervalSeconds">,
  current?: KnowledgeSource["refresh"],
): KnowledgeSource["refresh"] | undefined {
  const seconds = parsePositiveInteger(options.intervalSeconds, "--interval-seconds");
  if (options.refresh === undefined && seconds === undefined) {
    return current === undefined ? { mode: "interval", intervalSeconds: 3600 } : undefined;
  }
  const mode = options.refresh ?? "interval";
  if (mode === "manual") {
    if (seconds !== undefined) throw new SourceCliError("--interval-seconds is valid only with --refresh interval");
    return { mode: "manual" };
  }
  const intervalSeconds = seconds ?? (current === undefined
    ? 3600
    : current.mode === "interval" ? current.intervalSeconds : undefined);
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
    .command("add <origin-or-name>")
    .description("Register a Git-backed Markdown source without syncing it")
    .addOption(new Option("--type <repo-md|git-md>", "Legacy explicit source type").choices(["repo-md", "git-md"]))
    .option("--name <name>", "Source display name (inferred mode only)")
    .option("--circle <circle>", "Source circle (repo-md defaults from its root; git-md defaults from the invocation project)")
    .option("--path <path>", "repo-md root (default: resolved project directory)")
    .option("--remote <url>", "Credential-free git-md https or ssh URL")
    .option("--branch <branch>", "Explicit git-md branch")
    .option("--write-back <mode>", "Write-back policy", "none")
    .option("--refresh <mode>", "Refresh policy (default: interval)")
    .option("--interval-seconds <seconds>", "Refresh interval when --refresh interval (default: 3600)")
    .option("--auto-detect <true|false>", "Enable or disable future automatic path detection");
  add.options.find((option) => option.long === "--write-back")?.choices(["none", "pull-request"]);
  add.options.find((option) => option.long === "--refresh")?.choices(["manual", "interval"]);
  addRepeatableOption(add, "--include <pattern>", "Included Markdown path pattern (repeatable)");
  addRepeatableOption(add, "--exclude <pattern>", "Excluded path pattern (repeatable)");
  addRepeatableOption(add, "--allow-caller <caller-id>", "Allowed caller ID (repeatable; defaults to current server identity)");
  addRepeatableOption(add, "--allow-project <project-id>", "Allowed project ID (repeatable; defaults to current server identity)");
  addTransportOptions(add);
  add.action((originOrName: string, options: AddOptions, command: Command) => {
    const projectDir = path.resolve(dependencies.projectDir());
    const identity = {
      callerId: dependencies.deriveCallerId(),
      projectId: dependencies.deriveProjectId(projectDir),
    };
    const autoDetect = parseBoolean(options.autoDetect, "--auto-detect");
    const refresh = buildRefresh(options)!;
    let input: CreateSourceInput;
    let inferredLocal = false;

    if (options.type !== undefined) {
      if (options.name !== undefined) throw new SourceCliError("--name is available only when --type is omitted");
      if (options.allowCaller === undefined || options.allowCaller.length === 0) {
        throw new SourceCliError("legacy --type syntax requires at least one --allow-caller");
      }
      if (options.allowProject === undefined || options.allowProject.length === 0) {
        throw new SourceCliError("legacy --type syntax requires at least one --allow-project");
      }
      if (options.type === "repo-md") {
        if (options.remote !== undefined || options.branch !== undefined || options.allowScheme !== undefined || options.allowHost !== undefined) {
          throw new SourceCliError("repo-md does not accept --remote, --branch, --allow-scheme, or --allow-host");
        }
        const localPath = resolveGitWorktreeRoot(projectDir, options.path ?? projectDir);
        input = {
          type: "repo-md",
          name: originOrName,
          localPath,
          // P1-2 (Codex round 3 on PR #42): identity=localPath (the WORKTREE's own remote/
          // folder-hash — correct, this is the repo actually being registered), storeDir=
          // projectDir (the INVOKING project's store — where createSource below actually writes
          // the resulting row; see circle.ts's own deriveCircle for the full matrix).
          circle: options.circle ?? dependencies.deriveCircle(localPath, { storeDir: projectDir }),
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
          name: originOrName,
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
    } else {
      if (options.remote !== undefined) {
        throw new SourceCliError("inferred syntax uses the positional origin; omit --remote");
      }
      const access = {
        allowedCallerIds: options.allowCaller ?? [identity.callerId],
        allowedProjectIds: options.allowProject ?? [identity.projectId],
      };
      // An existing filesystem path wins over URL-like punctuation. Git worktree names may
      // legitimately contain `@` or `:` on supported local filesystems.
      const localOriginExists = existsSync(path.resolve(projectDir, originOrName));
      const hasExplicitScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(originOrName);
      const remote = !hasExplicitScheme && localOriginExists ? undefined : inferRemoteOrigin(originOrName);
      if (remote === undefined) {
        if (
          options.branch !== undefined ||
          options.path !== undefined ||
          options.allowScheme !== undefined ||
          options.allowHost !== undefined
        ) {
          throw new SourceCliError(
            "local inferred origins do not accept --branch, --path, --remote, --allow-scheme, or --allow-host",
          );
        }
        const localPath = resolveGitWorktreeRoot(projectDir, originOrName);
        inferredLocal = true;
        input = {
          type: "repo-md",
          name: options.name ?? path.basename(localPath),
          localPath,
          // P1-2 (Codex round 3 on PR #42): identity=localPath (the WORKTREE's own remote/
          // folder-hash — correct, this is the repo actually being registered), storeDir=
          // projectDir (the INVOKING project's store — where createSource below actually writes
          // the resulting row; see circle.ts's own deriveCircle for the full matrix).
          circle: options.circle ?? dependencies.deriveCircle(localPath, { storeDir: projectDir }),
          include: options.include ?? ["**/*.md"],
          exclude: options.exclude,
          access,
          writeBack: options.writeBack,
          refresh,
          ...(autoDetect === undefined ? {} : { autoDetect }),
        };
      } else {
        if (options.path !== undefined) throw new SourceCliError("remote inferred origins do not accept --path");
        if (options.branch === undefined) throw new SourceCliError("remote Git origin requires --branch");
        const allowedUrlSchemes = options.allowScheme ?? [remote.scheme];
        const allowedHosts = options.allowHost ?? [remote.host];
        if (allowedUrlSchemes.some((scheme) => scheme !== remote.scheme)) {
          throw new SourceCliError(`inferred remote transport may allow only its exact ${remote.scheme} scheme`);
        }
        if (allowedHosts.some((host) => host.toLowerCase() !== remote.host)) {
          throw new SourceCliError(`inferred remote transport may allow only its exact ${remote.host} host`);
        }
        input = {
          type: "git-md",
          name: options.name ?? remote.name,
          remoteUrl: remote.remoteUrl,
          branch: options.branch,
          circle: options.circle ?? dependencies.deriveCircle(projectDir),
          include: options.include ?? ["**/*.md"],
          exclude: options.exclude,
          access,
          transport: { allowedUrlSchemes, allowedHosts },
          writeBack: options.writeBack,
          refresh,
          ...(autoDetect === undefined ? {} : { autoDetect }),
        };
      }
    }
    validateSourceName(input.name);

    return withCore(command, dependencies, (core) => {
      const created = core.createSource(input);
      console.log(`Registered source: ${created.id}`);
      console.log(`Name: ${created.name}`);
      console.log(`Type: ${created.type}`);
      console.log(`Status: ${created.status}`);
      console.log(`Origin: ${created.remoteUrl ?? created.localPath}`);
      console.log(`Local path: ${created.localPath}`);
      if (inferredLocal) console.log("Committed HEAD: required; sync excludes working-tree changes");
      console.log(`ACL callers: ${created.access.allowedCallerIds.join(", ")}`);
      console.log(`ACL projects: ${created.access.allowedProjectIds.join(", ")}`);
      if (created.transport !== undefined) {
        console.log(`Transport schemes: ${created.transport.allowedUrlSchemes.join(", ")}`);
        console.log(`Transport hosts: ${created.transport.allowedHosts.join(", ")}`);
      }
      console.log(`refresh: ${formatRefresh(created.refresh)}`);
      console.log("Content sync: not run");
      console.log(`Next step: ask a connected agent to call MCP source_sync with {"sourceId":"${created.id}"}`);
      // The ACLs above are only useful if the operator knows what THIS server actually presents —
      // surface it so --allow-caller/--allow-project can be checked against reality, not guesswork.
      console.log(formatServerIdentity(identity));
    });
  });

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
        else {
          const projectDir = path.resolve(dependencies.projectDir());
          printSource(registered, {
            callerId: dependencies.deriveCallerId(),
            projectId: dependencies.deriveProjectId(projectDir),
          });
        }
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
