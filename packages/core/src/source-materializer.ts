import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { computeSourceIngestConfigHash, effectiveSourceScanConfig, matchesSourceGlob } from "./source-scanner";
import type { EffectiveSourceScanConfig } from "./source-scanner";
import type { KnowledgeSource } from "./source-types";

const OID_RE = /^[0-9a-f]{40,64}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const CONFIG_HASH_RE = /^monet-src-ingest-config\/v1:sha256:[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const IO_CHUNK = 64 * 1024;
/** Rename evidence is advisory and deliberately much smaller than tree materialization output. */
const MAX_RENAME_DIFF_BYTES = 1024 * 1024;
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
  fault?: (point: RepoMdMaterializerFaultPoint) => void;
}

export interface RepoMdMaterialization {
  snapshotId: string;
  configHash: string;
  snapshotPath: string;
  currentPath: string;
  repositoryRoot: string;
}

interface TreeEntry { path: string; oid: string; size: number; mode: string }
interface SnapshotMarker {
  version: 2;
  snapshotId: string;
  configHash: string;
  variant: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

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

function realDirectory(path: string, label: string, create: boolean): string | null {
  let entry;
  try { entry = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try { mkdirSync(path, { mode: 0o700 }); } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    entry = lstatSync(path);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
  return realpathSync.native(path);
}

function managedRepoRoot(storageDir: string, create = true): string | null {
  const configuredBase = resolve(storageDir);
  if (create) mkdirSync(configuredBase, { recursive: true, mode: 0o700 });
  const base = realDirectory(configuredBase, "managed source storage base", false);
  if (base === null) return null;
  const repoPath = join(base, "repo-md");
  const repo = realDirectory(repoPath, "managed repo-md root", create);
  if (repo === null) return null;
  if (repo !== join(base, "repo-md") || !contained(base, repo)) throw new Error("managed repo-md root canonical path mismatch");
  return repo;
}

function sourceRoot(sourceId: string, storageDir: string, create = true): string | null {
  requireSourceId(sourceId);
  const repo = managedRepoRoot(storageDir, create);
  if (repo === null) return null;
  const expected = join(repo, sourceId);
  const source = realDirectory(expected, "managed repo-md source root", create);
  if (source !== null && (source !== expected || dirname(source) !== repo || relative(repo, source) !== sourceId)) {
    throw new Error("managed repo-md source root canonical path mismatch");
  }
  return source;
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
        mkdirSync(target, { recursive: true, mode: 0o700 });
      } else if (type === "0") {
        const entry = expected.get(archivePath);
        if (enforceExpected && (!entry || entry.size !== size)) throw new Error("git archive contains an unexpected or size-mismatched file");
        if (extracted.has(archivePath)) throw new Error("git archive contains a duplicate file");
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const output = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        const hash = createHash("sha256");
        let consumed = 0;
        try {
          while (consumed < size) {
            const length = Math.min(IO_CHUNK, size - consumed);
            const chunk = readExactly(fd, dataStart + consumed, length);
            writeSync(output, chunk);
            hash.update(chunk);
            consumed += length;
          }
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

async function runGit(execFile: typeof nodeExecFile, args: string[], cwd: string, maxBuffer = 4 * 1024 * 1024): Promise<string> {
  const result = await promisify(execFile)("git", args, { cwd, encoding: "utf8", maxBuffer });
  const stdout = typeof result === "object" && result !== null && "stdout" in result ? result.stdout : result;
  return String(stdout).trim();
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
  options: { execFile?: typeof nodeExecFile; maxOutputBytes?: number } = {},
): Promise<Map<string, string>> {
  if (!OID_RE.test(priorSnapshotId) || !OID_RE.test(nextSnapshotId)) return new Map();
  const maxBuffer = options.maxOutputBytes ?? MAX_RENAME_DIFF_BYTES;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > MAX_RENAME_DIFF_BYTES) return new Map();
  const execFile = options.execFile ?? nodeExecFile;
  let output: Buffer;
  try {
    output = await new Promise<Buffer>((resolveOutput, reject) => {
      execFile("git", [
        "--no-pager", "diff", "--no-ext-diff", "--name-status", "-z",
        "--no-textconv", `--find-renames=${REPO_MD_RENAME_SIMILARITY}%`, `-l${REPO_MD_RENAME_LIMIT}`,
        priorSnapshotId, nextSnapshotId, "--",
      ], { cwd: repositoryRoot, encoding: null, maxBuffer }, (error, stdout) => {
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
  work: () => Promise<T>,
): Promise<T> {
  const now = options.now ?? Date.now;
  const token = (options.token ?? randomUUID)();
  const staleMs = options.lockStaleMs ?? 5 * 60_000;
  requireSourceId(sourceId);
  const repo = managedRepoRoot(options.sourceStorageDir)!;
  // Validate an existing source root before even acquiring its sibling lock.
  sourceRoot(sourceId, options.sourceStorageDir, false);
  // The lock is a sibling of the source root so removal can quarantine the whole root atomically.
  const lock = join(repo, `.lock-${sourceId}`);
  const validateLock = (): void => {
    const entry = lstatSync(lock);
    const canonical = realpathSync.native(lock);
    if (!entry.isDirectory() || entry.isSymbolicLink() || canonical !== lock || dirname(canonical) !== repo) {
      throw new Error("repo-md materializer lock is not a real managed directory");
    }
  };
  const writeOwner = (): void => {
    const temporary = join(lock, `.owner-${token}`);
    writeFileSync(temporary, JSON.stringify({ token, heartbeatAt: now(), pid: process.pid, host: hostname() }), { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(lock, "owner.json"));
  };
  const acquire = (): void => {
    try { mkdirSync(lock, { mode: 0o700 }); validateLock(); writeOwner(); return; } catch {
      validateLock();
      const owner = lockOwner(lock);
      const heartbeat = owner?.heartbeatAt ?? lstatSync(lock).mtimeMs;
      if ((owner && processIsLive(owner)) || now() - heartbeat <= staleMs) throw new Error("repo-md source materializer is locked");
      const stale = `${lock}.stale-${token}`;
      try { renameSync(lock, stale); } catch { throw new Error("repo-md source materializer lock changed during stale takeover"); }
      rmSync(stale, { recursive: true, force: true });
      mkdirSync(lock, { mode: 0o700 });
      writeOwner();
    }
  };
  acquire();
  let lostOwnership: Error | null = null;
  const heartbeat = setInterval(() => {
    try {
      if (lockOwner(lock)?.token !== token) throw new Error("repo-md materializer lock ownership was lost");
      writeOwner();
    } catch (error) { lostOwnership = error instanceof Error ? error : new Error(String(error)); }
  }, Math.max(10, Math.floor(staleMs / 3)));
  heartbeat.unref();
  try {
    options.fault?.("after-lock");
    const result = await work();
    if (lostOwnership) throw lostOwnership;
    return result;
  } finally {
    clearInterval(heartbeat);
    if (lockOwner(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
  }
}

function variantName(snapshotId: string, configHash: string): string {
  if (!OID_RE.test(snapshotId)) throw new Error("invalid committed snapshot OID");
  if (!CONFIG_HASH_RE.test(configHash)) throw new Error("invalid effective ingest-config hash");
  return `${snapshotId}-${configHash.slice(-64)}`;
}

export function repoMdSnapshotPath(sourceId: string, snapshotId: string, configHash: string, sourceStorageDir: string): string {
  return join(sourceRoot(sourceId, sourceStorageDir)!, "snapshots", variantName(snapshotId, configHash));
}

function repoMdSnapshotSidecarPath(sourceId: string, snapshotId: string, configHash: string, sourceStorageDir: string): string {
  return `${repoMdSnapshotPath(sourceId, snapshotId, configHash, sourceStorageDir)}.complete.json`;
}

function hashFile(path: string): { size: number; sha256: string } {
  const fd = openSync(path, constants.O_RDONLY);
  const hash = createHash("sha256");
  let size = 0;
  const buffer = Buffer.alloc(IO_CHUNK);
  try {
    for (;;) {
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

function validateSealedSnapshot(snapshotPath: string, sidecarPath: string, snapshotId: string, configHash: string): SnapshotMarker {
  const root = lstatSync(snapshotPath);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o222) !== 0) throw new Error("existing source snapshot is not a sealed Monet directory");
  const sidecar = lstatSync(sidecarPath);
  if (!sidecar.isFile() || sidecar.isSymbolicLink() || (sidecar.mode & 0o222) !== 0) {
    throw new Error("existing source snapshot completion sidecar is not sealed");
  }
  const marker = JSON.parse(readFileSync(sidecarPath, "utf8")) as SnapshotMarker;
  if (marker.version !== 2 || marker.snapshotId !== snapshotId || marker.configHash !== configHash
      || marker.variant !== variantName(snapshotId, configHash) || !Array.isArray(marker.files)) {
    throw new Error("existing source snapshot marker does not match its OID/configuration");
  }
  const expected = new Map<string, SnapshotMarker["files"][number]>();
  const expectedDirectories = new Set<string>();
  for (const file of marker.files) {
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
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const rel = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink() || (stats.mode & 0o222) !== 0) throw new Error("existing source snapshot is not sealed");
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(rel)) throw new Error("existing source snapshot contains an unexpected directory");
        walk(absolute, rel);
      }
      else if (entry.isFile()) {
        const wanted = expected.get(rel);
        const actual = hashFile(absolute);
        if (!wanted || wanted.size !== actual.size || wanted.sha256 !== actual.sha256) throw new Error("existing source snapshot content was tampered");
        expected.delete(rel);
      } else if (!entry.isFile()) throw new Error("existing source snapshot contains an unsupported node");
    }
  };
  walk(snapshotPath, "");
  if (expected.size !== 0) throw new Error("existing source snapshot is incomplete");
  return marker;
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

function sealSnapshot(tree: string): void {
  const seal = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) seal(absolute);
      else { chmodSync(absolute, 0o400); fsyncPath(absolute); }
    }
    chmodSync(directory, 0o500);
    fsyncPath(directory);
  };
  seal(tree);
}

function makeTreeWritable(path: string): void {
  try {
    const stats = lstatSync(path);
    // Unlink permission comes from the parent directory. Never chmod leaves: a regular
    // file may be a hardlink whose inode/mode is shared with data outside managed storage.
    if (stats.isSymbolicLink() || !stats.isDirectory()) return;
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) makeTreeWritable(join(path, entry));
  } catch { /* cleanup is best-effort and scoped only to the unique temporary path */ }
}

export function pointRepoMdCurrent(
  sourceId: string,
  snapshotId: string,
  configHash: string,
  options: RepoMdMaterializerOptions,
): string {
  const root = sourceRoot(sourceId, options.sourceStorageDir);
  const snapshot = repoMdSnapshotPath(sourceId, snapshotId, configHash, options.sourceStorageDir);
  const sidecar = repoMdSnapshotSidecarPath(sourceId, snapshotId, configHash, options.sourceStorageDir);
  validateSealedSnapshot(snapshot, sidecar, snapshotId, configHash);
  const current = join(root!, "current");
  const temporary = join(root!, `.current-${(options.token ?? randomUUID)()}`);
  options.fault?.("before-current-swap");
  symlinkSync(relative(root!, snapshot), temporary, "dir");
  try { renameSync(temporary, current); } catch (error) { rmSync(temporary, { force: true }); throw error; }
  options.fault?.("after-current-swap");
  return current;
}

export function revokeRepoMdCurrent(sourceId: string, sourceStorageDir: string): void {
  const root = sourceRoot(sourceId, sourceStorageDir, false);
  if (!root) return;
  const current = join(root, "current");
  try {
    const entry = lstatSync(current);
    if (!entry.isSymbolicLink()) throw new Error("managed repo-md current pointer is not a symlink");
    rmSync(current);
    fsyncPath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Remove only recognizable Monet-owned artifacts beneath the hashed source storage root. */
export function removeRepoMdMaterializations(sourceId: string, sourceStorageDir: string): void {
  requireSourceId(sourceId);
  const repo = managedRepoRoot(sourceStorageDir)!;
  const quarantinePattern = new RegExp(`^\\.remove-${sourceId}-[A-Za-z0-9-]+$`);
  const quarantines = readdirSync(repo).filter((name) => quarantinePattern.test(name));
  if (quarantines.length > 1) throw new Error("multiple managed repo-md removal quarantines exist");
  let quarantine = quarantines[0] ? join(repo, quarantines[0]) : null;
  const root = sourceRoot(sourceId, sourceStorageDir, false);
  if (root && quarantine) throw new Error("managed repo-md source root and removal quarantine both exist");
  if (root) {
    revokeRepoMdCurrent(sourceId, sourceStorageDir);
    quarantine = join(repo, `.remove-${sourceId}-${randomUUID()}`);
    renameSync(root, quarantine);
    fsyncPath(repo);
  }
  if (!quarantine) return;
  const quarantineEntry = lstatSync(quarantine);
  const canonicalQuarantine = realpathSync.native(quarantine);
  if (!quarantineEntry.isDirectory() || quarantineEntry.isSymbolicLink() || dirname(canonicalQuarantine) !== repo
      || canonicalQuarantine !== quarantine) throw new Error("managed repo-md removal quarantine is not a real direct child");
  const removalRoot = quarantine;
  const variant = "[0-9a-f]{40,64}-[0-9a-f]{64}";
  const finalTree = new RegExp(`^${variant}$`);
  const finalSidecar = new RegExp(`^${variant}\\.complete\\.json$`);
  const temporaryTree = new RegExp(`^\\.tree-${variant}-[A-Za-z0-9-]+$`);
  const temporarySidecar = new RegExp(`^\\.complete-${variant}-[A-Za-z0-9-]+\\.json$`);
  const snapshots = join(removalRoot, "snapshots");
  try {
    const snapshotsEntry = lstatSync(snapshots);
    if (!snapshotsEntry.isDirectory() || snapshotsEntry.isSymbolicLink()) {
      throw new Error("managed repo-md snapshots root is not a real directory");
    }
    for (const entry of readdirSync(snapshots, { withFileTypes: true })) {
      const recognizedTree = finalTree.test(entry.name) || temporaryTree.test(entry.name);
      const recognizedSidecar = finalSidecar.test(entry.name) || temporarySidecar.test(entry.name);
      if ((!recognizedTree && !recognizedSidecar) || (recognizedTree && !entry.isDirectory() && !entry.isSymbolicLink())
          || (recognizedSidecar && !entry.isFile() && !entry.isSymbolicLink())) {
        throw new Error(`unrecognized node in managed repo-md snapshots: ${entry.name}`);
      }
      const path = join(snapshots, entry.name);
      if (entry.isDirectory()) makeTreeWritable(path);
      rmSync(path, { recursive: entry.isDirectory(), force: true });
    }
    rmSync(snapshots, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    for (const entry of readdirSync(removalRoot, { withFileTypes: true })) {
      const materializeTemp = /^\.materialize-[0-9a-f]{40,64}-[A-Za-z0-9-]+$/.test(entry.name);
      const currentTemp = /^\.current-[A-Za-z0-9-]+$/.test(entry.name);
      if ((!materializeTemp && !currentTemp)
          || (materializeTemp && !entry.isDirectory() && !entry.isSymbolicLink())
          || (currentTemp && !entry.isFile() && !entry.isSymbolicLink())) {
        throw new Error(`unrecognized node in managed repo-md source root: ${entry.name}`);
      }
      const path = join(removalRoot, entry.name);
      if (entry.isDirectory()) makeTreeWritable(path);
      rmSync(path, { recursive: entry.isDirectory(), force: true });
    }
    fsyncPath(removalRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  rmSync(removalRoot, { recursive: true });
  fsyncPath(repo);
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

async function enumerateSelectedTree(
  source: KnowledgeSource,
  snapshotId: string,
  top: string,
  options: RepoMdMaterializerOptions,
  execFile: typeof nodeExecFile,
): Promise<{ config: EffectiveSourceScanConfig; entries: TreeEntry[] }> {
  const config = options.config ?? effectiveSourceScanConfig({ autoDetect: source.autoDetect, include: source.include, exclude: source.exclude });
  const listingLimit = Math.min(32 * 1024 * 1024, Math.max(1024 * 1024, config.limits.maxEntries * 512));
  const listing = await runGit(execFile, ["ls-tree", "-r", "-t", "-z", "--long", snapshotId], top, listingLimit);
  const records = listing.split("\0").filter(Boolean);
  if (records.length > config.limits.maxEntries) throw new Error("pinned Git tree exceeds the materialization entry limit");
  const entries: TreeEntry[] = [];
  let totalBytes = 0;
  for (const record of records) {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\s+([0-9-]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("cannot parse pinned Git tree entry");
    const [, mode, type, oid, sizeText, rawPath] = match;
    const path = validateArchivePath(rawPath!);
    if (type === "tree") continue;
    const selected = config.include.some((pattern) => matchesSourceGlob(pattern, path))
      && !config.exclude.some((pattern) => matchesSourceGlob(pattern, path));
    if (!selected) continue;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) throw new Error("selected Git entry is not a regular file");
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || size > config.limits.maxFileBytes) throw new Error("selected Git file exceeds the materialization file limit");
    if (entries.length >= config.limits.maxFiles) throw new Error("selected Git tree exceeds the materialization file limit");
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > config.limits.maxTotalBytes) throw new Error("selected Git tree exceeds the materialization total-byte limit");
    entries.push({ path, oid: oid!, size, mode: mode! });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { config, entries };
}

async function materializeRepoMdCommitAtRoot(
  source: KnowledgeSource,
  snapshotId: string,
  top: string,
  options: RepoMdMaterializerOptions,
  execFile: typeof nodeExecFile,
): Promise<RepoMdMaterialization> {
  const root = sourceRoot(source.id, options.sourceStorageDir)!;
  const desiredConfig = options.config ?? effectiveSourceScanConfig({ autoDetect: source.autoDetect, include: source.include, exclude: source.exclude });
  const desiredConfigHash = computeSourceIngestConfigHash(desiredConfig);
  const snapshotPath = repoMdSnapshotPath(source.id, snapshotId, desiredConfigHash, options.sourceStorageDir);
  const sidecarPath = repoMdSnapshotSidecarPath(source.id, snapshotId, desiredConfigHash, options.sourceStorageDir);
  const snapshotsPath = join(root, "snapshots");
  mkdirSync(snapshotsPath, { recursive: true, mode: 0o700 });
  const variant = variantName(snapshotId, desiredConfigHash);
  for (const name of readdirSync(snapshotsPath)) {
    if (name.startsWith(`.tree-${variant}-`)) {
      const staleTree = join(snapshotsPath, name);
      makeTreeWritable(staleTree);
      rmSync(staleTree, { recursive: true, force: true });
    } else if (name.startsWith(`.complete-${variant}-`)) {
      rmSync(join(snapshotsPath, name), { force: true });
    }
  }
  try {
    validateSealedSnapshot(snapshotPath, sidecarPath, snapshotId, desiredConfigHash);
    return { snapshotId, configHash: desiredConfigHash, snapshotPath, currentPath: join(root, "current"), repositoryRoot: top };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const treeExists = pathEntryExists(snapshotPath);
    const sidecarExists = pathEntryExists(sidecarPath);
    if (treeExists && sidecarExists) throw error;
    if (treeExists) { makeTreeWritable(snapshotPath); rmSync(snapshotPath, { recursive: true, force: true }); }
    if (sidecarExists) rmSync(sidecarPath, { force: true });
  }
  const { config, entries } = await enumerateSelectedTree(source, snapshotId, top, { ...options, config: desiredConfig }, execFile);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const maxArchiveBytes = options.maxArchiveBytes ?? Math.min(
    Number.MAX_SAFE_INTEGER,
    totalBytes + entries.length * 4096 + 2 * 1024 * 1024,
  );
  const pathArgBytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.path) + 1, 0);
  if (pathArgBytes > 512 * 1024) throw new Error("selected Git paths exceed the bounded archive argument limit");
  const token = (options.token ?? randomUUID)();
  const temporary = join(root, `.materialize-${snapshotId}-${token}`);
  // macOS refuses to move a non-writable directory between parents; stage beside the
  // final variant so the already-sealed root can still be atomically renamed in place.
  const tree = join(snapshotsPath, `.tree-${variant}-${token}`);
  const archive = join(temporary, "archive.tar");
  const temporarySidecar = join(snapshotsPath, `.complete-${variant}-${token}.json`);
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  mkdirSync(tree, { recursive: true, mode: 0o700 });
  try {
    let files: SnapshotMarker["files"] = [];
    if (entries.length > 0) {
      await runGit(execFile, ["--literal-pathspecs", "archive", "--format=tar", `--output=${archive}`, snapshotId, "--", ...entries.map((entry) => entry.path)], top);
      if (statSync(archive).size > maxArchiveBytes) throw new Error("git archive exceeds the materialization byte limit");
      options.fault?.("after-archive");
      files = extractGitArchive(archive, tree, entries, maxArchiveBytes);
    }
    const marker: SnapshotMarker = {
      version: 2, snapshotId, configHash: computeSourceIngestConfigHash(config),
      variant: variantName(snapshotId, desiredConfigHash), files,
    };
    sealSnapshot(tree);
    options.fault?.("before-snapshot-rename");
    renameSync(tree, snapshotPath);
    fsyncPath(snapshotsPath);
    options.fault?.("after-snapshot-rename");
    const sidecarFd = openSync(temporarySidecar, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeSync(sidecarFd, JSON.stringify(marker));
      chmodSync(temporarySidecar, 0o400);
      fsyncSync(sidecarFd);
    } finally { closeSync(sidecarFd); }
    options.fault?.("before-sidecar-rename");
    renameSync(temporarySidecar, sidecarPath);
    fsyncPath(snapshotsPath);
    options.fault?.("after-sidecar-rename");
    validateSealedSnapshot(snapshotPath, sidecarPath, snapshotId, desiredConfigHash);
    return { snapshotId, configHash: desiredConfigHash, snapshotPath, currentPath: join(root, "current"), repositoryRoot: top };
  } finally {
    makeTreeWritable(tree);
    rmSync(tree, { recursive: true, force: true });
    makeTreeWritable(temporary);
    rmSync(temporary, { recursive: true, force: true });
    rmSync(temporarySidecar, { force: true });
  }
}
