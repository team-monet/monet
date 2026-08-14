import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  assertManagedDirectoryTrust, freezeSameDeviceTree, removeFrozenSameDeviceTree, revalidateSameDeviceTree,
} from "./source-safe-remove";
import type { FrozenSameDeviceTree, SafeTreeOps } from "./source-safe-remove";
import type { KnowledgeSource } from "./source-types";

const OID_RE = /^[0-9a-f]{40,64}$/;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_REPOSITORY_BYTES = 512 * 1024 * 1024;
const FETCH_METADATA_ALLOWANCE_BYTES = 16 * 1024;
const REMOTE_KILL_GRACE_MS = 250;
const MAX_KNOWN_HOSTS_BYTES = 1024 * 1024;
const MAX_KNOWN_HOSTS_LINES = 10_000;
const LEGACY_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export interface GitCredential { username: string; password: string }
export interface GitCredentialRequest { protocol: "https"; host: string; path: string }
export interface GitCredentialProvider { get(request: GitCredentialRequest): Promise<GitCredential | null> }
export interface GitKnownHostsProvider { get(): Promise<string | null> }

export interface RemoteGitOptions {
  /** Legacy test seam; production remote execution uses the process-group-owning spawn path. */
  execFile?: typeof nodeExecFile;
  /** Test seam for the process-group-owning production runner. */
  spawn?: typeof nodeSpawn;
  credentialProvider?: GitCredentialProvider;
  /** Explicit trusted SSH host-key store; defaults to the caller's canonical ~/.ssh/known_hosts. */
  sshKnownHostsPath?: string;
  sshKnownHostsProvider?: GitKnownHostsProvider;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxRepositoryBytes?: number;
  token?: () => string;
  /** Test-only fault immediately after the private credential-helper directory is created. */
  credentialHelperFault?: () => void;
  /** Test/telemetry seam reporting bytes intercepted before index-pack. */
  onPackBytes?: (observedBytes: number, limitBytes: number, exceeded: boolean) => void;
  /** Test/telemetry seam reporting aggregate logical bytes in the fresh staging repository. */
  onStagingBytes?: (observedBytes: number, limitBytes: number, exceeded: boolean) => void;
  /** Test seam for recursive device-boundary validation and deletion. */
  safeTreeOps?: SafeTreeOps;
}

interface FrozenKnownHosts { path: string; parent: string; dev: number; ino: number; size: number; digest: string }

function knownHostsOwnerIsSafe(entry: ReturnType<typeof fstatSync>): boolean {
  return typeof process.getuid !== "function" || entry.uid === process.getuid();
}

function readKnownHostsBytes(fd: number, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, bytes, offset, size - offset, offset);
    if (read === 0) throw new Error("trusted SSH known_hosts store changed while being snapshotted");
    offset += read;
  }
  return bytes;
}

function sameKnownHostsEntry(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function snapshotKnownHosts(sourcePath: string, privateHome: string, assertOwnership: () => void): FrozenKnownHosts {
  const requested = resolve(sourcePath);
  let sourceFd: number | null = null;
  let privateFd: number | null = null;
  const privatePath = join(privateHome, "known_hosts");
  try {
    assertOwnership();
    const pathEntry = lstatSync(requested);
    const canonical = realpathSync.native(requested);
    if (!pathEntry.isFile() || pathEntry.isSymbolicLink() || pathEntry.nlink !== 1 || canonical !== requested) {
      throw new Error("trusted SSH known_hosts store is not a canonical regular file");
    }
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    sourceFd = openSync(requested, constants.O_RDONLY | noFollow);
    const before = fstatSync(sourceFd);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== pathEntry.dev || before.ino !== pathEntry.ino
        || !knownHostsOwnerIsSafe(before) || (before.mode & 0o022) !== 0) {
      throw new Error("trusted SSH known_hosts store has unsafe ownership or permissions");
    }
    if (before.size > MAX_KNOWN_HOSTS_BYTES) throw new Error("trusted SSH known_hosts store exceeds its byte limit");
    const first = readKnownHostsBytes(sourceFd, before.size);
    const middle = fstatSync(sourceFd);
    const second = readKnownHostsBytes(sourceFd, before.size);
    const after = fstatSync(sourceFd);
    if (!sameKnownHostsEntry(before, middle) || !sameKnownHostsEntry(middle, after) || !first.equals(second)) {
      throw new Error("trusted SSH known_hosts store changed while being snapshotted");
    }
    const lines = first.length === 0 ? 0 : first.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0)
      + (first[first.length - 1] === 0x0a ? 0 : 1);
    if (lines > MAX_KNOWN_HOSTS_LINES) throw new Error("trusted SSH known_hosts store exceeds its line limit");
    assertOwnership();
    privateFd = openSync(privatePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    writeFileSync(privateFd, first);
    fsyncSync(privateFd);
    fchmodSync(privateFd, 0o400);
    fsyncSync(privateFd);
    const frozen = fstatSync(privateFd);
    if (!frozen.isFile() || frozen.nlink !== 1 || !knownHostsOwnerIsSafe(frozen)) {
      throw new Error("private SSH known_hosts snapshot is unsafe");
    }
    assertOwnership();
    fsyncDirectory(privateHome);
    return {
      path: privatePath, parent: privateHome, dev: frozen.dev, ino: frozen.ino, size: first.length,
      digest: createHash("sha256").update(first).digest("hex"),
    };
  } catch (error) {
    try { rmSync(privatePath, { force: true }); } catch { /* best-effort private snapshot cleanup */ }
    throw error;
  } finally {
    if (privateFd !== null) closeSync(privateFd);
    if (sourceFd !== null) closeSync(sourceFd);
  }
}

async function waitForGitProvider<T>(
  label: string, options: RemoteGitOptions, assertOwnership: () => void, get: () => Promise<T>,
): Promise<T> {
  const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10 * 60_000, `${label} timeout`);
  return new Promise<T>((resolveResult, rejectResult) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(ownershipMonitor);
      callback();
    };
    const reject = (error: unknown): void => finish(() => rejectResult(error));
    const rejectProvider = (): void => reject(new Error(`${label} failed`));
    const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    timeout.unref();
    const ownershipMonitor = setInterval(() => {
      try { assertOwnership(); } catch (error) { reject(error); }
    }, 10);
    ownershipMonitor.unref();
    try { assertOwnership(); } catch (error) { reject(error); return; }
    // Always retain both fulfillment and rejection handlers. If timeout or lock
    // cancellation wins, a provider's eventual result is inert and cannot
    // become an unhandled rejection or resume setup work.
    Promise.resolve().then(get).then(
      (value) => {
        try { assertOwnership(); } catch (error) { reject(error); return; }
        finish(() => resolveResult(value));
      },
      rejectProvider,
    );
  });
}

async function trustedKnownHostsPath(
  remote: URL, options: RemoteGitOptions, assertOwnership: () => void,
): Promise<string | null> {
  if (remote.protocol !== "ssh:") return null;
  assertOwnership();
  const supplied = options.sshKnownHostsProvider
    ? await waitForGitProvider("Git SSH known_hosts provider", options, assertOwnership, () => options.sshKnownHostsProvider!.get())
    : options.sshKnownHostsPath ?? join(homedir(), ".ssh", "known_hosts");
  assertOwnership();
  if (!supplied) throw new Error("trusted SSH known_hosts store is required");
  return supplied;
}

function trustedKnownHosts(
  supplied: string | null, privateHome: string, assertOwnership: () => void,
): FrozenKnownHosts | null {
  if (!supplied) return null;
  try {
    return snapshotKnownHosts(supplied, privateHome, assertOwnership);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("trusted SSH known_hosts store is unavailable");
    throw error;
  }
}

function revalidateKnownHosts(store: FrozenKnownHosts): void {
  const entry = lstatSync(store.path);
  if (dirname(store.path) !== store.parent || !entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
      || realpathSync.native(store.path) !== store.path || entry.dev !== store.dev || entry.ino !== store.ino
      || entry.size !== store.size || !knownHostsOwnerIsSafe(entry) || (entry.mode & 0o777) !== 0o400
      || createHash("sha256").update(readFileSync(store.path)).digest("hex") !== store.digest) {
    throw new Error("private SSH known_hosts snapshot changed before network use");
  }
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

type GitObjectFormat = "sha1" | "sha256";

function safeConfig(format: GitObjectFormat): string {
  return `[core]\n\trepositoryformatversion = ${format === "sha256" ? 1 : 0}\n\tfilemode = true\n\tbare = true\n\tlogallrefupdates = false\n${format === "sha256" ? "[extensions]\n\tobjectformat = sha256\n" : ""}[gc]\n\tauto = 0\n`;
}

function configObjectFormat(config: string): GitObjectFormat | null {
  if (config === safeConfig("sha1")) return "sha1";
  if (config === safeConfig("sha256")) return "sha256";
  return null;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Environment shared by every Git invocation against Monet-managed repositories. */
export function managedGitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "SSH_AUTH_SOCK"]) if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_NO_REPLACE_OBJECTS: "1",
    ...extra,
  };
}

function privateGitHome(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "monet-git-env-"));
  try {
    chmodSync(root, 0o700);
    const home = join(root, "home");
    const xdg = join(root, "xdg");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(xdg, { mode: 0o700 });
    return {
      env: { HOME: home, XDG_CONFIG_HOME: xdg, CURL_HOME: home, NETRC: "/dev/null" },
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type GitArtifactKind = "clone" | "corrupt" | "repo";

function artifactName(kind: GitArtifactKind, sourceId: string, token: string): string {
  return `.${kind}.${sourceId}.${token}`;
}

/** New dot-delimited names are exact; legacy names are owned only with a canonical UUID suffix. */
function artifactOwnership(name: string, kind: GitArtifactKind, sourceId: string): "owned" | "ambiguous" | "foreign" {
  const current = new RegExp(`^\\.${kind}\\.${escapeRegExp(sourceId)}\\.[A-Za-z0-9][A-Za-z0-9-]{0,127}$`);
  if (current.test(name)) return "owned";
  const legacy = new RegExp(`^\\.${kind}-(.+)-(${LEGACY_UUID})$`, "i").exec(name);
  if (legacy) return legacy[1] === sourceId ? "owned" : "foreign";
  return name.startsWith(`.${kind}-${sourceId}-`) ? "ambiguous" : "foreign";
}

function bounded(value: number | undefined, fallback: number, cap: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > cap) throw new Error(`invalid ${label}`);
  return result;
}

/** Hardened Git process seam for remote operations. No shell or inherited Git configuration is used. */
export async function runRemoteGit(
  args: readonly string[], cwd: string, options: RemoteGitOptions = {}, extraEnv: NodeJS.ProcessEnv = {}, secrets: readonly string[] = [],
  fileSizeLimitBytes?: number,
  assertOwnership: () => void = () => undefined,
): Promise<string> {
  const timeout = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, 10 * 60_000, "Git timeout");
  const maxBuffer = bounded(options.maxOutputBytes, DEFAULT_OUTPUT_BYTES, 16 * 1024 * 1024, "Git output limit");
  const fixed = [
    "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never",
    "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always",
    "-c", "http.followRedirects=false", "-c", "fetch.recurseSubmodules=false", "-c", "submodule.recurse=false",
    "-c", "credential.helper=", "-c", "credential.useHttpPath=true", "-c", "filter.lfs.required=false",
  ];
  if (fileSizeLimitBytes !== undefined && (!Number.isSafeInteger(fileSizeLimitBytes) || fileSizeLimitBytes < 1)) {
    throw new Error("invalid Git file-size limit");
  }
  if (fileSizeLimitBytes !== undefined && process.platform === "win32") {
    throw new Error("managed git-md hard transfer quota is unavailable on this platform");
  }
  // Both macOS /bin/sh and the supported Linux shells express `ulimit -f`
  // in units no larger than 1024 bytes. Flooring therefore makes the kernel
  // ceiling conservative on shells that use 512-byte units. The constant
  // script receives every value positionally; no URL, ref, path, or secret is
  // interpolated into shell source.
  const executable = fileSizeLimitBytes === undefined ? "git" : "/bin/sh";
  const commandArgs = fileSizeLimitBytes === undefined ? [...fixed, ...args] : [
    "-c", 'ulimit -f "$1" || exit 70; shift; exec git "$@"', "monet-git-limit",
    String(Math.floor(fileSizeLimitBytes / 1024)), ...fixed, ...args,
  ];
  const explicitGitDir = args.find((arg) => arg.startsWith("--git-dir="))?.slice("--git-dir=".length);
  try {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolveResult, reject) => {
      let child: ReturnType<typeof nodeSpawn> | undefined;
      let ownershipError: Error | null = null;
      let settled = false;
      let deadlineError: Error | null = null;
      let hardKill: ReturnType<typeof setTimeout> | null = null;
      let closeBound: ReturnType<typeof setTimeout> | null = null;
      let childEnv: NodeJS.ProcessEnv | null = null;
      const killTree = (signal: NodeJS.Signals): void => {
        if (!child) return;
        if (process.platform !== "win32" && child.pid) {
          try { process.kill(-child.pid, signal); return; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              try { child.kill(signal); } catch { /* best-effort after group-kill failure */ }
              return;
            }
          }
        }
        try { child.kill(signal); } catch { /* child may already have closed */ }
      };
      const clearTimers = (): void => {
        clearInterval(monitor);
        clearTimeout(deadline);
        if (hardKill) clearTimeout(hardKill);
        if (closeBound) clearTimeout(closeBound);
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (childEnv) {
          for (const [key, value] of Object.entries(childEnv)) {
            if (value !== undefined && secrets.includes(value)) delete childEnv[key];
          }
        }
        callback();
      };
      const terminate = (error: Error, immediate: boolean): void => {
        if (settled) return;
        if (immediate) ownershipError = error;
        else deadlineError = error;
        killTree(immediate ? "SIGKILL" : "SIGTERM");
        if (!immediate) {
          hardKill = setTimeout(() => killTree("SIGKILL"), REMOTE_KILL_GRACE_MS);
          hardKill.unref();
        }
        // A helper that inherited stdio must not retain the source lock forever.
        closeBound = setTimeout(() => finish(() => reject(error)), immediate
          ? REMOTE_KILL_GRACE_MS : REMOTE_KILL_GRACE_MS * 2);
        closeBound.unref();
      };
      const monitor = setInterval(() => {
        try { assertOwnership(); } catch (error) {
          terminate(error instanceof Error ? error : new Error(String(error)), true);
        }
      }, 10);
      monitor.unref();
      const deadline = setTimeout(() => terminate(new Error("remote Git timed out"), false), timeout);
      deadline.unref();
      try { assertOwnership(); } catch (error) { finish(() => reject(error)); return; }
      childEnv = managedGitEnvironment({ ...extraEnv, ...(explicitGitDir ? { GIT_COMMON_DIR: explicitGitDir } : {}) });
      if (options.execFile && !options.spawn) {
        child = options.execFile(executable, commandArgs, {
          cwd, encoding: "utf8", maxBuffer, env: childEnv, windowsHide: true,
        }, (error, stdout, stderr) => {
          if (error) killTree("SIGKILL");
          if (!ownershipError) {
            try { assertOwnership(); } catch (assertionError) {
              ownershipError = assertionError instanceof Error ? assertionError : new Error(String(assertionError));
            }
          }
          finish(() => {
            if (ownershipError) reject(ownershipError);
            else if (deadlineError) reject(deadlineError);
            else if (error) reject(Object.assign(error, { stdout, stderr }));
            else resolveResult({ stdout: String(stdout), stderr: String(stderr) });
          });
        });
      } else {
        child = (options.spawn ?? nodeSpawn)(executable, commandArgs, {
          cwd, env: childEnv, windowsHide: true, detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let outputError: Error | null = null;
        const collect = (chunks: Buffer[], chunk: Buffer, stderrStream: boolean): void => {
          if (outputError) return;
          if (stderrStream) stderrBytes += chunk.length; else stdoutBytes += chunk.length;
          if ((stderrStream ? stderrBytes : stdoutBytes) > maxBuffer) {
            outputError = new Error("remote Git output exceeded its byte limit");
            killTree("SIGKILL");
            return;
          }
          chunks.push(chunk);
        };
        child.stdout!.on("data", (chunk: Buffer) => collect(stdout, chunk, false));
        child.stderr!.on("data", (chunk: Buffer) => collect(stderr, chunk, true));
        child.once("error", (error) => finish(() => reject(error)));
        child.once("close", (code, signal) => {
          if (!ownershipError) {
            try { assertOwnership(); } catch (assertionError) {
              ownershipError = assertionError instanceof Error ? assertionError : new Error(String(assertionError));
            }
          }
          finish(() => {
            if (ownershipError) reject(ownershipError);
            else if (deadlineError) reject(deadlineError);
            else if (outputError) reject(outputError);
            else if (code !== 0) reject(new Error(`Git exited with ${signal ?? code}`));
            else resolveResult({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
          });
        });
      }
      if (settled) clearTimers();
    });
    return result.stdout.trim();
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of secrets.filter(Boolean)) message = message.split(secret).join("[REDACTED]");
    throw new Error(`remote Git failed: ${message.slice(0, 4096)}`);
  }
}

function validateManagedRefs(repository: string, format: GitObjectFormat, check: () => void = () => undefined): void {
  const allowed = "refs/monet/candidate";
  const refs = join(repository, "refs");
  const walk = (path: string, rel: string): void => {
    check();
    const names = readdirSync(path);
    check();
    for (const name of names) {
      check();
      const absolute = join(path, name);
      const next = rel ? `${rel}/${name}` : name;
      const entry = lstatSync(absolute);
      if (entry.isSymbolicLink()) throw new Error("managed git-md ref namespace contains a symlink");
      if (entry.isDirectory()) walk(absolute, next);
      else if (!entry.isFile() || entry.nlink !== 1 || `refs/${next}` !== allowed) {
        throw new Error("managed git-md repository contains an unmanaged ref namespace");
      }
    }
  };
  walk(refs, "");
  try {
    check();
    const packed = join(repository, "packed-refs");
    const entry = lstatSync(packed);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("managed git-md packed refs are poisoned");
    if (entry.size > 4096) throw new Error("managed git-md packed refs exceed their bounded inventory");
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      check();
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const match = new RegExp(`^[0-9a-f]{${format === "sha256" ? 64 : 40}} (refs/[^\\s]+)$`).exec(line);
      if (!match || match[1] !== allowed) throw new Error("managed git-md packed refs contain an unmanaged namespace");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function rejectManagedGitRedirections(repository: string): void {
  for (const path of [
    join(repository, "commondir"), join(repository, "gitdir"), join(repository, "config.worktree"),
    join(repository, "objects", "info", "alternates"), join(repository, "objects", "info", "http-alternates"),
  ]) {
    try {
      lstatSync(path);
      throw new Error("managed git-md repository contains forbidden common-dir redirection");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Cheap pre-exec guard; full repository validation is performed at phase boundaries. */
export function validateManagedGitInvocation(repository: string): void {
  const root = dirname(repository);
  const entry = assertManagedDirectoryTrust(repository, "managed git-md repository", {}, true);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync.native(repository) !== repository || !contained(root, repository)) {
    throw new Error("managed git-md repository is not a canonical real directory");
  }
  rejectManagedGitRedirections(repository);
}

export function validateManagedGitRepository(repository: string, check: () => void = () => undefined): void {
  check();
  validateManagedGitInvocation(repository);
  const config = join(repository, "config");
  const configEntry = lstatSync(config);
  const configLengths = new Set([Buffer.byteLength(safeConfig("sha1")), Buffer.byteLength(safeConfig("sha256"))]);
  if (!configEntry.isFile() || configEntry.isSymbolicLink() || configEntry.nlink !== 1 || !configLengths.has(configEntry.size)) {
    throw new Error("managed git-md repository config is poisoned");
  }
  const objectFormat = configObjectFormat(readFileSync(config, "utf8"));
  if (objectFormat === null) throw new Error("managed git-md repository config is poisoned");
  for (const required of [join(repository, "refs"), join(repository, "objects"), join(repository, "objects", "info"), join(repository, "objects", "pack"), join(repository, "info")]) {
    check();
    const requiredEntry = lstatSync(required);
    if (!requiredEntry.isDirectory() || requiredEntry.isSymbolicLink() || realpathSync.native(required) !== required) {
      throw new Error("managed git-md critical repository structure is poisoned");
    }
  }
  const head = join(repository, "HEAD");
  const headEntry = lstatSync(head);
  if (!headEntry.isFile() || headEntry.isSymbolicLink() || headEntry.nlink !== 1 || headEntry.size > 64) {
    throw new Error("managed git-md HEAD is poisoned");
  }
  const headText = readFileSync(head, "utf8");
  if (headText !== "ref: refs/heads/master\n" && headText !== "ref: refs/heads/main\n") throw new Error("managed git-md HEAD is poisoned");
  for (const path of [
    join(repository, "info", "grafts"), join(repository, "hooks"),
  ]) {
    check();
    try {
      const item = lstatSync(path);
      if (path.endsWith("hooks") && item.isDirectory() && readdirSync(path).length === 0) continue;
      throw new Error("managed git-md repository contains forbidden alternates or hooks");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  validateManagedRefs(repository, objectFormat, check);
  // This is also a lstat walk: every object/critical file is rejected if it is
  // a symlink, hardlink, device, socket, or other unsupported node.
  repositoryBytes(repository, Number.MAX_SAFE_INTEGER, true, check);
}

function repositoryBytes(
  repository: string, stopAfter = Number.MAX_SAFE_INTEGER, strict = true, check: () => void = () => undefined,
): number {
  let bytes = 0;
  let rootDev: number | null = null;
  const walk = (path: string): void => {
    check();
    let entry: ReturnType<typeof lstatSync>;
    try { entry = lstatSync(path); } catch (error) {
      if (!strict && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (entry.isSymbolicLink()) throw new Error("managed git-md repository contains a symlink");
    if (entry.isDirectory()) {
      if (rootDev === null) rootDev = entry.dev;
      else if (entry.dev !== rootDev) throw new Error("managed git-md repository crosses a filesystem boundary");
      let children: string[];
      try { children = readdirSync(path); } catch (error) {
        if (!strict && (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      check();
      for (const child of children) walk(join(path, child));
    }
    else if (entry.isFile()) {
      if (strict && entry.nlink !== 1) throw new Error("managed git-md repository contains a hardlinked file");
      bytes += entry.size;
      if (bytes > stopAfter) return;
    } else throw new Error("managed git-md repository contains an unsupported node");
  };
  walk(repository);
  return bytes;
}

function enforceRepositoryQuota(repository: string, limit: number, check: () => void = () => undefined): void {
  if (repositoryBytes(repository, limit, true, check) > limit) throw new Error("managed git-md repository exceeds the post-fetch quota");
}

function freshFetchFileLimit(repository: string, aggregateLimit: number): { baseBytes: number; fileLimit: number } {
  const baseBytes = repositoryBytes(repository);
  const available = aggregateLimit - baseBytes - FETCH_METADATA_ALLOWANCE_BYTES;
  // index-pack can have one pack and one index file live concurrently. Give
  // each no more than half of the exact remaining aggregate budget; flooring
  // to KiB is conservative for the shell RLIMIT unit used below.
  const fileLimit = Math.floor(available / 2 / 1024) * 1024;
  if (fileLimit < 1024) throw new Error("managed git-md repository quota is too small for bounded fetch metadata");
  return { baseBytes, fileLimit };
}

function validateFreshFetchInventory(repository: string): void {
  for (const forbidden of ["FETCH_HEAD", "shallow", "shallow.lock", "objects/info/commit-graph", "objects/pack/multi-pack-index"]) {
    try {
      lstatSync(join(repository, forbidden));
      throw new Error("managed git-md fresh fetch produced forbidden metadata");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const packDir = join(repository, "objects", "pack");
  const names = readdirSync(packDir).sort();
  if (names.length !== 2 || !names[0]!.endsWith(".idx") || !names[1]!.endsWith(".pack")
      || names[0]!.slice(0, -4) !== names[1]!.slice(0, -5)) {
    throw new Error("managed git-md fresh fetch did not produce exactly one pack/index pair");
  }
  for (const name of names) {
    const entry = lstatSync(join(packDir, name));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      throw new Error("managed git-md fresh fetch produced an unsafe pack artifact");
    }
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

interface FrozenGitArtifact {
  name: string;
  kind: GitArtifactKind;
  path: string;
  dev: number;
  ino: number;
  tree: FrozenSameDeviceTree;
}

function validateOwnedArtifact(
  typeRoot: string, sourceId: string, name: string, kind?: GitArtifactKind, safeTreeOps: SafeTreeOps = {},
): FrozenGitArtifact {
  const kinds: GitArtifactKind[] = ["clone", "corrupt", "repo"];
  const ownership = kinds.map((kind) => artifactOwnership(name, kind, sourceId));
  if (!ownership.includes("owned")) {
    if (ownership.includes("ambiguous")) throw new Error("git-md legacy artifact ownership is ambiguous");
    throw new Error("git-md artifact name is not recognized");
  }
  const path = join(typeRoot, name);
  const entry = assertManagedDirectoryTrust(path, "managed git-md artifact", safeTreeOps, true);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync.native(path) !== path || dirname(path) !== typeRoot) {
    throw new Error("git-md artifact is not a recognized owned directory");
  }
  const ownedKind = kind ?? kinds[ownership.indexOf("owned")]!;
  return { name, kind: ownedKind, path, dev: entry.dev, ino: entry.ino,
    tree: freezeSameDeviceTree(path, "managed git-md artifact", safeTreeOps) };
}

function scanOwnedArtifacts(typeRoot: string, sourceId: string, safeTreeOps: SafeTreeOps = {}): FrozenGitArtifact[] {
  const result: FrozenGitArtifact[] = [];
  for (const name of readdirSync(typeRoot)) {
    const kinds: GitArtifactKind[] = ["clone", "corrupt", "repo"];
    const ownership = kinds.map((kind) => artifactOwnership(name, kind, sourceId));
    if (ownership.includes("ambiguous")) throw new Error("git-md legacy artifact ownership is ambiguous");
    const owned = ownership.indexOf("owned");
    if (owned >= 0) result.push(validateOwnedArtifact(typeRoot, sourceId, name, kinds[owned]!, safeTreeOps));
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function revalidateOwnedArtifact(typeRoot: string, sourceId: string, frozen: FrozenGitArtifact, safeTreeOps: SafeTreeOps = {}): void {
  const current = validateOwnedArtifact(typeRoot, sourceId, frozen.name, frozen.kind, safeTreeOps);
  if (current.kind !== frozen.kind || current.dev !== frozen.dev || current.ino !== frozen.ino) {
    throw new Error("git-md artifact changed after preflight");
  }
}

function revalidateArtifactSet(
  typeRoot: string, sourceId: string, expected: readonly FrozenGitArtifact[], safeTreeOps: SafeTreeOps = {},
): void {
  const current = scanOwnedArtifacts(typeRoot, sourceId, safeTreeOps);
  if (current.length !== expected.length) throw new Error("git-md artifact set changed after preflight");
  for (let index = 0; index < current.length; index += 1) {
    const actual = current[index]!;
    const wanted = expected[index]!;
    if (actual.name !== wanted.name || actual.kind !== wanted.kind || actual.dev !== wanted.dev || actual.ino !== wanted.ino) {
      throw new Error("git-md artifact set changed after preflight");
    }
  }
}

function requireArtifactToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)) {
    throw new Error("git-md artifact token must be a nonempty separator-free identifier");
  }
  return value;
}

function directChild(root: string, name: string): string {
  const candidate = join(root, name);
  if (dirname(candidate) !== root || resolve(candidate) !== candidate) throw new Error("git-md artifact escaped its managed root");
  return candidate;
}

interface FrozenDirectory { path: string; dev: number; ino: number; tree: FrozenSameDeviceTree }

function freezeCanonicalDirectory(parent: string, path: string, label: string, safeTreeOps: SafeTreeOps = {}): FrozenDirectory {
  const entry = assertManagedDirectoryTrust(path, label, safeTreeOps, true);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync.native(path) !== path
      || dirname(path) !== parent || !contained(parent, path)) throw new Error(`${label} is not a canonical real directory`);
  return { path, dev: entry.dev, ino: entry.ino, tree: freezeSameDeviceTree(path, label, safeTreeOps) };
}

function revalidateCanonicalDirectory(
  parent: string, frozen: FrozenDirectory, label: string, safeTreeOps: SafeTreeOps = {},
): void {
  const current = freezeCanonicalDirectory(parent, frozen.path, label, safeTreeOps);
  if (current.dev !== frozen.dev || current.ino !== frozen.ino) throw new Error(`${label} changed after preflight`);
  revalidateSameDeviceTree(frozen.tree, label, safeTreeOps);
}

/**
 * Fetch exactly one named branch through Git's normal remote-helper-capable
 * transport. The fresh bare repository, forced one-ref refspec, disabled
 * unpacking, and inherited RLIMIT_FSIZE make the candidate ref and its single
 * pack atomic: a failed transfer cannot leave an authoritative candidate.
 */
async function fetchRemoteBranch(
  source: KnowledgeSource, remote: URL, stagedRepository: string, typeRoot: string,
  aggregateQuota: number, prefetchBytes: number, fileLimit: number, options: RemoteGitOptions,
  env: NodeJS.ProcessEnv, secrets: readonly string[],
  assertOwnership: () => void, objectFormat: GitObjectFormat,
): Promise<string> {
  let observed = 0;
  let exceeded = false;
  let peakStagingBytes = repositoryBytes(stagedRepository);
  const observeStaging = (): void => {
    // Git may transiently hardlink a local test transport object before it is
    // packed. Count every pathname's logical bytes here; the final repository
    // validator still rejects any surviving hardlink.
    const bytes = repositoryBytes(stagedRepository, aggregateQuota, false);
    peakStagingBytes = Math.max(peakStagingBytes, bytes);
    if (bytes > aggregateQuota) {
      exceeded = true;
      throw new Error("managed git-md staging repository exceeded its aggregate byte quota");
    }
  };
  const assertFetchOwnership = (): void => { assertOwnership(); observeStaging(); };
  try {
    const scheme = remote.protocol.slice(0, -1);
    await runRemoteGit([
      "-c", `protocol.${scheme}.allow=always`,
      "-c", `protocol.${scheme === "https" ? "ssh" : "https"}.allow=never`,
      "-c", "fetch.unpackLimit=1", "-c", "transfer.unpackLimit=1",
      "-c", "pack.writeReverseIndex=false",
      `--git-dir=${stagedRepository}`, "fetch", "--no-progress", "--no-tags", "--no-recurse-submodules",
      "--no-write-fetch-head", "--force", source.remoteUrl!,
      `+refs/heads/${source.branch}:refs/monet/candidate`,
    ], typeRoot, options, env, secrets, fileLimit, assertFetchOwnership);
    assertFetchOwnership();
    validateFreshFetchInventory(stagedRepository);
    const packDir = join(stagedRepository, "objects", "pack");
    const packArtifacts = readdirSync(packDir);
    const packAndIndexBytes = packArtifacts.reduce((bytes, name) => bytes + lstatSync(join(packDir, name)).size, 0);
    if (repositoryBytes(stagedRepository) - packAndIndexBytes > prefetchBytes + FETCH_METADATA_ALLOWANCE_BYTES) {
      throw new Error("managed git-md fresh fetch exceeded its reserved metadata allowance");
    }
    const packs = packArtifacts.filter((name) => name.endsWith(".pack"));
    if (packs.length !== 1) throw new Error("managed git-md fetch did not produce exactly one pack");
    observed = lstatSync(join(packDir, packs[0]!)).size;
    exceeded = observed > fileLimit;
    if (observed < 1 || exceeded) throw new Error(`managed git-md received pack exceeded its hard file byte quota (${observed}/${fileLimit})`);
    const oid = await runRemoteGit([
      `--git-dir=${stagedRepository}`, "rev-parse", "--verify", "refs/monet/candidate^{commit}",
    ], typeRoot, options, env, [], undefined, assertFetchOwnership);
    const direct = await runRemoteGit([
      `--git-dir=${stagedRepository}`, "rev-parse", "--verify", "refs/monet/candidate",
    ], typeRoot, options, env, [], undefined, assertFetchOwnership);
    const expectedLength = objectFormat === "sha256" ? 64 : 40;
    if (!OID_RE.test(oid) || oid.length !== expectedLength || direct !== oid) {
      throw new Error("remote Git candidate does not match the negotiated object format");
    }
    return oid.toLowerCase();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/signal 25|SIGXFSZ|file size limit|index-pack failed|early EOF|fetch-pack: invalid index-pack output/i.test(message)) {
      exceeded = true;
      // The kernel delivered the file-size signal only after the child reached
      // the configured ceiling; report that exact bounded peak even when Git
      // removed its temporary pack before the parent could stat it.
      observed = Math.max(observed, fileLimit);
      throw new Error("managed git-md received pack exceeded its hard byte quota");
    }
    throw error;
  } finally {
    try { observeStaging(); } catch { exceeded = true; }
    options.onPackBytes?.(observed, fileLimit, exceeded);
    options.onStagingBytes?.(peakStagingBytes, aggregateQuota, peakStagingBytes > aggregateQuota);
  }
}

async function probeRemoteBranchFormat(
  source: KnowledgeSource, remote: URL, typeRoot: string, options: RemoteGitOptions,
  env: NodeJS.ProcessEnv, secrets: readonly string[], assertOwnership: () => void,
): Promise<GitObjectFormat> {
  const scheme = remote.protocol.slice(0, -1);
  const ref = `refs/heads/${source.branch}`;
  const output = await runRemoteGit([
    "-c", `protocol.${scheme}.allow=always`,
    "-c", `protocol.${scheme === "https" ? "ssh" : "https"}.allow=never`,
    "ls-remote", "--refs", "--exit-code", source.remoteUrl!, ref,
  ], typeRoot, options, env, secrets, undefined, assertOwnership);
  const lines = output.split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error("remote Git branch format probe was ambiguous");
  const match = /^([0-9a-f]+)\t(refs\/heads\/[^\s]+)$/.exec(lines[0]!);
  if (!match || match[2] !== ref || !OID_RE.test(match[1]!)) throw new Error("remote Git branch format probe was invalid");
  if (match[1]!.length === 40) return "sha1";
  if (match[1]!.length === 64) return "sha256";
  throw new Error("remote Git uses an unsupported object format");
}

function assertRuntimeSource(source: KnowledgeSource, sourceStorageDir: string): URL {
  if (source.type !== "git-md" || source.lifecycle !== "active" || !source.remoteUrl || !source.branch || !source.transport) {
    throw new Error("git-md sync requires an active complete git-md source");
  }
  const expected = join(realpathSync.native(resolve(sourceStorageDir)), "git-md", source.id, "repository.git");
  if (source.localPath !== expected) throw new Error("git-md localPath does not match the managed allocator");
  const remote = new URL(source.remoteUrl);
  if (remote.password || (remote.protocol === "https:" && remote.username) || !["https:", "ssh:"].includes(remote.protocol)) {
    throw new Error("git-md remote is not canonical and credential-free");
  }
  const scheme = remote.protocol.slice(0, -1) as "https" | "ssh";
  if (!source.transport.allowedUrlSchemes.includes(scheme) || !source.transport.allowedHosts.includes(remote.hostname.toLowerCase())) {
    throw new Error("git-md remote is not allowed by its transport policy");
  }
  if (/^(?:-|.*(?:\.\.|@\{|[~^:?*\[\\\u0000-\u0020]))/.test(source.branch)) throw new Error("git-md branch is unsafe");
  return remote;
}

async function credentialsFor(
  remote: URL, options: RemoteGitOptions, assertOwnership: () => void,
): Promise<{ env: NodeJS.ProcessEnv; secrets: string[]; cleanup: () => void }> {
  if (remote.protocol !== "https:" || !options.credentialProvider) return { env: {}, secrets: [], cleanup: () => undefined };
  const credential = await waitForGitProvider("Git credential provider", options, assertOwnership, () =>
    options.credentialProvider!.get({ protocol: "https", host: remote.hostname.toLowerCase(), path: remote.pathname.replace(/^\//, "") }));
  if (!credential) return { env: {}, secrets: [], cleanup: () => undefined };
  assertOwnership();
  if (!credential.username || !credential.password || credential.username.length > 1024 || credential.password.length > 8192) throw new Error("Git credential provider returned invalid credentials");
  let helperDir: string | null = null;
  try {
    helperDir = mkdtempSync(join(tmpdir(), "monet-askpass-"));
    options.credentialHelperFault?.();
    chmodSync(helperDir, 0o700);
    const helper = join(helperDir, "askpass.sh");
    writeFileSync(helper, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "$MONET_GIT_USERNAME";; *Password*) printf "%s\\n" "$MONET_GIT_PASSWORD";; *) exit 1;; esac\n', { mode: 0o700 });
    chmodSync(helper, 0o700);
    const env: NodeJS.ProcessEnv = {
      GIT_ASKPASS: helper, GIT_ASKPASS_REQUIRE: "force",
      MONET_GIT_USERNAME: credential.username, MONET_GIT_PASSWORD: credential.password,
    };
    const secrets = [credential.username, credential.password];
    return {
      env, secrets, cleanup: () => {
        delete env.MONET_GIT_USERNAME;
        delete env.MONET_GIT_PASSWORD;
        secrets.fill("");
        rmSync(helperDir!, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (helperDir) rmSync(helperDir, { recursive: true, force: true });
    throw error;
  }
}

/** Fetch the configured branch into a candidate ref and return its exact verified commit. */
export async function syncManagedGitRepository(
  source: KnowledgeSource, sourceStorageDir: string, options: RemoteGitOptions = {}, beforePromote: () => void = () => undefined,
  assertOwnership: () => void = () => undefined,
): Promise<string> {
  const remote = assertRuntimeSource(source, sourceStorageDir);
  if (process.platform === "win32") throw new Error("managed git-md hard aggregate staging quota is unavailable on this platform");
  const mutate = assertOwnership;
  const token = requireArtifactToken((options.token ?? randomUUID)());
  const storageRoot = realpathSync.native(resolve(sourceStorageDir));
  const safeTreeOps = options.safeTreeOps ?? {};
  assertManagedDirectoryTrust(storageRoot, "managed source storage base", safeTreeOps);
  const typeRoot = join(storageRoot, "git-md");
  mutate();
  mkdirSync(typeRoot, { recursive: true, mode: 0o700 });
  if (realpathSync.native(typeRoot) !== typeRoot) throw new Error("managed git-md root is not canonical");
  assertManagedDirectoryTrust(typeRoot, "managed git-md root", safeTreeOps);
  const sourceRoot = dirname(source.localPath);
  const repository = source.localPath;
  // Phase one: classify and validate every current and UUID-legacy artifact,
  // including repo/corrupt quarantines that this operation will only clean at
  // the end. Nothing is deleted and no credential/fetch is attempted until
  // this complete inventory succeeds.
  let artifacts = scanOwnedArtifacts(typeRoot, source.id, safeTreeOps);
  const reservedNames = new Set([
    artifactName("clone", source.id, token), artifactName("repo", source.id, token), artifactName("corrupt", source.id, token),
  ]);
  if (artifacts.some((artifact) => reservedNames.has(artifact.name))) throw new Error("git-md artifact token collides with an existing artifact");
  let frozenSourceRoot: FrozenDirectory | null = null;
  let frozenRepository: FrozenDirectory | null = null;
  let activeRepositoryValid = false;
  try {
    frozenSourceRoot = freezeCanonicalDirectory(typeRoot, sourceRoot, "managed git-md source root", safeTreeOps);
    frozenRepository = freezeCanonicalDirectory(sourceRoot, repository, "managed git-md repository", safeTreeOps);
    // A managed repository may be replaced after publication. Reject external
    // control/object-store redirection before starting any Git child process.
    rejectManagedGitRedirections(repository);
    try { validateManagedGitRepository(repository); activeRepositoryValid = true; } catch { activeRepositoryValid = false; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (frozenSourceRoot && !frozenRepository) {
      // A missing repository under a valid source root is a supported repair.
      frozenRepository = null;
    } else if (!frozenSourceRoot) {
      // Both source root and repository may be absent on initial sync.
      frozenRepository = null;
    }
  }
  revalidateArtifactSet(typeRoot, source.id, artifacts, safeTreeOps);
  for (const artifact of artifacts) revalidateSameDeviceTree(artifact.tree, "managed git-md artifact", safeTreeOps);
  for (const stale of artifacts.filter((artifact) => artifact.kind === "clone")) {
    revalidateArtifactSet(typeRoot, source.id, artifacts, safeTreeOps);
    revalidateOwnedArtifact(typeRoot, source.id, stale, safeTreeOps);
    removeFrozenSameDeviceTree(stale.tree, "managed git-md stale clone", mutate, { ops: safeTreeOps });
    artifacts = artifacts.filter((artifact) => artifact.name !== stale.name);
  }
  mutate();
  fsyncDirectory(typeRoot);
  const repositoryQuota = bounded(options.maxRepositoryBytes, DEFAULT_REPOSITORY_BYTES, 8 * 1024 * 1024 * 1024, "repository quota");
  const temporaryRoot = directChild(typeRoot, artifactName("clone", source.id, token));
  const stagedRepository = join(temporaryRoot, "repository.git");
  let frozenTemporaryRoot: FrozenGitArtifact | null = null;
  let isolated: ReturnType<typeof privateGitHome> | null = null;
  let knownHosts: FrozenKnownHosts | null = null;
  let credential: Awaited<ReturnType<typeof credentialsFor>> = { env: {}, secrets: [], cleanup: () => undefined };
  try {
    // Provider waits happen before any trust snapshot, repository staging, or
    // network operation. They are bounded by the same configured remote
    // timeout and continuously fenced by exact lock ownership.
    const knownHostsPath = await trustedKnownHostsPath(remote, options, assertOwnership);
    credential = await credentialsFor(remote, options, assertOwnership);
    mutate();
    isolated = privateGitHome();
    knownHosts = trustedKnownHosts(knownHostsPath, isolated.env.HOME!, assertOwnership);
    mutate();
    mkdirSync(temporaryRoot, { mode: 0o700 });
    frozenTemporaryRoot = validateOwnedArtifact(typeRoot, source.id, artifactName("clone", source.id, token), "clone", safeTreeOps);
    artifacts = [...artifacts, frozenTemporaryRoot].sort((left, right) => left.name.localeCompare(right.name));
    mutate();
    mkdirSync(stagedRepository, { mode: 0o700 });
    assertManagedDirectoryTrust(stagedRepository, "managed git-md staging repository", safeTreeOps, true);
    const assertNetworkOwnership = (): void => {
      assertOwnership();
      if (knownHosts) revalidateKnownHosts(knownHosts);
    };
    assertNetworkOwnership();
    const sshEnv = remote.protocol === "ssh:" ? {
      GIT_SSH_COMMAND: `ssh -F /dev/null -oBatchMode=yes -oStrictHostKeyChecking=yes -oUserKnownHostsFile=${shellQuote(knownHosts!.path)} -oGlobalKnownHostsFile=/dev/null -oUpdateHostKeys=no -oClearAllForwardings=yes -oForwardAgent=no -oForwardX11=no -oPermitLocalCommand=no`,
      GIT_SSH_VARIANT: "ssh", SSH_ASKPASS: "/bin/false",
    } : {};
    assertNetworkOwnership();
    const networkEnvironment = { ...isolated.env, ...sshEnv, ...credential.env };
    const objectFormat = await probeRemoteBranchFormat(
      source, remote, typeRoot, options, networkEnvironment, credential.secrets, assertNetworkOwnership,
    );
    assertNetworkOwnership();
    mutate();
    await runRemoteGit(["init", "--bare", `--object-format=${objectFormat}`, stagedRepository],
      typeRoot, options, isolated.env, [], undefined, assertOwnership);
    mutate();
    writeFileSync(join(stagedRepository, "config"), safeConfig(objectFormat), { mode: 0o600 });
    const hooks = join(stagedRepository, "hooks");
    if (statSync(hooks).isDirectory()) {
      removeFrozenSameDeviceTree(freezeSameDeviceTree(hooks, "managed git-md hooks", safeTreeOps),
        "managed git-md hooks", mutate, { ops: safeTreeOps });
    }
    mutate();
    mkdirSync(hooks, { mode: 0o700 });
    validateManagedGitRepository(stagedRepository);
    assertNetworkOwnership();
    const { baseBytes, fileLimit } = freshFetchFileLimit(stagedRepository, repositoryQuota);
    const oid = await fetchRemoteBranch(source, remote, stagedRepository, typeRoot, repositoryQuota, baseBytes, fileLimit, options,
      networkEnvironment, credential.secrets, assertNetworkOwnership, objectFormat);
    assertNetworkOwnership();
    validateManagedGitRepository(stagedRepository);
    enforceRepositoryQuota(stagedRepository, repositoryQuota);
    if (!OID_RE.test(oid)) throw new Error("remote Git returned an invalid candidate commit");
    validateManagedGitInvocation(stagedRepository);
    await runRemoteGit([`--git-dir=${stagedRepository}`, "fsck", "--strict", "--full", "--no-reflogs", oid],
      typeRoot, options, isolated.env, [], undefined, assertOwnership);
    validateManagedGitRepository(stagedRepository);
    enforceRepositoryQuota(stagedRepository, repositoryQuota);

    // Re-run the complete inventory immediately before publication. A repo or
    // corrupt artifact introduced during the fetch is therefore rejected while
    // the active repository and published snapshots are still untouched.
    beforePromote();
    assertOwnership();
    revalidateArtifactSet(typeRoot, source.id, artifacts, safeTreeOps);
    if (frozenSourceRoot) revalidateCanonicalDirectory(typeRoot, frozenSourceRoot, "managed git-md source root", safeTreeOps);
    else {
      mutate();
      mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
      frozenSourceRoot = freezeCanonicalDirectory(typeRoot, sourceRoot, "managed git-md source root", safeTreeOps);
    }
    if (frozenRepository) {
      revalidateCanonicalDirectory(sourceRoot, frozenRepository, "managed git-md repository", safeTreeOps);
      if (activeRepositoryValid) validateManagedGitRepository(repository);
    }
    let quarantine: FrozenGitArtifact | null = null;
    if (frozenRepository) {
      const quarantineKind: GitArtifactKind = activeRepositoryValid ? "repo" : "corrupt";
      const quarantinePath = directChild(typeRoot, artifactName(quarantineKind, source.id, token));
      revalidateArtifactSet(typeRoot, source.id, artifacts, safeTreeOps);
      revalidateCanonicalDirectory(sourceRoot, frozenRepository, "managed git-md repository", safeTreeOps);
      try {
        lstatSync(quarantinePath);
        throw new Error("git-md replacement quarantine already exists");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      mutate();
      renameSync(repository, quarantinePath);
      mutate();
      fsyncDirectory(sourceRoot);
      mutate();
      fsyncDirectory(typeRoot);
      quarantine = validateOwnedArtifact(typeRoot, source.id, artifactName(quarantineKind, source.id, token), quarantineKind, safeTreeOps);
      artifacts = [...artifacts, quarantine].sort((left, right) => left.name.localeCompare(right.name));
    }
    try {
      mutate();
      renameSync(stagedRepository, repository);
      mutate();
      fsyncDirectory(sourceRoot);
      assertManagedDirectoryTrust(repository, "managed git-md repository", safeTreeOps, true);
      validateManagedGitRepository(repository);
      enforceRepositoryQuota(repository, repositoryQuota);
    } catch (error) {
      try {
        const failed = freezeCanonicalDirectory(sourceRoot, repository, "failed managed git-md repository", safeTreeOps);
        revalidateCanonicalDirectory(sourceRoot, failed, "failed managed git-md repository", safeTreeOps);
        removeFrozenSameDeviceTree(failed.tree, "failed managed git-md repository", mutate, { ops: safeTreeOps });
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
      if (quarantine) {
        revalidateOwnedArtifact(typeRoot, source.id, quarantine, safeTreeOps);
        mutate();
        renameSync(quarantine.path, repository);
        artifacts = artifacts.filter((artifact) => artifact.name !== quarantine!.name);
      }
      mutate();
      fsyncDirectory(sourceRoot);
      throw error;
    }
    // Delete only the directories frozen by preflight (plus the quarantine we
    // just created), revalidating identity immediately before every removal.
    if (!frozenTemporaryRoot) throw new Error("git-md temporary artifact was not frozen");
    const temporaryArtifact = frozenTemporaryRoot;
    revalidateArtifactSet(typeRoot, source.id, artifacts, safeTreeOps);
    revalidateOwnedArtifact(typeRoot, source.id, temporaryArtifact, safeTreeOps);
    removeFrozenSameDeviceTree(freezeSameDeviceTree(temporaryRoot, "managed git-md clone", safeTreeOps),
      "managed git-md clone", mutate, { ops: safeTreeOps });
    artifacts = artifacts.filter((artifact) => artifact.name !== temporaryArtifact.name);
    frozenTemporaryRoot = null;
    if (quarantine) {
      revalidateArtifactSet(typeRoot, source.id, artifacts, safeTreeOps);
      revalidateOwnedArtifact(typeRoot, source.id, quarantine, safeTreeOps);
      removeFrozenSameDeviceTree(quarantine.tree, "managed git-md quarantine", mutate, { ops: safeTreeOps });
      artifacts = artifacts.filter((artifact) => artifact.name !== quarantine!.name);
    }
    for (const old of [...artifacts]) {
      revalidateArtifactSet(typeRoot, source.id, artifacts, safeTreeOps);
      revalidateOwnedArtifact(typeRoot, source.id, old, safeTreeOps);
      removeFrozenSameDeviceTree(old.tree, "managed git-md artifact", mutate, { ops: safeTreeOps });
      artifacts = artifacts.filter((artifact) => artifact.name !== old.name);
    }
    mutate();
    fsyncDirectory(typeRoot);
    return oid;
  } finally {
    credential.cleanup();
    isolated?.cleanup();
    if (frozenTemporaryRoot) {
      try {
        revalidateArtifactSet(typeRoot, source.id, artifacts, safeTreeOps);
        revalidateOwnedArtifact(typeRoot, source.id, frozenTemporaryRoot, safeTreeOps);
        removeFrozenSameDeviceTree(freezeSameDeviceTree(temporaryRoot, "managed git-md clone", safeTreeOps),
          "managed git-md clone", mutate, { ops: safeTreeOps });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
