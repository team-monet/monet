import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import {
  accessSync, chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync,
  readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  computeSourceIngestConfigHash, computeSourceManifestHash, effectiveSourceScanConfig, isMarkdownSourcePath, matchesSourceGlob,
  scanSourceSnapshot,
} from "./source-scanner";
import type { EffectiveSourceScanConfig, SourceScanDiagnostic } from "./source-scanner";
import { classifySourceFileContent } from "./source-chunker";
import { managedGitEnvironment, validateManagedGitInvocation, validateManagedGitRepository } from "./source-git";
import {
  assertManagedDirectoryTrust, freezeSameDeviceTree, removeFrozenSameDeviceTree, revalidateSameDeviceTree,
} from "./source-safe-remove";
import type { FrozenSameDeviceTree, SafeTreeOps } from "./source-safe-remove";
import type { KnowledgeSource, SourcePublishedManifest } from "./source-types";

const OID_RE = /^[0-9a-f]{40,64}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const CONFIG_HASH_RE = /^monet-src-ingest-config\/v1:sha256:[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const IO_CHUNK = 64 * 1024;
const MAX_SNAPSHOT_MARKER_BYTES = 32 * 1024 * 1024;
/** Rename evidence is advisory and deliberately much smaller than tree materialization output. */
const MAX_RENAME_DIFF_BYTES = 1024 * 1024;
const DEFAULT_LOCAL_GIT_TIMEOUT_MS = 120_000;
const MAX_LOCAL_GIT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_GIT_MATERIALIZATION_DEADLINE_MS = 5 * 60_000;
const MAX_GIT_MATERIALIZATION_DEADLINE_MS = 10 * 60_000;
const LEGACY_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/** Fixed so binding identity does not depend on a caller's Git configuration. */
export const REPO_MD_RENAME_SIMILARITY = 50;
/** Bound Git's quadratic rename candidate search; excess candidates produce no rename proof. */
export const REPO_MD_RENAME_LIMIT = 1000;

export type RepoMdMaterializerFaultPoint =
  | "after-lock" | "after-archive" | "before-snapshot-rename" | "after-snapshot-rename"
  | "before-sidecar-rename" | "after-sidecar-rename" | "before-current-swap" | "after-current-swap";

export interface RepoMdMaterializerOptions {
  sourceStorageDir: string;
  config?: EffectiveSourceScanConfig;
  lockStaleMs?: number;
  maxArchiveBytes?: number;
  now?: () => number;
  token?: () => string;
  execFile?: typeof nodeExecFile;
  spawn?: typeof nodeSpawn;
  /** Hard bound for every Git command that reads a managed git-md repository. */
  localGitTimeoutMs?: number;
  /** Aggregate wall-clock bound across all Git validation and blob extraction. */
  materializationDeadlineMs?: number;
  /** Injectable monotonic clock; wall-clock changes never extend the aggregate deadline. */
  monotonicNow?: () => number;
  /** Test seam for recursive device-boundary validation and deletion. */
  safeTreeOps?: SafeTreeOps;
  /** Test seam for directory durability barriers. */
  fsyncPath?: (path: string) => void;
  /** Optional already-trusted executable; otherwise Git is resolved and pinned once per operation. */
  gitExecutable?: string;
  /** Exact per-source lock ownership fence, checked immediately before managed mutations. */
  assertOwnership?: () => void;
  fault?: (point: RepoMdMaterializerFaultPoint) => void;
  /** Complete active publication, used for exact active validation and predecessor carry-forward. */
  activePublication?: SourcePublishedManifest;
}

export interface RepoMdMaterialization {
  snapshotId: string;
  configHash: string;
  snapshotPath: string;
  currentPath: string;
  repositoryRoot: string;
  /** Per-file skip-and-diagnose evidence for this materialization; see enumerateSelectedTree. */
  diagnostics: SourceScanDiagnostic[];
  /** The canonical pre-seal scan failed closed, so no candidate was sealed. */
  preSealStatus?: "partial";
  /**
   * BLOCKER 5a EDGE CASE: previously-published paths that needed pre-seal carry-forward (per
   * activePublication) but could not get it because the prior sealed snapshot required to source
   * their bytes was missing, corrupt, or otherwise failed validation. Always present; empty when
   * nothing needed carrying or every carry succeeded. Non-empty here is a signal the caller
   * (syncSource) MUST act on: never stage a manifest that would carry these paths forward, since
   * their bytes are not (and cannot safely be made) present in this snapshot — degrade the run to
   * a graceful tree-level-partial abort instead, matching the docstring's fail-closed promise.
   * Deliberately a data field, not a thrown error: by the time syncSource checks it, a durable run
   * already exists to abort cleanly, so there is no need to fail before one does.
   */
  carryForwardUnavailable: string[];
}

interface TreeEntry { path: string; oid: string; size: number; mode: string }
interface SnapshotMarker {
  version: 2;
  snapshotId: string;
  configHash: string;
  variant: string;
  files: Array<{ path: string; size: number; sha256: string; mode?: "100644" | "100755" }>;
}

interface FrozenManagedDirectory { path: string; dev: number; ino: number }
interface FrozenSnapshotsDirectory { root: FrozenManagedDirectory; snapshots: FrozenManagedDirectory }
type SourcePathIdentity = Pick<KnowledgeSource, "id" | "type"> & Partial<Pick<KnowledgeSource, "activeRunId">>;

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function requireSourceId(sourceId: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(sourceId)) throw new Error("invalid source id for materialization");
}

function requireArtifactToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)) {
    throw new Error("materializer token must be a nonempty separator-free identifier");
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type SiblingArtifactKind = "clone" | "corrupt" | "repo" | "remove";

function siblingArtifactName(kind: SiblingArtifactKind, sourceId: string, token: string): string {
  return `.${kind}.${sourceId}.${token}`;
}

function siblingArtifactOwnership(name: string, kind: SiblingArtifactKind, sourceId: string): "owned" | "ambiguous" | "foreign" {
  const current = new RegExp(`^\\.${kind}\\.${escapeRegExp(sourceId)}\\.[A-Za-z0-9][A-Za-z0-9-]{0,127}$`);
  if (current.test(name)) return "owned";
  const legacy = new RegExp(`^\\.${kind}-(.+)-(${LEGACY_UUID})$`, "i").exec(name);
  if (legacy) return legacy[1] === sourceId ? "owned" : "foreign";
  return name.startsWith(`.${kind}-${sourceId}-`) ? "ambiguous" : "foreign";
}

function realDirectory(
  path: string, label: string, create: boolean, beforeMutation: () => void = () => undefined,
  safeTreeOps: SafeTreeOps = {}, privateRoot = false,
): string | null {
  let entry;
  try { entry = (safeTreeOps.lstat ?? lstatSync)(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try { beforeMutation(); mkdirSync(path, { mode: 0o700 }); } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    entry = (safeTreeOps.lstat ?? lstatSync)(path);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  assertManagedDirectoryTrust(path, label, safeTreeOps, privateRoot);
  return realpathSync.native(path);
}

function managedTypeRoot(
  type: "repo-md" | "git-md", storageDir: string, create = true, beforeMutation: () => void = () => undefined,
  safeTreeOps: SafeTreeOps = {},
): string | null {
  const configuredBase = resolve(storageDir);
  if (create) { beforeMutation(); mkdirSync(configuredBase, { recursive: true, mode: 0o700 }); }
  const base = realDirectory(configuredBase, "managed source storage base", false, beforeMutation, safeTreeOps);
  if (base === null) return null;
  const repoPath = join(base, type);
  const repo = realDirectory(repoPath, `managed ${type} root`, create, beforeMutation, safeTreeOps);
  if (repo === null) return null;
  if (repo !== join(base, type) || !contained(base, repo)) throw new Error(`managed ${type} root canonical path mismatch`);
  return repo;
}

function managedRepoRoot(storageDir: string, create = true): string | null {
  return managedTypeRoot("repo-md", storageDir, create);
}

function sourceRoot(sourceId: string, storageDir: string, create = true): string | null {
  return typedSourceRoot("repo-md", sourceId, storageDir, create);
}

function typedSourceRoot(
  type: "repo-md" | "git-md", sourceId: string, storageDir: string, create = true,
  beforeMutation: () => void = () => undefined,
  safeTreeOps: SafeTreeOps = {},
): string | null {
  requireSourceId(sourceId);
  const repo = managedTypeRoot(type, storageDir, create, beforeMutation, safeTreeOps);
  if (repo === null) return null;
  const expected = join(repo, sourceId);
  const source = realDirectory(expected, `managed ${type} source root`, create, beforeMutation, safeTreeOps, true);
  if (source !== null && (source !== expected || dirname(source) !== repo || relative(repo, source) !== sourceId)) {
    throw new Error(`managed ${type} source root canonical path mismatch`);
  }
  return source;
}

function freezeManagedDirectory(
  parent: string, path: string, label: string, safeTreeOps: SafeTreeOps = {},
): FrozenManagedDirectory {
  const entry = assertManagedDirectoryTrust(path, label, safeTreeOps, true);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync.native(path) !== path
      || dirname(path) !== parent || !contained(parent, path)) throw new Error(`${label} is not a canonical real direct-child directory`);
  return { path, dev: entry.dev, ino: entry.ino };
}

function revalidateManagedDirectory(
  parent: string, frozen: FrozenManagedDirectory, label: string, safeTreeOps: SafeTreeOps = {},
): void {
  const current = freezeManagedDirectory(parent, frozen.path, label, safeTreeOps);
  if (current.dev !== frozen.dev || current.ino !== frozen.ino) throw new Error(`${label} changed after preflight`);
}

/** Create snapshots only beneath a frozen source root, then freeze its exact inode for all later use. */
function freezeSnapshotsDirectory(
  root: string, create: boolean, beforeMutation: () => void = () => undefined,
  safeTreeOps: SafeTreeOps = {},
): FrozenSnapshotsDirectory | null {
  const rootParent = dirname(root);
  const frozenRoot = freezeManagedDirectory(rootParent, root, "managed source root", safeTreeOps);
  const snapshots = join(root, "snapshots");
  try {
    const frozen = freezeManagedDirectory(root, snapshots, "managed source snapshots root", safeTreeOps);
    if (frozen.dev !== frozenRoot.dev) throw new Error("managed source snapshots root crosses a filesystem boundary");
    revalidateManagedDirectory(rootParent, frozenRoot, "managed source root", safeTreeOps);
    return { root: frozenRoot, snapshots: frozen };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    revalidateManagedDirectory(rootParent, frozenRoot, "managed source root", safeTreeOps);
    try { beforeMutation(); mkdirSync(snapshots, { mode: 0o700 }); } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    revalidateManagedDirectory(rootParent, frozenRoot, "managed source root", safeTreeOps);
    const frozenSnapshots = freezeManagedDirectory(root, snapshots, "managed source snapshots root", safeTreeOps);
    if (frozenSnapshots.dev !== frozenRoot.dev) throw new Error("managed source snapshots root crosses a filesystem boundary");
    return { root: frozenRoot, snapshots: frozenSnapshots };
  }
}

function revalidateSnapshotsDirectory(frozen: FrozenSnapshotsDirectory, safeTreeOps: SafeTreeOps = {}): void {
  revalidateManagedDirectory(dirname(frozen.root.path), frozen.root, "managed source root", safeTreeOps);
  revalidateManagedDirectory(frozen.root.path, frozen.snapshots, "managed source snapshots root", safeTreeOps);
}

function parseOctal(field: Buffer, label: string): number {
  const text = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`invalid tar ${label}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid tar ${label}`);
  return value;
}

function tarString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function validateArchivePath(value: string): string {
  if (!value || CONTROL_RE.test(value) || value.includes("\\") || value.startsWith("/")) {
    throw new Error("git archive contains an unsafe path");
  }
  const parts = value.replace(/\/$/, "").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("git archive path traversal rejected");
  return parts.join("/");
}

function readExactly(fd: number, position: number, length: number): Buffer {
  const result = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, result, read, length - read, position + read);
    if (count === 0) throw new Error("truncated git archive");
    read += count;
  }
  return result;
}

function parsePax(payload: Buffer, global: boolean): string | null {
  let cursor = 0;
  let path: string | null = null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (cursor < payload.length) {
    const space = payload.indexOf(0x20, cursor);
    if (space < 0) throw new Error("invalid pax archive metadata");
    const lengthText = payload.subarray(cursor, space).toString("ascii");
    if (!/^[1-9]\d*$/.test(lengthText)) throw new Error("invalid pax archive metadata");
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > payload.length || payload[cursor + length - 1] !== 0x0a) {
      throw new Error("invalid pax archive metadata");
    }
    const record = payload.subarray(space + 1, cursor + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1) throw new Error("invalid pax archive metadata");
    const key = record.subarray(0, equals).toString("ascii");
    const value = decoder.decode(record.subarray(equals + 1));
    if (global && key !== "comment") throw new Error(`unsupported global pax key '${key}'`);
    if (!global && key === "path") path = validateArchivePath(value);
    else if (!global && key !== "mtime") throw new Error(`unsupported pax key '${key}'`);
    cursor += length;
  }
  return path;
}

/** Stream a bounded tar from disk; only the pre-enumerated regular files may be extracted. */
export function extractGitArchive(
  tarPath: string,
  destination: string,
  expectedEntries?: readonly TreeEntry[],
  maxArchiveBytes = 64 * 1024 * 1024,
  beforeMutation: () => void = () => undefined,
): Array<{ path: string; size: number; sha256: string }> {
  const archiveSize = statSync(tarPath).size;
  if (archiveSize > maxArchiveBytes) throw new Error("git archive exceeds the materialization byte limit");
  const expected = new Map((expectedEntries ?? []).map((entry) => [entry.path, entry]));
  const enforceExpected = expectedEntries !== undefined;
  const extracted = new Map<string, { path: string; size: number; sha256: string }>();
  const fd = openSync(tarPath, constants.O_RDONLY);
  let offset = 0;
  let pendingPath: string | null = null;
  try {
    while (offset + 512 <= archiveSize) {
      const header = readExactly(fd, offset, 512);
      if (header.every((byte) => byte === 0)) break;
      const recordedChecksum = parseOctal(header.subarray(148, 156), "checksum");
      const checksumHeader = Buffer.from(header);
      checksumHeader.fill(0x20, 148, 156);
      if (recordedChecksum !== checksumHeader.reduce((sum, byte) => sum + byte, 0)) throw new Error("git archive tar checksum mismatch");
      const prefix = tarString(header.subarray(345, 500));
      const name = tarString(header.subarray(0, 100));
      const size = parseOctal(header.subarray(124, 136), "size");
      const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
      const dataStart = offset + 512;
      const padded = Math.ceil(size / 512) * 512;
      if (dataStart + padded > archiveSize || dataStart + padded > maxArchiveBytes) throw new Error("truncated or oversized git archive");
      if (type === "g" || type === "x") {
        if (size > 1024 * 1024) throw new Error("pax archive metadata exceeds its bounded record limit");
        const paxPath = parsePax(readExactly(fd, dataStart, size), type === "g");
        if (paxPath) pendingPath = paxPath;
        offset = dataStart + padded;
        continue;
      }
      const archivePath = pendingPath ?? validateArchivePath(prefix ? `${prefix}/${name}` : name);
      pendingPath = null;
      const target = resolve(destination, archivePath);
      if (!contained(destination, target)) throw new Error("git archive extraction escaped destination");
      if (type === "5") {
        beforeMutation();
        mkdirSync(target, { recursive: true, mode: 0o700 });
      } else if (type === "0") {
        const entry = expected.get(archivePath);
        if (enforceExpected && (!entry || entry.size !== size)) throw new Error("git archive contains an unexpected or size-mismatched file");
        if (extracted.has(archivePath)) throw new Error("git archive contains a duplicate file");
        beforeMutation();
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        beforeMutation();
        const output = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        const hash = createHash("sha256");
        let consumed = 0;
        try {
          while (consumed < size) {
            const length = Math.min(IO_CHUNK, size - consumed);
            const chunk = readExactly(fd, dataStart + consumed, length);
            beforeMutation();
            writeSync(output, chunk);
            hash.update(chunk);
            consumed += length;
          }
          beforeMutation();
          fsyncSync(output);
        } finally { closeSync(output); }
        extracted.set(archivePath, { path: archivePath, size, sha256: hash.digest("hex") });
      } else {
        throw new Error(`git archive contains unsupported link/device entry type '${type}'`);
      }
      offset = dataStart + padded;
    }
  } finally { closeSync(fd); }
  if (enforceExpected && (extracted.size !== expected.size || [...expected.keys()].some((path) => !extracted.has(path)))) {
    throw new Error("git archive omitted a selected file");
  }
  return [...extracted.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

function boundedLocalGitTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_LOCAL_GIT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_LOCAL_GIT_TIMEOUT_MS) {
    throw new Error("invalid local Git timeout");
  }
  return timeout;
}

function resolvePinnedGitExecutable(configured?: string): string {
  const candidates = configured === undefined
    ? (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "git"))
    : [configured];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      const pinned = realpathSync.native(candidate);
      const entry = lstatSync(pinned);
      if (entry.isFile() && !entry.isSymbolicLink()) return pinned;
    } catch { /* continue */ }
  }
  throw new Error("trusted Git executable is unavailable");
}

async function runGit(
  execFile: typeof nodeExecFile,
  args: string[],
  cwd: string,
  maxBuffer = 4 * 1024 * 1024,
  local?: { timeoutMs: number; executable: string },
  assertOwnership: () => void = () => undefined,
): Promise<string> {
  try {
    const explicitGitDir = args.find((arg) => arg.startsWith("--git-dir="))?.slice("--git-dir=".length);
    const result = await new Promise<string>((resolveOutput, reject) => {
      let child: ReturnType<typeof nodeExecFile> | undefined;
      let ownershipError: Error | null = null;
      const monitor = setInterval(() => {
        try { assertOwnership(); } catch (error) {
          ownershipError = error instanceof Error ? error : new Error(String(error));
          child?.kill("SIGKILL");
        }
      }, 10);
      monitor.unref();
      try { assertOwnership(); } catch (error) { clearInterval(monitor); reject(error); return; }
      child = execFile(local?.executable ?? "git", args, {
        cwd, encoding: "utf8", maxBuffer,
        env: managedGitEnvironment(local ? { GIT_COMMON_DIR: explicitGitDir ?? cwd } : {}),
        ...(local ? { timeout: local.timeoutMs, killSignal: "SIGKILL" as const, windowsHide: true } : {}),
      }, (error, stdout) => {
        clearInterval(monitor);
        if (ownershipError) reject(ownershipError);
        else if (error) reject(error);
        else resolveOutput(String(stdout));
      });
    });
    return result.trim();
  } catch (error) {
    try { assertOwnership(); } catch (ownershipError) { throw ownershipError; }
    if (!local) throw error;
    const command = args.find((arg) => ["fsck", "rev-parse", "ls-tree", "cat-file", "diff"].includes(arg)) ?? "command";
    const detail = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (detail.killed || detail.signal === "SIGKILL" || /timed out|timeout/i.test(detail.message ?? "")) {
      throw new Error(`managed git-md ${command} timed out`);
    }
    throw new Error(`managed git-md ${command} failed`);
  }
}

async function runGitBuffer(
  execFile: typeof nodeExecFile,
  args: string[],
  cwd: string,
  maxBuffer: number,
  local: { timeoutMs: number; executable: string },
  assertOwnership: () => void = () => undefined,
): Promise<Buffer> {
  try {
    return await new Promise<Buffer>((resolveOutput, reject) => {
      const explicitGitDir = args.find((arg) => arg.startsWith("--git-dir="))?.slice("--git-dir=".length);
      let child: ReturnType<typeof nodeExecFile> | undefined;
      let ownershipError: Error | null = null;
      const monitor = setInterval(() => {
        try { assertOwnership(); } catch (error) {
          ownershipError = error instanceof Error ? error : new Error(String(error));
          child?.kill("SIGKILL");
        }
      }, 10);
      monitor.unref();
      try { assertOwnership(); } catch (error) { clearInterval(monitor); reject(error); return; }
      child = execFile(local.executable, args, {
        cwd, encoding: null, maxBuffer, env: managedGitEnvironment({ GIT_COMMON_DIR: explicitGitDir ?? cwd }),
        timeout: local.timeoutMs, killSignal: "SIGKILL", windowsHide: true,
      }, (error, stdout, stderr) => {
        clearInterval(monitor);
        if (ownershipError) reject(ownershipError);
        else if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolveOutput(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      });
    });
  } catch (error) {
    try { assertOwnership(); } catch (ownershipError) { throw ownershipError; }
    const command = args.find((arg) => ["fsck", "rev-parse", "ls-tree", "cat-file", "diff"].includes(arg)) ?? "command";
    const detail = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    if (detail.killed || detail.signal === "SIGKILL" || /timed out|timeout/i.test(detail.message ?? "")) {
      throw new Error(`managed git-md ${command} timed out`);
    }
    throw new Error(`managed git-md ${command} failed`);
  }
}

interface GitMaterializationDeadline {
  check(): void;
  command(localTimeoutMs: number): { timeoutMs: number; aggregateLimited: boolean };
}

function gitMaterializationDeadline(configured?: number, monotonicNow: () => number = () => performance.now()): GitMaterializationDeadline {
  const duration = configured ?? DEFAULT_GIT_MATERIALIZATION_DEADLINE_MS;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > MAX_GIT_MATERIALIZATION_DEADLINE_MS) {
    throw new Error("invalid git-md materialization deadline");
  }
  const startedAt = monotonicNow();
  if (!Number.isFinite(startedAt)) throw new Error("invalid git-md monotonic clock");
  const expiresAt = startedAt + duration;
  const remaining = (): number => {
    const current = monotonicNow();
    if (!Number.isFinite(current)) throw new Error("invalid git-md monotonic clock");
    return expiresAt - current;
  };
  const check = (): void => {
    if (remaining() <= 0) throw new Error("managed git-md materialization deadline exceeded");
  };
  return {
    check,
    command(localTimeoutMs) {
      check();
      const left = remaining();
      return { timeoutMs: Math.max(1, Math.min(localTimeoutMs, left)), aggregateLimited: left <= localTimeoutMs };
    },
  };
}

async function runGitBeforeDeadline(
  execFile: typeof nodeExecFile,
  args: string[],
  cwd: string,
  maxBuffer: number | undefined,
  local: { timeoutMs: number; executable: string },
  deadline: GitMaterializationDeadline,
  assertOwnership: () => void,
): Promise<string> {
  const command = deadline.command(local.timeoutMs);
  try {
    const output = await runGit(execFile, args, cwd, maxBuffer, { ...local, timeoutMs: command.timeoutMs }, assertOwnership);
    deadline.check();
    return output;
  } catch (error) {
    if (command.aggregateLimited && error instanceof Error && /timed out/.test(error.message)) {
      throw new Error("managed git-md materialization deadline exceeded");
    }
    deadline.check();
    throw error;
  }
}

async function runGitBufferBeforeDeadline(
  execFile: typeof nodeExecFile,
  args: string[],
  cwd: string,
  maxBuffer: number,
  local: { timeoutMs: number; executable: string },
  deadline: GitMaterializationDeadline,
  assertOwnership: () => void,
): Promise<Buffer> {
  const command = deadline.command(local.timeoutMs);
  try {
    const output = await runGitBuffer(execFile, args, cwd, maxBuffer, { ...local, timeoutMs: command.timeoutMs }, assertOwnership);
    deadline.check();
    return output;
  } catch (error) {
    if (command.aggregateLimited && error instanceof Error && /timed out/.test(error.message)) {
      throw new Error("managed git-md materialization deadline exceeded");
    }
    deadline.check();
    throw error;
  }
}

function splitNulRecords(output: Buffer): string[] | null {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: string[] = [];
  let start = 0;
  try {
    for (let index = 0; index < output.length; index += 1) {
      if (output[index] !== 0) continue;
      const value = decoder.decode(output.subarray(start, index));
      if (value.length === 0) return null;
      records.push(value);
      start = index + 1;
    }
  } catch { return null; }
  return records;
}

/**
 * Return only selected, globally one-to-one Git rename proofs. Any malformed,
 * conflicting, or over-budget evidence disables Git inference for the run; the
 * sync planner then safely falls back to content proof or ordinary delete+add.
 */
export async function detectRepoMdRenames(
  repositoryRoot: string,
  priorSnapshotId: string,
  nextSnapshotId: string,
  oldSelectedPaths: ReadonlySet<string>,
  newSelectedPaths: ReadonlySet<string>,
  options: {
    execFile?: typeof nodeExecFile; maxOutputBytes?: number; timeoutMs?: number; gitExecutable?: string;
  } = {},
): Promise<Map<string, string>> {
  if (!OID_RE.test(priorSnapshotId) || !OID_RE.test(nextSnapshotId)) return new Map();
  const maxBuffer = options.maxOutputBytes ?? MAX_RENAME_DIFF_BYTES;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > MAX_RENAME_DIFF_BYTES) return new Map();
  const execFile = options.execFile ?? nodeExecFile;
  const executable = options.timeoutMs === undefined
    ? (options.gitExecutable ?? "git")
    : resolvePinnedGitExecutable(options.gitExecutable);
  let output: Buffer;
  try {
    if (options.timeoutMs !== undefined) validateManagedGitInvocation(repositoryRoot);
    output = await new Promise<Buffer>((resolveOutput, reject) => {
      execFile(executable, [
        "--no-pager", "diff", "--no-ext-diff", "--name-status", "-z",
        "--no-textconv", `--find-renames=${REPO_MD_RENAME_SIMILARITY}%`, `-l${REPO_MD_RENAME_LIMIT}`,
        priorSnapshotId, nextSnapshotId, "--",
      ], {
        cwd: repositoryRoot, encoding: null, maxBuffer,
        env: managedGitEnvironment(options.timeoutMs === undefined ? {} : { GIT_COMMON_DIR: repositoryRoot }),
        ...(options.timeoutMs === undefined ? {} : {
          timeout: boundedLocalGitTimeout(options.timeoutMs), killSignal: "SIGKILL" as const, windowsHide: true,
        }),
      }, (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      });
    });
  } catch { return new Map(); }
  if (output.length > maxBuffer) return new Map();
  const records = splitNulRecords(output);
  if (records === null) return new Map();
  const result = new Map<string, string>();
  const destinations = new Set<string>();
  let index = 0;
  while (index < records.length) {
    const status = records[index++]!;
    if (/^[RC]\d{1,3}$/.test(status)) {
      if (index + 1 >= records.length) return new Map();
      const from = records[index++]!;
      const to = records[index++]!;
      // Copy evidence never authorizes identity carry. Consume it only to keep framing exact.
      if (status.startsWith("C")) continue;
      const score = Number(status.slice(1));
      if (score < REPO_MD_RENAME_SIMILARITY || score > 100) return new Map();
      // A rename crossing the selected boundary is irrelevant to this complete manifest.
      if (!oldSelectedPaths.has(from) || !newSelectedPaths.has(to)) continue;
      if (result.has(from) || destinations.has(to)) return new Map();
      result.set(from, to);
      destinations.add(to);
      continue;
    }
    if (!/^[AMDTUXB]$/.test(status) || index >= records.length) return new Map();
    index += 1;
  }
  return result;
}

function lockOwner(lock: string): { token: string; heartbeatAt: number; pid: number; host: string } | null {
  try {
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as Record<string, unknown>;
    if (typeof owner.token !== "string" || typeof owner.heartbeatAt !== "number"
        || typeof owner.pid !== "number" || typeof owner.host !== "string") return null;
    return owner as { token: string; heartbeatAt: number; pid: number; host: string };
  } catch { return null; }
}

function processIsLive(owner: { pid: number; host: string }): boolean {
  if (owner.host !== hostname()) return false;
  try { process.kill(owner.pid, 0); return true; } catch { return false; }
}

export async function withRepoMdMaterializerLock<T>(
  sourceId: string,
  options: RepoMdMaterializerOptions,
  work: (guard: SourceMaterializerLockGuard) => Promise<T>,
): Promise<T> {
  return withTypedMaterializerLock("repo-md", sourceId, options, work);
}

export async function withGitMdMaterializerLock<T>(
  sourceId: string,
  options: RepoMdMaterializerOptions,
  work: (guard: SourceMaterializerLockGuard) => Promise<T>,
): Promise<T> {
  return withTypedMaterializerLock("git-md", sourceId, options, work);
}

async function withTypedMaterializerLock<T>(
  type: "repo-md" | "git-md",
  sourceId: string,
  options: RepoMdMaterializerOptions,
  work: (guard: SourceMaterializerLockGuard) => Promise<T>,
): Promise<T> {
  const now = options.now ?? Date.now;
  const token = requireArtifactToken((options.token ?? randomUUID)());
  const staleMs = options.lockStaleMs ?? 5 * 60_000;
  requireSourceId(sourceId);
  const repo = managedTypeRoot(type, options.sourceStorageDir, true, () => undefined, options.safeTreeOps)!;
  // Validate an existing source root before even acquiring its sibling lock.
  typedSourceRoot(type, sourceId, options.sourceStorageDir, false, () => undefined, options.safeTreeOps);
  // The lock is a sibling of the source root so removal can quarantine the whole root atomically.
  const lock = join(repo, `.lock-${sourceId}`);
  const freezeLockTree = (path: string): FrozenSameDeviceTree => {
    const label = `${type} materializer lock tree`;
    const frozen = freezeSameDeviceTree(path, label, options.safeTreeOps);
    for (const [index, node] of frozen.nodes.entries()) {
      if (node.dev !== frozen.rootDev) throw new Error(`${label} crosses a filesystem boundary`);
      if (index === 0) {
        if (!node.directory) throw new Error(`${label} root is unsafe`);
        continue;
      }
      const name = relative(path, node.path);
      if (name.includes(sep) || !node.regularFile || node.symbolicLink || node.nlink !== 1
          || (name !== "owner.json" && !/^\.owner-[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(name))) {
        throw new Error(`${label} contains an unsafe node`);
      }
    }
    return frozen;
  };
  const validateLock = (): void => {
    const entry = assertManagedDirectoryTrust(lock, `${type} materializer lock`, options.safeTreeOps, true);
    const canonical = realpathSync.native(lock);
    if (!entry.isDirectory() || entry.isSymbolicLink() || canonical !== lock || dirname(canonical) !== repo) {
      throw new Error(`${type} materializer lock is not a real managed directory`);
    }
  };
  const writeOwner = (beforeMutation: () => void = () => undefined): void => {
    const temporary = join(lock, `.owner-${token}`);
    beforeMutation();
    writeFileSync(temporary, JSON.stringify({ token, heartbeatAt: now(), pid: process.pid, host: hostname() }), { flag: "wx", mode: 0o600 });
    beforeMutation();
    renameSync(temporary, join(lock, "owner.json"));
  };
  const acquire = (): void => {
    try { mkdirSync(lock, { mode: 0o700 }); validateLock(); writeOwner(); return; } catch {
      validateLock();
      const owner = lockOwner(lock);
      const heartbeat = owner?.heartbeatAt ?? lstatSync(lock).mtimeMs;
      if ((owner && processIsLive(owner)) || now() - heartbeat <= staleMs) throw new Error(`${type} source materializer is locked`);
      const stale = `${lock}.stale-${token}`;
      const frozenLock = freezeLockTree(lock);
      revalidateSameDeviceTree(frozenLock, `${type} materializer lock tree`, options.safeTreeOps);
      try { renameSync(lock, stale); } catch { throw new Error("repo-md source materializer lock changed during stale takeover"); }
      const frozenStale = freezeLockTree(stale);
      removeFrozenSameDeviceTree(frozenStale, `${type} materializer lock tree`, () => undefined,
        { ops: options.safeTreeOps });
      mkdirSync(lock, { mode: 0o700 });
      writeOwner();
    }
  };
  acquire();
  const acquiredEntry = assertManagedDirectoryTrust(lock, `${type} materializer lock`, options.safeTreeOps, true);
  let lostOwnership: Error | null = null;
  const assertOwnership = (): void => {
    if (lostOwnership) throw lostOwnership;
    try {
      const current = assertManagedDirectoryTrust(lock, `${type} materializer lock`, options.safeTreeOps, true);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== acquiredEntry.dev
          || current.ino !== acquiredEntry.ino || realpathSync.native(lock) !== lock
          || lockOwner(lock)?.token !== token) {
        throw new Error(`${type} materializer lock ownership was lost`);
      }
    } catch (error) {
      lostOwnership = error instanceof Error && /ownership was lost/.test(error.message)
        ? error : new Error(`${type} materializer lock ownership was lost`);
      throw lostOwnership;
    }
  };
  const heartbeat = setInterval(() => {
    try {
      assertOwnership();
      writeOwner(assertOwnership);
    } catch (error) { lostOwnership = error instanceof Error ? error : new Error(String(error)); }
  }, Math.max(10, Math.floor(staleMs / 3)));
  heartbeat.unref();
  try {
    options.fault?.("after-lock");
    const result = await work({ assertOwnership });
    assertOwnership();
    return result;
  } catch (error) {
    if (lostOwnership) throw lostOwnership;
    throw error;
  } finally {
    clearInterval(heartbeat);
    try {
      assertOwnership();
      const frozenLock = freezeLockTree(lock);
      removeFrozenSameDeviceTree(frozenLock, `${type} materializer lock tree`, assertOwnership,
        { ops: options.safeTreeOps, check: assertOwnership });
    } catch (error) {
      // A displaced owner must never remove the replacement owner's lock directory.
      if (!lostOwnership) throw error;
    }
  }
}

export interface SourceMaterializerLockGuard { assertOwnership(): void }

function variantName(snapshotId: string, configHash: string): string {
  if (!OID_RE.test(snapshotId)) throw new Error("invalid committed snapshot OID");
  if (!CONFIG_HASH_RE.test(configHash)) throw new Error("invalid effective ingest-config hash");
  return `${snapshotId}-${configHash.slice(-64)}`;
}

export function repoMdSnapshotPath(sourceId: string, snapshotId: string, configHash: string, sourceStorageDir: string): string {
  const root = sourceRoot(sourceId, sourceStorageDir)!;
  const frozen = freezeSnapshotsDirectory(root, true)!;
  revalidateSnapshotsDirectory(frozen);
  return join(frozen.snapshots.path, variantName(snapshotId, configHash));
}

export function sourceSnapshotPath(
  source: Pick<KnowledgeSource, "id" | "type">, snapshotId: string, configHash: string, sourceStorageDir: string,
  beforeMutation: () => void = () => undefined,
  safeTreeOps: SafeTreeOps = {},
): string {
  const root = typedSourceRoot(source.type, source.id, sourceStorageDir, true, beforeMutation, safeTreeOps)!;
  const frozen = freezeSnapshotsDirectory(root, true, beforeMutation, safeTreeOps)!;
  revalidateSnapshotsDirectory(frozen, safeTreeOps);
  return join(frozen.snapshots.path, variantName(snapshotId, configHash));
}

function repoMdSnapshotSidecarPath(sourceId: string, snapshotId: string, configHash: string, sourceStorageDir: string): string {
  return `${repoMdSnapshotPath(sourceId, snapshotId, configHash, sourceStorageDir)}.complete.json`;
}

function hashFile(path: string, check: () => void = () => undefined): { size: number; sha256: string } {
  const fd = openSync(path, constants.O_RDONLY);
  const hash = createHash("sha256");
  let size = 0;
  const buffer = Buffer.alloc(IO_CHUNK);
  try {
    for (;;) {
      check();
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      size += count;
    }
  } finally { closeSync(fd); }
  return { size, sha256: hash.digest("hex") };
}

function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function durableFsync(options: Pick<RepoMdMaterializerOptions, "fsyncPath">, path: string): void {
  (options.fsyncPath ?? fsyncPath)(path);
}

function durableSnapshotParents(options: RepoMdMaterializerOptions, root: string, beforeMutation: () => void): void {
  // Persist both the snapshots entry within the source root and a newly-created
  // source-root entry within its type root before the ledger can publish it.
  beforeMutation();
  durableFsync(options, root);
  beforeMutation();
  durableFsync(options, dirname(root));
}

function readFileWithChecks(path: string, check: () => void, maximumBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.alloc(IO_CHUNK);
  try {
    for (;;) {
      check();
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) throw new Error("existing source snapshot marker exceeds its byte limit");
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } finally { closeSync(fd); }
  check();
  return Buffer.concat(chunks, total).toString("utf8");
}

function validateSealedSnapshot(
  snapshotPath: string, sidecarPath: string, snapshotId: string, configHash: string,
  check: () => void = () => undefined,
): SnapshotMarker {
  check();
  const root = lstatSync(snapshotPath);
  if (!root.isDirectory() || root.isSymbolicLink() || realpathSync.native(snapshotPath) !== snapshotPath
      || (root.mode & 0o222) !== 0) throw new Error("existing source snapshot is not a sealed Monet directory");
  const rootDev = root.dev;
  const sidecar = lstatSync(sidecarPath);
  if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1 || (sidecar.mode & 0o222) !== 0) {
    throw new Error("existing source snapshot completion sidecar is not sealed");
  }
  if (sidecar.size > MAX_SNAPSHOT_MARKER_BYTES) throw new Error("existing source snapshot marker exceeds its byte limit");
  const marker = JSON.parse(readFileWithChecks(sidecarPath, check, MAX_SNAPSHOT_MARKER_BYTES)) as SnapshotMarker;
  if (marker.version !== 2 || marker.snapshotId !== snapshotId || marker.configHash !== configHash
      || marker.variant !== variantName(snapshotId, configHash) || !Array.isArray(marker.files)) {
    throw new Error("existing source snapshot marker does not match its OID/configuration");
  }
  const expected = new Map<string, SnapshotMarker["files"][number]>();
  const expectedDirectories = new Set<string>();
  for (const file of marker.files) {
    check();
    const path = validateArchivePath(file.path);
    if (path !== file.path || expected.has(path) || !Number.isSafeInteger(file.size) || file.size < 0
        || !DIGEST_RE.test(file.sha256)) throw new Error("existing source snapshot marker manifest is invalid");
    expected.set(path, file);
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      expectedDirectories.add(parts.slice(0, length).join("/"));
    }
  }
  const walk = (directory: string, relativeDirectory: string): void => {
    check();
    const children = readdirSync(directory, { withFileTypes: true });
    check();
    for (const entry of children) {
      check();
      const rel = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink() || (stats.mode & 0o222) !== 0) throw new Error("existing source snapshot is not sealed");
      if (entry.isDirectory()) {
        if (stats.dev !== rootDev) throw new Error("existing source snapshot crosses a filesystem boundary");
        if (!expectedDirectories.has(rel)) throw new Error("existing source snapshot contains an unexpected directory");
        walk(absolute, rel);
      }
      else if (entry.isFile()) {
        const wanted = expected.get(rel);
        const actual = hashFile(absolute, check);
        if (stats.nlink !== 1 || !wanted || wanted.size !== actual.size || wanted.sha256 !== actual.sha256) {
          throw new Error("existing source snapshot content was tampered");
        }
        expected.delete(rel);
      } else if (!entry.isFile()) throw new Error("existing source snapshot contains an unsupported node");
    }
  };
  walk(snapshotPath, "");
  if (expected.size !== 0) throw new Error("existing source snapshot is incomplete");
  return marker;
}

function validateSealedSnapshotAgainstLedger(
  snapshotPath: string, sidecarPath: string, snapshotId: string, configHash: string,
  publication: SourcePublishedManifest, check: () => void = () => undefined,
): SnapshotMarker {
  check();
  if (publication.snapshotId !== snapshotId || publication.ingestConfigHash !== configHash) {
    throw new Error("published ledger manifest does not match the active snapshot/configuration");
  }
  const marker = validateSealedSnapshot(snapshotPath, sidecarPath, snapshotId, configHash, check);
  const expected = new Map(publication.files.map((file) => [file.relativePath, file]));
  if (expected.size !== publication.files.length || marker.files.length !== publication.files.length) {
    throw new Error("sealed source snapshot does not match the durable ledger path set");
  }
  const observed = marker.files.map((file) => {
    check();
    const ledger = expected.get(file.path);
    const actualContentHash = `monet-src-content/v1:sha256:${file.sha256}`;
    if (!ledger || ledger.byteLength !== file.size || ledger.contentHash !== actualContentHash) {
      throw new Error("sealed source snapshot content does not match the durable ledger");
    }
    expected.delete(file.path);
    return { relativePath: file.path, type: "file" as const, contentHash: actualContentHash, byteLength: file.size };
  });
  if (expected.size !== 0 || computeSourceManifestHash(observed) !== publication.manifestHash) {
    throw new Error("sealed source snapshot manifest hash does not match the durable ledger");
  }
  return marker;
}

function acceptedStrictSupersetFiles(
  marker: SnapshotMarker,
  publication: SourcePublishedManifest,
): SnapshotMarker["files"] {
  if (marker.files.length <= publication.files.length) {
    throw new Error("active source snapshot does not match the durable ledger and is not the repairable strict-superset shape");
  }
  const ledgerByPath = new Map(publication.files.map((file) => [file.relativePath, file]));
  if (ledgerByPath.size !== publication.files.length) throw new Error("published ledger contains duplicate paths");
  const accepted: SnapshotMarker["files"] = [];
  const observed: Array<{ relativePath: string; type: "file"; contentHash: string; byteLength: number }> = [];
  for (const file of marker.files) {
    const ledger = ledgerByPath.get(file.path);
    if (!ledger) {
      // This repair exists only for the shipped broad-include incident: valid non-Markdown files
      // were sealed beside the canonical accepted Markdown ledger. Any extra Markdown path could
      // instead be lost ledger data, so it remains a hard failure.
      if (isMarkdownSourcePath(file.path)) {
        throw new Error("active source snapshot has an unexpected Markdown path outside the durable published ledger");
      }
      continue;
    }
    const contentHash = `monet-src-content/v1:sha256:${file.sha256}`;
    if (ledger.byteLength !== file.size || ledger.contentHash !== contentHash) {
      throw new Error("active source snapshot accepted bytes conflict with the durable published ledger");
    }
    accepted.push(file);
    observed.push({ relativePath: file.path, type: "file", contentHash, byteLength: file.size });
    ledgerByPath.delete(file.path);
  }
  if (ledgerByPath.size !== 0 || computeSourceManifestHash(observed) !== publication.manifestHash) {
    throw new Error("active source snapshot accepted paths do not close over the durable published ledger");
  }
  return accepted;
}

/**
 * Repair only the shipped active strict-superset shape. The complete old snapshot is first
 * authenticated, then canonical published-ledger files are copied and re-proven in a sealed
 * candidate. The active tuple and current pointer are untouched until that candidate validates.
 */
export function repairActiveSourceSnapshotStrictSuperset(
  source: SourcePathIdentity,
  publication: SourcePublishedManifest,
  options: RepoMdMaterializerOptions,
): boolean {
  if (!source.activeRunId || publication.sourceId !== source.id || publication.runId !== source.activeRunId) {
    throw new Error("active snapshot repair publication fence is stale");
  }
  const beforeMutation = options.assertOwnership ?? (() => undefined);
  const safeTreeOps = options.safeTreeOps ?? {};
  const check = (): void => beforeMutation();
  const root = typedSourceRoot(source.type, source.id, options.sourceStorageDir, false, beforeMutation, safeTreeOps);
  if (!root) throw new Error("active source snapshot is unavailable for repair");
  const frozen = freezeSnapshotsDirectory(root, false, beforeMutation, safeTreeOps);
  if (!frozen) throw new Error("active source snapshots directory is unavailable for repair");
  const snapshots = frozen.snapshots.path;
  const variant = variantName(publication.snapshotId, publication.ingestConfigHash);
  const snapshot = join(snapshots, variant);
  const sidecar = `${snapshot}.complete.json`;
  const candidate = join(snapshots, `.tree-${variant}-active-repair`);
  const candidateSidecar = join(snapshots, `.complete-${variant}-active-repair.json`);
  // Keep the sealed backup beside the final variant. macOS rejects moving a non-writable sealed
  // directory between parents even on one filesystem; same-parent renames remain atomic.
  const backupSnapshot = join(snapshots, `.tree-${variant}-active-backup`);
  const backupSidecar = join(snapshots, `.complete-${variant}-active-backup.json`);

  const removeLeaf = (path: string, label: string): void => {
    try {
      const frozenLeaf = freezeStagingLeaf(path, label);
      removeFrozenStagingLeaf(frozenLeaf, label, beforeMutation, check);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  const removeCandidate = (): void => {
    removeManagedTree(candidate, "active source repair candidate", beforeMutation, safeTreeOps, check);
    removeLeaf(candidateSidecar, "active source repair candidate sidecar");
  };
  const validateRepairable = (tree: string, markerPath: string): SnapshotMarker["files"] => {
    const marker = validateSealedSnapshot(
      tree, markerPath, publication.snapshotId, publication.ingestConfigHash, check,
    );
    return acceptedStrictSupersetFiles(marker, publication);
  };
  const removeBackup = (): void => {
    removeManagedTree(backupSnapshot, "active source repair backup", beforeMutation, safeTreeOps, check);
    removeLeaf(backupSidecar, "active source repair backup sidecar");
    beforeMutation();
    durableFsync(options, snapshots);
  };
  const restoreBackup = (): void => {
    let backupTreeExists = pathEntryExists(backupSnapshot);
    let backupSidecarExists = pathEntryExists(backupSidecar);
    if (!backupTreeExists && !backupSidecarExists) return;
    if (backupTreeExists && !backupSidecarExists
        && !pathEntryExists(snapshot) && pathEntryExists(sidecar)) {
      validateRepairable(backupSnapshot, sidecar);
      beforeMutation();
      renameSync(sidecar, backupSidecar);
      backupSidecarExists = true;
    } else if (!backupTreeExists && backupSidecarExists
        && pathEntryExists(snapshot) && !pathEntryExists(sidecar)) {
      validateRepairable(snapshot, backupSidecar);
      beforeMutation();
      renameSync(backupSidecar, sidecar);
      beforeMutation();
      durableFsync(options, snapshots);
      return;
    }
    if (!backupTreeExists || !backupSidecarExists) throw new Error("active source repair backup is incomplete");
    validateRepairable(backupSnapshot, backupSidecar);
    if (pathEntryExists(snapshot)) {
      removeManagedTree(snapshot, "incomplete active source repair snapshot", beforeMutation, safeTreeOps, check);
    }
    if (pathEntryExists(sidecar)) removeLeaf(sidecar, "incomplete active source repair sidecar");
    revalidateSnapshotsDirectory(frozen, safeTreeOps);
    beforeMutation();
    renameSync(backupSnapshot, snapshot);
    beforeMutation();
    renameSync(backupSidecar, sidecar);
    beforeMutation();
    durableFsync(options, snapshots);
  };

  revalidateSnapshotsDirectory(frozen, safeTreeOps);
  if (pathEntryExists(backupSnapshot) || pathEntryExists(backupSidecar)) {
    try {
      validateSealedSnapshotAgainstLedger(
        snapshot, sidecar, publication.snapshotId, publication.ingestConfigHash, publication, check,
      );
      removeBackup();
      removeCandidate();
      return true;
    } catch {
      restoreBackup();
    }
  }
  try {
    validateSealedSnapshotAgainstLedger(
      snapshot, sidecar, publication.snapshotId, publication.ingestConfigHash, publication, check,
    );
    removeCandidate();
    return false;
  } catch { /* Authenticate the one repairable strict-superset shape below. */ }

  removeCandidate();
  const accepted = validateRepairable(snapshot, sidecar);
  revalidateSnapshotsDirectory(frozen, safeTreeOps);
  beforeMutation();
  mkdirSync(candidate, { mode: 0o700 });
  try {
    for (const file of accepted) {
      check();
      const sourcePath = join(snapshot, file.path);
      const targetPath = join(candidate, file.path);
      const bytes = readFileSync(sourcePath);
      if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new Error("active source snapshot accepted bytes changed during repair");
      }
      beforeMutation();
      mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
      beforeMutation();
      writeFileSync(targetPath, bytes, { flag: "wx", mode: file.mode === "100755" ? 0o700 : 0o600 });
    }
    const marker: SnapshotMarker = {
      version: 2,
      snapshotId: publication.snapshotId,
      configHash: publication.ingestConfigHash,
      variant,
      files: accepted,
    };
    const markerBytes = Buffer.from(JSON.stringify(marker), "utf8");
    if (markerBytes.length > MAX_SNAPSHOT_MARKER_BYTES) throw new Error("accepted source snapshot marker exceeds its byte limit");
    sealSnapshot(candidate, beforeMutation, safeTreeOps, check);
    beforeMutation();
    writeFileSync(candidateSidecar, markerBytes, { flag: "wx", mode: 0o600 });
    beforeMutation();
    chmodSync(candidateSidecar, 0o400);
    beforeMutation();
    durableFsync(options, candidateSidecar);
    validateSealedSnapshotAgainstLedger(
      candidate, candidateSidecar, publication.snapshotId, publication.ingestConfigHash, publication, check,
    );

    // Only now may the stable path move. The old pair remains recoverable in a deterministic
    // backup until the replacement pair has itself passed the same canonical ledger proof.
    options.fault?.("before-snapshot-rename");
    beforeMutation();
    renameSync(snapshot, backupSnapshot);
    options.fault?.("before-sidecar-rename");
    beforeMutation();
    renameSync(sidecar, backupSidecar);
    beforeMutation();
    durableFsync(options, snapshots);
    beforeMutation();
    renameSync(candidate, snapshot);
    options.fault?.("after-snapshot-rename");
    beforeMutation();
    renameSync(candidateSidecar, sidecar);
    beforeMutation();
    durableFsync(options, snapshots);
    options.fault?.("after-sidecar-rename");
    validateSealedSnapshotAgainstLedger(
      snapshot, sidecar, publication.snapshotId, publication.ingestConfigHash, publication, check,
    );
    removeBackup();
    return true;
  } catch (error) {
    try {
      validateSealedSnapshotAgainstLedger(
        snapshot, sidecar, publication.snapshotId, publication.ingestConfigHash, publication, check,
      );
      if (pathEntryExists(backupSnapshot) || pathEntryExists(backupSidecar)) removeBackup();
    } catch {
      try { restoreBackup(); } catch { /* Deterministic backup is recovered by the next locked retry. */ }
    }
    throw error;
  } finally {
    try { removeCandidate(); } catch { /* Preserve the primary repair result/failure. */ }
  }
}

/** Validate the exact sealed active variant and stable pointer without repairing either. */
export function validateRepoMdPublishedPath(
  sourceId: string,
  snapshotId: string,
  configHash: string,
  sourceStorageDir: string,
): { path: string; snapshotPath: string } {
  const root = sourceRoot(sourceId, sourceStorageDir, false);
  if (!root) throw new Error("published source snapshot is unavailable");
  const snapshots = join(root, "snapshots");
  const snapshotsReal = realpathSync.native(snapshots);
  if (snapshotsReal !== snapshots) throw new Error("published source snapshots directory is not canonical");
  const snapshotPath = join(snapshots, variantName(snapshotId, configHash));
  validateSealedSnapshot(snapshotPath, `${snapshotPath}.complete.json`, snapshotId, configHash);
  const snapshotReal = realpathSync.native(snapshotPath);
  if (snapshotReal !== snapshotPath || dirname(snapshotReal) !== snapshotsReal) {
    throw new Error("published source snapshot escapes managed storage");
  }
  const current = join(root, "current");
  const currentEntry = lstatSync(current);
  if (!currentEntry.isSymbolicLink()) throw new Error("published source current pointer is not a symlink");
  if (readlinkSync(current) !== relative(root, snapshotPath) || realpathSync.native(current) !== snapshotReal) {
    throw new Error("published source current pointer does not match the active snapshot");
  }
  return { path: current, snapshotPath };
}

export function validateSourcePublishedPath(
  source: SourcePathIdentity,
  snapshotId: string,
  configHash: string,
  sourceStorageDir: string,
  publication?: SourcePublishedManifest,
  check: () => void = () => undefined,
): { path: string; snapshotPath: string } {
  check();
  const root = typedSourceRoot(source.type, source.id, sourceStorageDir, false);
  if (!root) throw new Error("published source snapshot is unavailable");
  const frozen = freezeSnapshotsDirectory(root, false);
  if (!frozen) throw new Error("published source snapshots directory is unavailable");
  check();
  revalidateSnapshotsDirectory(frozen);
  const snapshots = frozen.snapshots.path;
  const snapshotsReal = snapshots;
  const snapshotPath = join(snapshots, variantName(snapshotId, configHash));
  if (publication) {
    if (source.activeRunId && publication.runId !== source.activeRunId) throw new Error("published ledger manifest run fence is stale");
    validateSealedSnapshotAgainstLedger(snapshotPath, `${snapshotPath}.complete.json`, snapshotId, configHash, publication, check);
  }
  else validateSealedSnapshot(snapshotPath, `${snapshotPath}.complete.json`, snapshotId, configHash, check);
  check();
  const snapshotReal = realpathSync.native(snapshotPath);
  if (snapshotReal !== snapshotPath || dirname(snapshotReal) !== snapshotsReal) throw new Error("published source snapshot escapes managed storage");
  const current = join(root, "current");
  check();
  revalidateSnapshotsDirectory(frozen);
  if (!lstatSync(current).isSymbolicLink() || readlinkSync(current) !== relative(root, snapshotPath)
      || realpathSync.native(current) !== snapshotReal) throw new Error("published source current pointer does not match the active snapshot");
  check();
  return { path: current, snapshotPath };
}

/** Validate a staged source snapshot against its canonical ledger before activation. */
export function validateStagedSourcePublication(
  source: Pick<KnowledgeSource, "id" | "type">,
  publication: SourcePublishedManifest,
  sourceStorageDir: string,
  check: () => void = () => undefined,
): void {
  if (publication.sourceId !== source.id) throw new Error("staged source publication belongs to a different source");
  check();
  const root = typedSourceRoot(source.type, source.id, sourceStorageDir, false);
  if (!root) throw new Error("staged source snapshot is unavailable");
  const frozen = freezeSnapshotsDirectory(root, false);
  if (!frozen) throw new Error("staged source snapshots directory is unavailable");
  revalidateSnapshotsDirectory(frozen);
  const snapshot = join(frozen.snapshots.path, variantName(publication.snapshotId, publication.ingestConfigHash));
  validateSealedSnapshotAgainstLedger(
    snapshot, `${snapshot}.complete.json`, publication.snapshotId, publication.ingestConfigHash, publication, check,
  );
  check();
  revalidateSnapshotsDirectory(frozen);
}

function sealSnapshot(
  tree: string, beforeMutation: () => void = () => undefined,
  safeTreeOps: SafeTreeOps = {}, check: () => void = () => undefined,
): void {
  const frozen = freezeSameDeviceTree(tree, "managed source snapshot staging tree", safeTreeOps, check);
  revalidateSameDeviceTree(frozen, "managed source snapshot staging tree", safeTreeOps, check);
  const seal = (directory: string): void => {
    check();
    const children = readdirSync(directory, { withFileTypes: true });
    check();
    for (const entry of children) {
      check();
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) seal(absolute);
      else { beforeMutation(); chmodSync(absolute, 0o400); fsyncPath(absolute); }
    }
    beforeMutation();
    chmodSync(directory, 0o500);
    fsyncPath(directory);
  };
  seal(tree);
}

function removeManagedTree(
  path: string, label: string, beforeMutation: () => void = () => undefined,
  safeTreeOps: SafeTreeOps = {}, check: () => void = () => undefined,
): void {
  try {
    const frozen = freezeSameDeviceTree(path, label, safeTreeOps, check);
    removeFrozenSameDeviceTree(frozen, label, beforeMutation, { writable: true, ops: safeTreeOps, check });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function pointRepoMdCurrent(
  sourceId: string,
  snapshotId: string,
  configHash: string,
  options: RepoMdMaterializerOptions,
): string {
  return pointSourceCurrent({ id: sourceId, type: "repo-md" }, snapshotId, configHash, options);
}

export function pointSourceCurrent(
  source: SourcePathIdentity,
  snapshotId: string,
  configHash: string,
  options: RepoMdMaterializerOptions,
  publication?: SourcePublishedManifest,
): string {
  const beforeMutation = options.assertOwnership ?? (() => undefined);
  const safeTreeOps = options.safeTreeOps ?? {};
  const root = typedSourceRoot(source.type, source.id, options.sourceStorageDir, true, beforeMutation, safeTreeOps)!;
  const frozen = freezeSnapshotsDirectory(root, false, beforeMutation, safeTreeOps);
  if (!frozen) throw new Error("published source snapshots directory is unavailable");
  const revalidate = (): void => revalidateSnapshotsDirectory(frozen, safeTreeOps);
  revalidate();
  const snapshot = join(frozen.snapshots.path, variantName(snapshotId, configHash));
  if (publication) {
    if (publication.sourceId !== source.id) throw new Error("published ledger manifest belongs to a different source");
    if (source.activeRunId && publication.runId !== source.activeRunId) throw new Error("published ledger manifest run fence is stale");
    validateSealedSnapshotAgainstLedger(snapshot, `${snapshot}.complete.json`, snapshotId, configHash, publication);
  } else validateSealedSnapshot(snapshot, `${snapshot}.complete.json`, snapshotId, configHash);
  const current = join(root, "current");
  for (const name of readdirSync(root)) {
    if (!/^\.current-[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(name)) continue;
    const stale = join(root, name);
    const entry = lstatSync(stale);
    const target = entry.isSymbolicLink() ? readlinkSync(stale) : "";
    if (!entry.isSymbolicLink() || !target.startsWith(`snapshots${sep}`) || isAbsolute(target)) {
      throw new Error("managed source current staging pointer is poisoned");
    }
    beforeMutation();
    rmSync(stale);
  }
  const temporary = join(root, `.current-${requireArtifactToken((options.token ?? randomUUID)())}`);
  revalidate();
  options.fault?.("before-current-swap");
  revalidate();
  beforeMutation();
  symlinkSync(relative(root, snapshot), temporary, "dir");
  try {
    revalidate();
    if (publication) validateSealedSnapshotAgainstLedger(snapshot, `${snapshot}.complete.json`, snapshotId, configHash, publication);
    revalidate();
    beforeMutation();
    renameSync(temporary, current);
    // The pointer is not published to callers until its directory entry is durable.
    beforeMutation();
    durableFsync(options, root);
  } catch (error) { beforeMutation(); rmSync(temporary, { force: true }); throw error; }
  options.fault?.("after-current-swap");
  return current;
}

export function revokeRepoMdCurrent(sourceId: string, sourceStorageDir: string): void {
  revokeSourceCurrent({ id: sourceId, type: "repo-md" }, sourceStorageDir);
}

export function revokeSourceCurrent(
  source: Pick<KnowledgeSource, "id" | "type">, sourceStorageDir: string, beforeMutation: () => void = () => undefined,
  safeTreeOps: SafeTreeOps = {},
): void {
  const root = typedSourceRoot(source.type, source.id, sourceStorageDir, false, beforeMutation, safeTreeOps);
  if (!root) return;
  const frozen = freezeSnapshotsDirectory(root, false, beforeMutation, safeTreeOps);
  if (frozen) revalidateSnapshotsDirectory(frozen, safeTreeOps);
  const current = join(root, "current");
  try {
    const entry = lstatSync(current);
    if (!entry.isSymbolicLink()) throw new Error(`managed ${source.type} current pointer is not a symlink`);
    if (frozen) revalidateSnapshotsDirectory(frozen, safeTreeOps);
    beforeMutation();
    rmSync(current);
    beforeMutation();
    fsyncPath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Remove only recognizable Monet-owned artifacts beneath the hashed source storage root. */
export function removeRepoMdMaterializations(sourceId: string, sourceStorageDir: string): void {
  removeSourceMaterializations({ id: sourceId, type: "repo-md" }, sourceStorageDir);
}

interface FrozenRemovalDirectory {
  path: string;
  dev: number;
  ino: number;
  tree: FrozenSameDeviceTree;
}

function freezeRemovalDirectory(
  repo: string, path: string, label: string, safeTreeOps: SafeTreeOps = {},
): FrozenRemovalDirectory {
  const entry = assertManagedDirectoryTrust(path, label, safeTreeOps, true);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync.native(path) !== path
      || dirname(path) !== repo || !contained(repo, path)) {
    const requirement = label === "managed source removal quarantine"
      ? "not a real direct-child directory"
      : "not a recognized real direct-child directory";
    throw new Error(`${label} is ${requirement}`);
  }
  return { path, dev: entry.dev, ino: entry.ino, tree: freezeSameDeviceTree(path, label, safeTreeOps) };
}

function revalidateRemovalDirectory(
  repo: string, frozen: FrozenRemovalDirectory, label: string, safeTreeOps: SafeTreeOps = {},
): void {
  const current = freezeRemovalDirectory(repo, frozen.path, label, safeTreeOps);
  if (current.dev !== frozen.dev || current.ino !== frozen.ino) throw new Error(`${label} changed during removal`);
  revalidateSameDeviceTree(frozen.tree, label, safeTreeOps);
}

function validateRemovalTree(path: string, root: string, rootDev: number): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) return; // A recognized leaf link is unlinked, never followed.
  if (entry.isDirectory()) {
    if (entry.dev !== rootDev) throw new Error("managed source removal tree crosses a filesystem boundary");
    if (realpathSync.native(path) !== path || !contained(root, path)) throw new Error("managed source removal tree escapes its quarantine");
    for (const child of readdirSync(path)) validateRemovalTree(join(path, child), root, rootDev);
    return;
  }
  if (!entry.isFile()) throw new Error("managed source removal tree contains an unsupported node");
}

function validateRemovalRootContents(
  removalRoot: string, sourceType: "repo-md" | "git-md", allowCurrent: boolean, safeTreeOps: SafeTreeOps = {},
): void {
  const rootDev = lstatSync(removalRoot).dev;
  const variant = "[0-9a-f]{40,64}-[0-9a-f]{64}";
  const finalTree = new RegExp(`^${variant}$`);
  const finalSidecar = new RegExp(`^${variant}\\.complete\\.json$`);
  const temporaryTree = new RegExp(`^\\.tree-${variant}-[A-Za-z0-9-]+$`);
  const temporarySidecar = new RegExp(`^\\.complete-${variant}-[A-Za-z0-9-]+\\.json$`);
  const snapshots = join(removalRoot, "snapshots");
  try {
    const snapshotsEntry = assertManagedDirectoryTrust(snapshots, "managed source snapshots root", safeTreeOps, true);
    if (!snapshotsEntry.isDirectory() || snapshotsEntry.isSymbolicLink() || realpathSync.native(snapshots) !== snapshots
        || !contained(removalRoot, snapshots)) throw new Error("managed source snapshots root is not a canonical real directory");
    for (const entry of readdirSync(snapshots, { withFileTypes: true })) {
      const recognizedTree = finalTree.test(entry.name) || temporaryTree.test(entry.name);
      const recognizedSidecar = finalSidecar.test(entry.name) || temporarySidecar.test(entry.name);
      if ((!recognizedTree && !recognizedSidecar) || (recognizedTree && !entry.isDirectory() && !entry.isSymbolicLink())
          || (recognizedSidecar && !entry.isFile() && !entry.isSymbolicLink())) {
        throw new Error(`unrecognized node in managed source snapshots: ${entry.name}`);
      }
      validateRemovalTree(join(snapshots, entry.name), removalRoot, rootDev);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of readdirSync(removalRoot, { withFileTypes: true })) {
    if (entry.name === "snapshots") continue;
    const materializeTemp = /^\.materialize-[0-9a-f]{40,64}-[A-Za-z0-9-]+$/.test(entry.name);
    const currentTemp = /^\.current-[A-Za-z0-9-]+$/.test(entry.name);
    const current = allowCurrent && entry.name === "current";
    const bareRepository = sourceType === "git-md" && entry.name === "repository.git";
    if ((!materializeTemp && !currentTemp && !current && !bareRepository)
        || (materializeTemp && !entry.isDirectory() && !entry.isSymbolicLink())
        || ((currentTemp || current) && !entry.isSymbolicLink())
        || (bareRepository && !entry.isDirectory() && !entry.isSymbolicLink())) {
      throw new Error(`unrecognized node in managed ${sourceType} source root: ${entry.name}`);
    }
    if (bareRepository && entry.isDirectory()) {
      assertManagedDirectoryTrust(join(removalRoot, entry.name), "managed git-md repository", safeTreeOps, true);
    }
    validateRemovalTree(join(removalRoot, entry.name), removalRoot, rootDev);
  }
}

function preflightSourceMaterializationRemoval(
  source: Pick<KnowledgeSource, "id" | "type">, sourceStorageDir: string, safeTreeOps: SafeTreeOps = {},
): {
  repo: string;
  auxiliary: FrozenRemovalDirectory[];
  quarantines: FrozenRemovalDirectory[];
  root: string | null;
  frozenRoot: FrozenRemovalDirectory | null;
} {
  const sourceId = source.id;
  requireSourceId(sourceId);
  const repo = managedTypeRoot(source.type, sourceStorageDir, true, () => undefined, safeTreeOps)!;
  const auxiliary: FrozenRemovalDirectory[] = [];
  const quarantines: FrozenRemovalDirectory[] = [];
  // Phase one is deliberately exhaustive: no owned artifact is touched until
  // every current/legacy name and every removal root has been classified and
  // validated.
  for (const name of readdirSync(repo)) {
    const auxiliaryOwnership = source.type === "git-md"
      ? (["clone", "corrupt", "repo"] as const).map((kind) => siblingArtifactOwnership(name, kind, sourceId))
      : [];
    const removalOwnership = siblingArtifactOwnership(name, "remove", sourceId);
    if (auxiliaryOwnership.includes("ambiguous")) throw new Error("managed git-md legacy artifact ownership is ambiguous");
    if (removalOwnership === "ambiguous") throw new Error("managed source legacy removal ownership is ambiguous");
    if (auxiliaryOwnership.includes("owned")) {
      auxiliary.push(freezeRemovalDirectory(repo, join(repo, name), "managed git-md quarantine", safeTreeOps));
    }
    if (removalOwnership === "owned") {
      const frozen = freezeRemovalDirectory(repo, join(repo, name), "managed source removal quarantine", safeTreeOps);
      validateRemovalRootContents(frozen.path, source.type, true, safeTreeOps);
      quarantines.push(frozen);
    }
  }
  const root = typedSourceRoot(source.type, sourceId, sourceStorageDir, false, () => undefined, safeTreeOps);
  const frozenRoot = root ? freezeRemovalDirectory(repo, root, `managed ${source.type} source root`, safeTreeOps) : null;
  if (root) validateRemovalRootContents(root, source.type, true, safeTreeOps);

  return { repo, auxiliary, quarantines, root, frozenRoot };
}

/** Read-only exhaustive removal validation used before the coordinator revokes current. */
export function validateSourceMaterializationRemoval(
  source: Pick<KnowledgeSource, "id" | "type">,
  sourceStorageDir: string,
  safeTreeOps: SafeTreeOps = {},
): void {
  const { repo, auxiliary, quarantines, frozenRoot } = preflightSourceMaterializationRemoval(source, sourceStorageDir, safeTreeOps);
  for (const frozen of auxiliary) revalidateRemovalDirectory(repo, frozen, "managed git-md quarantine", safeTreeOps);
  for (const frozen of quarantines) revalidateRemovalDirectory(repo, frozen, "managed source removal quarantine", safeTreeOps);
  if (frozenRoot) revalidateRemovalDirectory(repo, frozenRoot, `managed ${source.type} source root`, safeTreeOps);
}

export function removeSourceMaterializations(
  source: Pick<KnowledgeSource, "id" | "type">, sourceStorageDir: string, beforeMutation: () => void = () => undefined,
  safeTreeOps: SafeTreeOps = {},
): void {
  const sourceId = source.id;
  const { repo, auxiliary, quarantines, root, frozenRoot } = preflightSourceMaterializationRemoval(source, sourceStorageDir, safeTreeOps);

  // Revalidate the entire frozen set once more at the mutation boundary, then
  // each directory immediately before its own rename/removal.
  for (const frozen of [...auxiliary, ...quarantines]) {
    revalidateRemovalDirectory(repo, frozen, "managed source quarantine", safeTreeOps);
  }
  if (frozenRoot) revalidateRemovalDirectory(repo, frozenRoot, `managed ${source.type} source root`, safeTreeOps);

  for (const frozen of auxiliary) {
    revalidateRemovalDirectory(repo, frozen, "managed git-md quarantine", safeTreeOps);
    removeFrozenSameDeviceTree(frozen.tree, "managed git-md quarantine", beforeMutation, { writable: true, ops: safeTreeOps });
    beforeMutation();
    (safeTreeOps.fsyncPath ?? fsyncPath)(repo);
  }
  if (root) {
    const quarantine = join(repo, siblingArtifactName("remove", sourceId, randomUUID()));
    revalidateRemovalDirectory(repo, frozenRoot!, `managed ${source.type} source root`, safeTreeOps);
    beforeMutation();
    renameSync(root, quarantine);
    beforeMutation();
    (safeTreeOps.fsyncPath ?? fsyncPath)(repo);
    const frozen = freezeRemovalDirectory(repo, quarantine, "managed source removal quarantine", safeTreeOps);
    validateRemovalRootContents(frozen.path, source.type, true, safeTreeOps);
    quarantines.push(frozen);
  }
  for (const frozen of quarantines) {
    revalidateRemovalDirectory(repo, frozen, "managed source removal quarantine", safeTreeOps);
    validateRemovalRootContents(frozen.path, source.type, true, safeTreeOps);
    removeFrozenSameDeviceTree(frozen.tree, "managed source removal quarantine", beforeMutation,
      { writable: true, ops: safeTreeOps });
    beforeMutation();
    (safeTreeOps.fsyncPath ?? fsyncPath)(repo);
  }
}

export async function materializeRepoMdHead(source: KnowledgeSource, options: RepoMdMaterializerOptions): Promise<RepoMdMaterialization> {
  if (source.type !== "repo-md" || source.lifecycle !== "active") throw new Error("repo-md materialization requires an active repo-md source");
  const execFile = options.execFile ?? nodeExecFile;
  const registered = realpathSync.native(source.localPath);
  const top = realpathSync.native(await runGit(execFile, ["rev-parse", "--show-toplevel"], registered));
  if (top !== registered) throw new Error("registered repo-md localPath is not the Git worktree root");
  const snapshotId = (await runGit(execFile, ["rev-parse", "--verify", "HEAD^{commit}"], top)).toLowerCase();
  if (!OID_RE.test(snapshotId)) throw new Error("git returned an invalid committed HEAD OID");
  return materializeRepoMdCommitAtRoot(source, snapshotId, top, options, execFile);
}

export async function materializeRepoMdCommit(source: KnowledgeSource, snapshotId: string, options: RepoMdMaterializerOptions): Promise<RepoMdMaterialization> {
  if (source.type !== "repo-md" || source.lifecycle !== "active") throw new Error("repo-md materialization requires an active repo-md source");
  if (!OID_RE.test(snapshotId)) throw new Error("invalid committed snapshot OID");
  const execFile = options.execFile ?? nodeExecFile;
  const registered = realpathSync.native(source.localPath);
  const top = realpathSync.native(await runGit(execFile, ["rev-parse", "--show-toplevel"], registered));
  if (top !== registered) throw new Error("registered repo-md localPath is not the Git worktree root");
  return materializeRepoMdCommitAtRoot(source, snapshotId, top, options, execFile);
}

/** Materialize an exact commit from Monet's validated bare git-md repository. */
export async function materializeGitMdCommit(source: KnowledgeSource, snapshotId: string, options: RepoMdMaterializerOptions): Promise<RepoMdMaterialization> {
  if (source.type !== "git-md" || source.lifecycle !== "active") throw new Error("git-md materialization requires an active git-md source");
  if (!OID_RE.test(snapshotId)) throw new Error("invalid committed snapshot OID");
  const execFile = options.execFile ?? nodeExecFile;
  if (dirname(source.localPath) !== typedSourceRoot("git-md", source.id, options.sourceStorageDir, false, () => undefined, options.safeTreeOps)) {
    throw new Error("registered git-md repository escapes its managed source root");
  }
  return materializeRepoMdCommitAtRoot(source, snapshotId, source.localPath, options, execFile);
}

async function enumerateSelectedTree(
  source: KnowledgeSource,
  snapshotId: string,
  top: string,
  options: RepoMdMaterializerOptions,
  execFile: typeof nodeExecFile,
  localGit?: { timeoutMs: number; executable: string },
  deadline?: GitMaterializationDeadline,
): Promise<{ config: EffectiveSourceScanConfig; entries: TreeEntry[]; diagnostics: SourceScanDiagnostic[] }> {
  const config = options.config ?? effectiveSourceScanConfig({ autoDetect: source.autoDetect, include: source.include, exclude: source.exclude });
  const listingLimit = Math.min(32 * 1024 * 1024, Math.max(1024 * 1024, config.limits.maxEntries * 512));
  const args = ["ls-tree", "-r", "-t", "-z", "--long", snapshotId];
  const records: Array<{ metadata: string; path: string }> = [];
  if (localGit && deadline) {
    validateManagedGitInvocation(top);
    const listing = await runGitBufferBeforeDeadline(
      execFile, args, top, listingLimit, localGit, deadline, options.assertOwnership ?? (() => undefined),
    );
    if (listing.length > 0 && listing[listing.length - 1] !== 0) throw new Error("cannot parse pinned Git tree entry");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let start = 0;
    for (let index = 0; index < listing.length; index += 1) {
      if (listing[index] !== 0) continue;
      const record = listing.subarray(start, index);
      const tab = record.indexOf(0x09);
      if (tab < 1 || tab === record.length - 1) throw new Error("cannot parse pinned Git tree entry");
      let metadata: string;
      let path: string;
      try {
        metadata = decoder.decode(record.subarray(0, tab));
        path = decoder.decode(record.subarray(tab + 1));
      } catch {
        throw new Error("pinned Git tree contains an invalid UTF-8 pathname");
      }
      records.push({ metadata, path });
      start = index + 1;
    }
  } else {
    const listing = await runGit(execFile, args, top, listingLimit, localGit);
    records.push(...listing.split("\0").filter(Boolean).map((record) => {
      const tab = record.indexOf("\t");
      if (tab < 1 || tab === record.length - 1) throw new Error("cannot parse pinned Git tree entry");
      return { metadata: record.slice(0, tab), path: record.slice(tab + 1) };
    }));
  }
  if (records.length > config.limits.maxEntries) throw new Error("pinned Git tree exceeds the materialization entry limit");
  const entries: TreeEntry[] = [];
  const diagnostics: SourceScanDiagnostic[] = [];
  let totalBytes = 0;
  for (const record of records) {
    options.assertOwnership?.();
    deadline?.check();
    const match = /^(\d+) (\w+) ([0-9a-f]+)\s+([0-9-]+)$/.exec(record.metadata);
    if (!match) throw new Error("cannot parse pinned Git tree entry");
    const [, mode, type, oid, sizeText] = match;
    const path = validateArchivePath(record.path);
    if (type === "tree") continue;
    const selected = config.include.some((pattern) => matchesSourceGlob(pattern, path))
      && !config.exclude.some((pattern) => matchesSourceGlob(pattern, path));
    if (!selected) continue;
    // Per-file: a non-regular selected entry or an individually oversized Markdown blob is skipped and
    // diagnosed rather than aborting the whole tree. Tree-level budgets below (maxEntries above,
    // maxFiles/maxTotalBytes below) remain hard throws — those bound aggregate resource use, not
    // one file's content, and skip-and-diagnose must never let them silently no-op.
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      diagnostics.push({ code: "unsupported-node", message: "selected Git entry is not a regular file", relativePath: path });
      continue;
    }
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) {
      diagnostics.push({
        code: "file-too-large",
        message: `selected Git blob exceeds the inclusive ${config.limits.maxFileBytes}-byte materialization limit`,
        relativePath: path,
      });
      continue;
    }
    // A path the scanner must reject by extension is UX evidence only. Do not extract it or let it
    // consume the accepted Markdown file/byte budgets.
    if (!isMarkdownSourcePath(path)) {
      diagnostics.push({
        code: "not-markdown",
        message: "included path is not a recognized Markdown source",
        relativePath: path,
      });
      continue;
    }
    if (size > config.limits.maxFileBytes) {
      diagnostics.push({
        code: "file-too-large",
        message: `selected Git blob exceeds the inclusive ${config.limits.maxFileBytes}-byte materialization limit`,
        relativePath: path,
      });
      continue;
    }
    if (entries.length >= config.limits.maxFiles) throw new Error("selected Git tree exceeds the materialization file limit");
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > config.limits.maxTotalBytes) throw new Error("selected Git tree exceeds the materialization total-byte limit");
    entries.push({ path, oid: oid!, size, mode: mode! });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  diagnostics.sort((a, b) => Buffer.compare(Buffer.from(a.relativePath ?? ""), Buffer.from(b.relativePath ?? "")));
  return { config, entries, diagnostics };
}

async function streamExactGitBlob(
  spawn: typeof nodeSpawn,
  executable: string,
  timeoutMs: number,
  repository: string,
  entry: TreeEntry,
  target: string,
  deadline: GitMaterializationDeadline,
  beforeMutation: () => void,
): Promise<{ size: number; sha256: string }> {
  beforeMutation();
  const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const hash = createHash("sha256");
  const objectHash = createHash(entry.oid.length === 64 ? "sha256" : "sha1");
  objectHash.update(`blob ${entry.size}\0`);
  let size = 0;
  let failure: Error | null = null;
  try {
    validateManagedGitInvocation(repository);
    const command = deadline.command(timeoutMs);
    const child = spawn(executable, [`--git-dir=${repository}`, "cat-file", "blob", entry.oid], {
      cwd: dirname(repository), env: managedGitEnvironment({ GIT_COMMON_DIR: repository }),
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    if (!child.stdout || !child.stderr) throw new Error("Git blob extraction did not provide bounded pipes");
    const timeout = setTimeout(() => {
      failure = new Error(command.aggregateLimited
        ? "managed git-md materialization deadline exceeded"
        : "Git blob extraction timed out");
      child.kill("SIGKILL");
    }, command.timeoutMs);
    timeout.unref();
    const ownershipMonitor = setInterval(() => {
      if (failure) return;
      try { beforeMutation(); } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        child.kill("SIGKILL");
      }
    }, 10);
    ownershipMonitor.unref();
    // Drain but never reflect repository-controlled stderr into a caller-facing error.
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      try { deadline.check(); } catch (error) {
        failure = error as Error;
        child.kill("SIGKILL");
        return;
      }
      if (size + chunk.length > entry.size) {
        failure = new Error("pinned Git blob exceeded its enumerated size during extraction");
        child.kill("SIGKILL");
        return;
      }
      try {
        let offset = 0;
        while (offset < chunk.length) { beforeMutation(); offset += writeSync(fd, chunk, offset, chunk.length - offset); }
        hash.update(chunk);
        objectHash.update(chunk);
        size += chunk.length;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        child.kill("SIGKILL");
      }
    });
    await new Promise<void>((resolveDone, reject) => {
      child.once("error", (error) => {
        clearTimeout(timeout);
        clearInterval(ownershipMonitor);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        clearInterval(ownershipMonitor);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`managed git-md cat-file failed (${signal ?? code})`));
        else resolveDone();
      });
    });
    if (size !== entry.size) throw new Error("pinned Git blob size changed during extraction");
    if (objectHash.digest("hex") !== entry.oid) throw new Error("pinned Git blob object hash mismatch");
    beforeMutation();
    fsyncSync(fd);
    deadline.check();
    return { size, sha256: hash.digest("hex") };
  } finally { closeSync(fd); }
}

async function materializeGitBlobs(
  spawn: typeof nodeSpawn,
  executable: string,
  timeoutMs: number,
  repository: string,
  destination: string,
  entries: readonly TreeEntry[],
  deadline: GitMaterializationDeadline,
  beforeMutation: () => void,
): Promise<SnapshotMarker["files"]> {
  const files: SnapshotMarker["files"] = [];
  for (const entry of entries) {
    deadline.check();
    const target = resolve(destination, entry.path);
    if (!contained(destination, target)) throw new Error("pinned Git blob extraction escaped destination");
    const parent = dirname(target);
    beforeMutation();
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!contained(destination, realpathSync.native(parent))) throw new Error("pinned Git blob parent escaped destination");
    beforeMutation();
    const streamed = await streamExactGitBlob(spawn, executable, timeoutMs, repository, entry, target, deadline, beforeMutation);
    files.push({ path: entry.path, ...streamed });
  }
  return files;
}

function mergeMaterializationDiagnostics(
  ...groups: readonly (readonly SourceScanDiagnostic[])[]
): SourceScanDiagnostic[] {
  const seen = new Set<string>();
  const merged: SourceScanDiagnostic[] = [];
  for (const diagnostic of groups.flat()) {
    const key = JSON.stringify([diagnostic.code, diagnostic.relativePath ?? null, diagnostic.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(diagnostic);
  }
  return merged;
}

function pruneStagingToAccepted(
  root: string,
  accepted: ReadonlySet<string>,
  beforeMutation: () => void,
  check: () => void,
): void {
  const rootEntry = lstatSync(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error("source staging root is unsafe");
  const walk = (directory: string, relativeDirectory: string): void => {
    check();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      check();
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink() || stats.dev !== rootEntry.dev) throw new Error("source staging tree is unsafe");
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        if (readdirSync(absolutePath).length === 0) {
          beforeMutation();
          rmdirSync(absolutePath);
        }
      } else if (entry.isFile()) {
        if (!accepted.has(relativePath)) {
          beforeMutation();
          rmSync(absolutePath);
        }
      } else {
        throw new Error("source staging tree contains an unsupported node");
      }
    }
  };
  walk(root, "");
}

function canonicalizeStaging(
  tree: string,
  files: readonly SnapshotMarker["files"][number][],
  config: EffectiveSourceScanConfig,
  diagnostics: readonly SourceScanDiagnostic[],
  beforeMutation: () => void,
  check: () => void,
): { files: SnapshotMarker["files"]; diagnostics: SourceScanDiagnostic[]; publishable: boolean } {
  check();
  const scanned = scanSourceSnapshot({ root: tree, config });
  const mergedDiagnostics = mergeMaterializationDiagnostics(diagnostics, scanned.diagnostics);
  if (!scanned.publishable || scanned.status !== "complete") {
    return { files: [], diagnostics: mergedDiagnostics, publishable: false };
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const accepted = new Set<string>();
  for (const file of scanned.files) {
    check();
    const materialized = byPath.get(file.relativePath);
    if (!materialized || materialized.size !== file.byteLength
        || file.contentHash !== `monet-src-content/v1:sha256:${materialized.sha256}`) {
      throw new Error("source scanner accepted path does not match materialized content");
    }
    accepted.add(file.relativePath);
  }
  const acceptedFiles = files.filter((file) => accepted.has(file.path));
  if (acceptedFiles.length !== accepted.size) throw new Error("source scanner accepted an unmaterialized path");
  pruneStagingToAccepted(tree, accepted, beforeMutation, check);
  return { files: acceptedFiles, diagnostics: mergedDiagnostics, publishable: true };
}

interface FrozenStagingLeaf { path: string; dev: number; ino: number }

function freezeStagingLeaf(path: string, label: string): FrozenStagingLeaf {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error(`${label} is not a safe regular file`);
  return { path, dev: entry.dev, ino: entry.ino };
}

function removeFrozenStagingLeaf(
  frozen: FrozenStagingLeaf, label: string, beforeMutation: () => void, check: () => void,
): void {
  check();
  const current = lstatSync(frozen.path);
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
      || current.dev !== frozen.dev || current.ino !== frozen.ino) throw new Error(`${label} changed after preflight`);
  beforeMutation();
  rmSync(frozen.path);
}

function sweepOwnedMaterializationStaging(
  sourceType: "repo-md" | "git-md",
  root: string,
  snapshotsPath: string,
  frozenSnapshots: FrozenSnapshotsDirectory,
  beforeMutation: () => void,
  safeTreeOps: SafeTreeOps,
  check: () => void,
): void {
  const variant = "[0-9a-f]{40,64}-[0-9a-f]{64}";
  const temporaryTree = new RegExp(`^\\.tree-${variant}-[A-Za-z0-9][A-Za-z0-9-]{0,127}$`);
  const temporarySidecar = new RegExp(`^\\.complete-${variant}-[A-Za-z0-9][A-Za-z0-9-]{0,127}\\.json$`);
  const finalTree = new RegExp(`^${variant}$`);
  const finalSidecar = new RegExp(`^${variant}\\.complete\\.json$`);
  const materialize = /^\.materialize-[0-9a-f]{40,64}-[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
  const trees: FrozenSameDeviceTree[] = [];
  const leaves: FrozenStagingLeaf[] = [];

  // Exhaustively classify and freeze before the first mutation. Prefix
  // collisions are ambiguous, so they fail closed and leave every artifact.
  const snapshotEntries = readdirSync(snapshotsPath, { withFileTypes: true });
  check();
  for (const entry of snapshotEntries) {
    check();
    const path = join(snapshotsPath, entry.name);
    if (temporaryTree.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("managed source temporary tree is unsafe");
      trees.push(freezeSameDeviceTree(path, "managed source temporary tree", safeTreeOps, check));
    } else if (temporarySidecar.test(entry.name)) {
      leaves.push(freezeStagingLeaf(path, "managed source temporary completion sidecar"));
    } else if (entry.name.startsWith(".tree-") || entry.name.startsWith(".complete-")) {
      throw new Error("managed source staging artifact ownership is ambiguous");
    } else if (finalTree.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("managed source sealed variant is unsafe");
    } else if (finalSidecar.test(entry.name)) {
      freezeStagingLeaf(path, "managed source sealed completion sidecar");
    } else {
      throw new Error(`unrecognized node in managed source snapshots: ${entry.name}`);
    }
  }
  const rootEntries = readdirSync(root, { withFileTypes: true });
  check();
  for (const entry of rootEntries) {
    check();
    const path = join(root, entry.name);
    if (entry.name === "snapshots") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("managed source snapshots root is unsafe");
    } else if (entry.name === "repository.git" && sourceType === "git-md") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("managed git-md repository is unsafe");
    } else if (entry.name === "current" || /^\.current-[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(entry.name)) {
      if (!entry.isSymbolicLink()) throw new Error("managed source current pointer is unsafe");
    } else if (materialize.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("managed source materialization staging tree is unsafe");
      trees.push(freezeSameDeviceTree(path, "managed source materialization staging tree", safeTreeOps, check));
    } else if (entry.name.startsWith(".materialize-")) {
      throw new Error("managed source materialization artifact ownership is ambiguous");
    } else {
      throw new Error(`unrecognized node in managed source root: ${entry.name}`);
    }
  }
  revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
  for (const tree of trees) revalidateSameDeviceTree(tree, "managed source staging tree", safeTreeOps, check);
  for (const tree of trees) {
    revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
    removeFrozenSameDeviceTree(tree, "managed source staging tree", beforeMutation,
      { writable: true, ops: safeTreeOps, check });
  }
  for (const leaf of leaves) {
    revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
    removeFrozenStagingLeaf(leaf, "managed source staging sidecar", beforeMutation, check);
  }
}

/**
 * BLOCKER 5a: tree-level-only mirror of planManifest's protectingSkipPath carry decision
 * (source-sync.ts), restricted to what is knowable at THIS point — the prior published file list
 * and this run's own tree-level (materializer) diagnostics. Scanner diagnostics do not exist yet
 * here (the scanner has not run), so a scanner-only-diagnosed carry is deliberately out of scope:
 * its bytes are already present via normal materialization (the file WAS selected and read fine at
 * this level), so pre-seal carry-forward has nothing to do for it. A path carries here only if it
 * was previously published, is not selected this run, and is exact-matched or nested under a
 * directory-shaped diagnostic this run — mirroring planManifest's protectingSkipPath carry
 * sources (cases a/b), kept in lockstep and verified by cross-check regression tests for those
 * shapes. planManifest has a THIRD carry source this mirror
 * structurally cannot produce — case (c), a rename whose DESTINATION is tree-level diagnosed
 * this run (carried under a NEW path that is by definition not in priorFiles; keyed off
 * movedToFrom, not protectingSkipPath). For that shape the manifest carries bytes this snapshot
 * never receives; the pre-activation ledger parity gate rejects the candidate and preserves the
 * previous publication.
 */
function treeLevelCarryCandidates(
  priorFiles: ReadonlyArray<{ relativePath: string }>,
  selectedPaths: ReadonlySet<string>,
  diagnostics: readonly SourceScanDiagnostic[],
  config: Pick<EffectiveSourceScanConfig, "include" | "exclude">,
): string[] {
  const diagnosedPaths = new Set(
    diagnostics.map((diagnostic) => diagnostic.relativePath).filter((path): path is string => path !== undefined),
  );
  const protectingDiagnosedPath = (path: string): string | undefined =>
    [...diagnosedPaths].find((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  // CODEX FIX (3606534107): a carry candidate must still be selected by the CURRENT effective
  // include/exclude config — mirrors the identical fix in planManifest's carrySources
  // (source-sync.ts). Without this, a config change that newly excludes a descendant of a
  // diagnosed subtree gets silently overridden by pre-seal carry-forward, so the exclusion is
  // never enforced (its bytes keep reappearing in every newly sealed snapshot) until the subtree
  // heals.
  const isCurrentlySelected = (path: string): boolean =>
    config.include.some((pattern) => matchesSourceGlob(pattern, path))
    && !config.exclude.some((pattern) => matchesSourceGlob(pattern, path));
  return priorFiles
    .map((file) => file.relativePath)
    .filter((path) => !selectedPaths.has(path) && protectingDiagnosedPath(path) !== undefined && isCurrentlySelected(path))
    .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
}

/**
 * Copies each candidate's bytes from the PRIOR sealed snapshot into the staging `tree` about to be
 * sealed as the new one, returning marker-ready file entries for the ones that succeeded and the
 * paths that could not be carried (prior snapshot missing/corrupt, or the specific path absent
 * from it — never thrown; see RepoMdMaterialization.carryForwardUnavailable).
 */
async function carryForwardPriorFiles(
  candidates: readonly string[],
  priorPublication: { snapshotId: string; ingestConfigHash: string },
  snapshotsPath: string,
  tree: string,
  deadline: GitMaterializationDeadline | undefined,
  beforeMutation: () => void,
  check: () => void,
): Promise<{ files: SnapshotMarker["files"]; unavailable: string[] }> {
  if (candidates.length === 0) return { files: [], unavailable: [] };
  const priorVariant = variantName(priorPublication.snapshotId, priorPublication.ingestConfigHash);
  const priorSnapshotPath = join(snapshotsPath, priorVariant);
  const priorSidecarPath = `${priorSnapshotPath}.complete.json`;
  let priorMarker: SnapshotMarker;
  try {
    // Full validation, not just a stat: every prior file's hash is re-verified against its own
    // marker, exactly as a cache-reuse hit would. Corruption anywhere in the prior snapshot must
    // be caught here, not silently propagated into what this run seals as fresh truth.
    priorMarker = validateSealedSnapshot(priorSnapshotPath, priorSidecarPath, priorPublication.snapshotId, priorPublication.ingestConfigHash, check);
  } catch {
    return { files: [], unavailable: [...candidates] };
  }
  const priorByPath = new Map(priorMarker.files.map((file) => [file.path, file]));
  const files: SnapshotMarker["files"] = [];
  const unavailable: string[] = [];
  for (const path of candidates) {
    deadline?.check();
    check();
    let validated: string;
    try { validated = validateArchivePath(path); } catch { unavailable.push(path); continue; }
    const priorFile = priorByPath.get(validated);
    if (!priorFile) { unavailable.push(path); continue; }
    const sourcePath = join(priorSnapshotPath, validated);
    const target = join(tree, validated);
    if (!contained(priorSnapshotPath, sourcePath) || !contained(tree, target)) { unavailable.push(path); continue; }
    let bytes: Buffer;
    try { bytes = readFileSync(sourcePath); } catch { unavailable.push(path); continue; }
    // Re-hash on the way out rather than trust the (already-validated) prior marker a second time
    // silently — matches the paranoia of materializeGitBlobs/extractGitArchive immediately below,
    // which never trust a size/hash claim without independently reproducing it.
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== priorFile.size || sha256 !== priorFile.sha256) { unavailable.push(path); continue; }
    beforeMutation();
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    beforeMutation();
    writeFileSync(target, bytes, { mode: priorFile.mode === "100755" ? 0o700 : 0o600 });
    files.push({ path: validated, size: priorFile.size, sha256: priorFile.sha256, ...(priorFile.mode ? { mode: priorFile.mode } : {}) });
  }
  return { files, unavailable };
}

async function materializeRepoMdCommitAtRoot(
  source: KnowledgeSource,
  snapshotId: string,
  top: string,
  options: RepoMdMaterializerOptions,
  execFile: typeof nodeExecFile,
): Promise<RepoMdMaterialization> {
  const beforeMutation = options.assertOwnership ?? (() => undefined);
  const deadline = source.type === "git-md"
    ? gitMaterializationDeadline(options.materializationDeadlineMs, options.monotonicNow)
    : undefined;
  const check = deadline?.check ?? (() => undefined);
  const safeTreeOps = options.safeTreeOps ?? {};
  check();
  beforeMutation();
  const root = typedSourceRoot(source.type, source.id, options.sourceStorageDir, true, beforeMutation, safeTreeOps)!;
  const desiredConfig = options.config ?? effectiveSourceScanConfig({ autoDetect: source.autoDetect, include: source.include, exclude: source.exclude });
  const desiredConfigHash = computeSourceIngestConfigHash(desiredConfig);
  if (options.activePublication
      && (options.activePublication.sourceId !== source.id
        || options.activePublication.runId !== source.activeRunId
        || options.activePublication.snapshotId !== source.activeSnapshotId)) {
    throw new Error("materializer active publication does not match the source active tuple");
  }
  const frozenSnapshots = freezeSnapshotsDirectory(root, true, beforeMutation, safeTreeOps)!;
  revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
  const snapshotsPath = frozenSnapshots.snapshots.path;
  const snapshotPath = join(snapshotsPath, variantName(snapshotId, desiredConfigHash));
  const sidecarPath = `${snapshotPath}.complete.json`;
  const variant = variantName(snapshotId, desiredConfigHash);
  revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
  sweepOwnedMaterializationStaging(source.type, root, snapshotsPath, frozenSnapshots, beforeMutation, safeTreeOps, check);
  const exactActiveVariant = source.activeSnapshotId === snapshotId
    && source.activeIngestConfigHash === desiredConfigHash;
  if (exactActiveVariant) {
    const publication = options.activePublication;
    if (!publication) throw new Error("exact active source materialization requires its durable publication manifest");
    validateSealedSnapshotAgainstLedger(
      snapshotPath, sidecarPath, snapshotId, desiredConfigHash, publication, check,
    );
    durableSnapshotParents(options, root, beforeMutation);
    return {
      snapshotId, configHash: desiredConfigHash, snapshotPath, currentPath: join(root, "current"), repositoryRoot: top,
      diagnostics: [], carryForwardUnavailable: [],
    };
  }
  const treeExists = pathEntryExists(snapshotPath);
  const sidecarExists = pathEntryExists(sidecarPath);
  // A non-active candidate has no durable ledger proof. Treat it as disposable whether it is
  // incomplete or apparently sealed; retry rebuilds it from the immutable source commit.
  if (treeExists || sidecarExists) {
    revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
    if (treeExists) {
      removeManagedTree(snapshotPath, "incomplete managed source snapshot",
        () => { beforeMutation(); revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps); }, safeTreeOps, check);
    }
    if (sidecarExists) { revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps); beforeMutation(); rmSync(sidecarPath, { force: true }); }
  }
  const localGit = source.type === "git-md" ? {
    timeoutMs: boundedLocalGitTimeout(options.localGitTimeoutMs),
    executable: resolvePinnedGitExecutable(options.gitExecutable),
  } : undefined;
  if (source.type === "git-md") {
    deadline!.check();
    const registered = realpathSync.native(source.localPath);
    if (registered !== source.localPath || dirname(registered) !== root) throw new Error("registered git-md repository escapes its managed source root");
    if (lstatSync(registered).dev !== lstatSync(root).dev) throw new Error("registered git-md repository crosses a filesystem boundary");
    validateManagedGitRepository(registered, deadline!.check);
    deadline!.check();
    await runGitBeforeDeadline(execFile, [`--git-dir=${registered}`, "fsck", "--strict", "--full", "--no-reflogs", snapshotId],
      dirname(registered), 16 * 1024 * 1024, localGit!, deadline!, beforeMutation);
    validateManagedGitInvocation(registered);
    const bare = await runGitBeforeDeadline(execFile, ["rev-parse", "--is-bare-repository"], registered, undefined, localGit!, deadline!, beforeMutation);
    if (bare !== "true") throw new Error("registered git-md repository is not bare");
    validateManagedGitInvocation(registered);
    const verified = (await runGitBeforeDeadline(execFile, ["rev-parse", "--verify", `${snapshotId}^{commit}`],
      registered, undefined, localGit!, deadline!, beforeMutation)).toLowerCase();
    if (verified !== snapshotId) throw new Error("pinned git-md commit is unavailable or changed");
    top = registered;
  }
  const { config, entries, diagnostics } = await enumerateSelectedTree(source, snapshotId, top, { ...options, config: desiredConfig }, execFile, localGit, deadline);
  let totalBytes = 0;
  let pathArgBytes = 0;
  for (const entry of entries) {
    check();
    totalBytes += entry.size;
    pathArgBytes += Buffer.byteLength(entry.path) + 1;
  }
  const maxArchiveBytes = options.maxArchiveBytes ?? Math.min(
    Number.MAX_SAFE_INTEGER,
    totalBytes + entries.length * 4096 + 2 * 1024 * 1024,
  );
  if (source.type === "repo-md" && pathArgBytes > 512 * 1024) throw new Error("selected Git paths exceed the bounded archive argument limit");
  if (source.type === "git-md" && totalBytes > maxArchiveBytes) throw new Error("selected Git blobs exceed the materialization byte limit");
  const token = requireArtifactToken((options.token ?? randomUUID)());
  const temporary = source.type === "repo-md" ? join(root, `.materialize-${snapshotId}-${token}`) : null;
  // macOS refuses to move a non-writable directory between parents; stage beside the
  // final variant so the already-sealed root can still be atomically renamed in place.
  const tree = join(snapshotsPath, `.tree-${variant}-${token}`);
  const archive = temporary ? join(temporary, "archive.tar") : null;
  const temporarySidecar = join(snapshotsPath, `.complete-${variant}-${token}.json`);
  revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
  beforeMutation();
  if (temporary) mkdirSync(temporary, { mode: 0o700 });
  revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
  beforeMutation();
  mkdirSync(tree, { mode: 0o700 });
  try {
    // BLOCKER 5a: pre-seal carry-forward, computed and attempted BEFORE any fresh entry is
    // materialized or anything is sealed. If any candidate can't be safely carried, bail out here
    // — before archiving/blob-extracting the fresh entries, and definitely before sealSnapshot —
    // so an incomplete snapshot is never sealed and never becomes a future cache-reuse hit that
    // silently reports itself complete. The finally block below still cleans up this staging tree.
    const carryCandidates = options.activePublication
      ? treeLevelCarryCandidates(options.activePublication.files, new Set(entries.map((entry) => entry.path)), diagnostics, config)
      : [];
    const carried = carryCandidates.length > 0
      ? await carryForwardPriorFiles(
          carryCandidates, options.activePublication!, snapshotsPath, tree, deadline,
          () => { beforeMutation(); revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps); }, check,
        )
      : { files: [] as SnapshotMarker["files"], unavailable: [] as string[] };
    if (carried.unavailable.length > 0) {
      return {
        snapshotId, configHash: desiredConfigHash, snapshotPath, currentPath: join(root, "current"), repositoryRoot: top,
        diagnostics, carryForwardUnavailable: carried.unavailable,
      };
    }
    let files: SnapshotMarker["files"] = [...carried.files];
    if (entries.length > 0) {
      if (source.type === "git-md") files = [...files, ...(await materializeGitBlobs(
        options.spawn ?? nodeSpawn, localGit!.executable, localGit!.timeoutMs, top, tree, entries, deadline!,
        () => { beforeMutation(); revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps); },
      )).map((file, index) => ({ ...file, mode: entries[index]!.mode as "100644" | "100755" }))];
      else {
        await runGit(execFile, ["--literal-pathspecs", "archive", "--format=tar", `--output=${archive!}`, snapshotId, "--", ...entries.map((entry) => entry.path)], top);
        if (statSync(archive!).size > maxArchiveBytes) throw new Error("git archive exceeds the materialization byte limit");
        files = [...files, ...extractGitArchive(archive!, tree, entries, maxArchiveBytes, beforeMutation)];
      }
      options.fault?.("after-archive");
    }
    // CODEX FIX (3606534097), John's ruling "A" (shared classifier, extract-and-share): a
    // previously-published path that's STILL Git-selected this run — so it materialized normally,
    // above, with FRESH bytes — but whose fresh content would fail the scanner (invalid UTF-8 or
    // frontmatter) is the case pre-seal carry-forward above structurally cannot cover, since that
    // logic only ever considers paths ABSENT from entries. Classify the small set of previously-
    // published + currently-selected files' just-written fresh bytes with the SAME shared
    // classifier the scanner itself now uses (source-chunker.ts), and on failure, substitute the
    // prior sealed snapshot's bytes for that path — reusing carryForwardPriorFiles exactly as
    // above, including its identical graceful-degradation-on-unavailable-prior semantics.
    // Deliberately excludes chunk-budget-exceeded (walk-order-dependent, not a pure function of
    // this file's bytes alone) — see the residual handling in syncSource (source-sync.ts).
    const classifyCandidates = options.activePublication
      ? entries.filter((entry) => options.activePublication!.files.some((file) => file.relativePath === entry.path))
      : [];
    const substitutePaths: string[] = [];
    // Recorded for audit visibility (source_skipped_files) even though — see below — the scanner
    // will read valid (substituted) bytes at this path and never itself notice anything was wrong.
    // Without this, the substitution would be functionally correct but completely silent: no
    // record anywhere that this run's fresh content at this path was rejected and replaced.
    const substitutionDiagnostics: SourceScanDiagnostic[] = [];
    for (const entry of classifyCandidates) {
      deadline?.check();
      check();
      const freshBytes = readFileSync(join(tree, entry.path));
      const classified = classifySourceFileContent(freshBytes, entry.path);
      if (classified.diagnostic) {
        substitutePaths.push(entry.path);
        substitutionDiagnostics.push(classified.diagnostic);
      }
    }
    const substituted = substitutePaths.length > 0
      ? await carryForwardPriorFiles(
          substitutePaths, options.activePublication!, snapshotsPath, tree, deadline,
          () => { beforeMutation(); revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps); }, check,
        )
      : { files: [] as SnapshotMarker["files"], unavailable: [] as string[] };
    // From here on, prefer allDiagnostics (original tree-level diagnostics + this run's
    // classifier-substitution audit records) over the original `diagnostics` binding.
    const allDiagnostics = substitutionDiagnostics.length > 0 ? [...diagnostics, ...substitutionDiagnostics] : diagnostics;
    if (substituted.unavailable.length > 0) {
      return {
        snapshotId, configHash: desiredConfigHash, snapshotPath, currentPath: join(root, "current"), repositoryRoot: top,
        diagnostics: allDiagnostics, carryForwardUnavailable: [...carried.unavailable, ...substituted.unavailable],
      };
    }
    if (substituted.files.length > 0) {
      // carryForwardPriorFiles already overwrote these paths' bytes in `tree` with the prior
      // content; the marker's file entries (size/sha256/mode) must agree with what's now actually
      // on disk, replacing the fresh (rejected) entries materializeGitBlobs/extractGitArchive wrote
      // moments ago.
      const substitutedByPath = new Map(substituted.files.map((file) => [file.path, file]));
      files = files.map((file) => substitutedByPath.get(file.path) ?? file);
    }
    const canonical = canonicalizeStaging(
      tree, files, config, allDiagnostics,
      () => { beforeMutation(); revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps); }, check,
    );
    if (!canonical.publishable) {
      return {
        snapshotId, configHash: desiredConfigHash, snapshotPath, currentPath: join(root, "current"), repositoryRoot: top,
        diagnostics: canonical.diagnostics, preSealStatus: "partial", carryForwardUnavailable: [],
      };
    }
    files = canonical.files;
    const marker: SnapshotMarker = {
      version: 2, snapshotId, configHash: computeSourceIngestConfigHash(config),
      variant: variantName(snapshotId, desiredConfigHash), files,
    };
    const markerBytes = Buffer.from(JSON.stringify(marker), "utf8");
    if (markerBytes.length > MAX_SNAPSHOT_MARKER_BYTES) {
      throw new Error("accepted source snapshot marker exceeds its byte limit");
    }
    deadline?.check();
    sealSnapshot(tree, () => { beforeMutation(); revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps); }, safeTreeOps, check);
    deadline?.check();
    options.fault?.("before-snapshot-rename");
    revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
    beforeMutation();
    renameSync(tree, snapshotPath);
    beforeMutation();
    fsyncPath(snapshotsPath);
    options.fault?.("after-snapshot-rename");
    revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
    beforeMutation();
    const sidecarFd = openSync(temporarySidecar, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      beforeMutation();
      writeSync(sidecarFd, markerBytes);
      beforeMutation();
      chmodSync(temporarySidecar, 0o400);
      beforeMutation();
      fsyncSync(sidecarFd);
    } finally { closeSync(sidecarFd); }
    options.fault?.("before-sidecar-rename");
    revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
    beforeMutation();
    renameSync(temporarySidecar, sidecarPath);
    beforeMutation();
    fsyncPath(snapshotsPath);
    options.fault?.("after-sidecar-rename");
    validateSealedSnapshot(snapshotPath, sidecarPath, snapshotId, desiredConfigHash, check);
    deadline?.check();
    durableSnapshotParents(options, root, beforeMutation);
    return {
      snapshotId, configHash: desiredConfigHash, snapshotPath, currentPath: join(root, "current"), repositoryRoot: top,
      diagnostics: canonical.diagnostics, carryForwardUnavailable: [],
    };
  } finally {
    revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
    removeManagedTree(tree, "managed source temporary snapshot",
      () => { beforeMutation(); revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps); }, safeTreeOps);
    if (temporary) removeManagedTree(temporary, "managed source materialization staging",
      () => { beforeMutation(); revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps); }, safeTreeOps);
    revalidateSnapshotsDirectory(frozenSnapshots, safeTreeOps);
    beforeMutation();
    rmSync(temporarySidecar, { force: true });
  }
}
