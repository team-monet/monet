import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import type { BigIntStats, Dirent } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  DEFAULT_SOURCE_MAX_CHUNKS,
  SOURCE_CHUNKER_VERSION,
  chunkSourceText,
  computeSourceContentHash,
  hashSourceDomain,
  type SourceChunk,
  type SourceChunkDiagnostic,
} from "./source-chunker";

export const SOURCE_SCANNER_VERSION = "v1";

export interface SourceScannerLimits {
  /** Maximum filesystem entries retained, whether selected or not; one extra entry may be probed to prove overflow. */
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxParseMs: number;
  maxChunkBytes: number;
  maxChunks: number;
}

export const DEFAULT_SOURCE_SCANNER_LIMITS: Readonly<SourceScannerLimits> = Object.freeze({
  maxEntries: 100_000,
  maxFiles: 10_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxParseMs: 30_000,
  maxChunkBytes: 32 * 1024,
  maxChunks: DEFAULT_SOURCE_MAX_CHUNKS,
});

const AUTO_DETECT_INCLUDES = Object.freeze([
  ".clinerules",
  ".cursor/rules/**",
  ".github/copilot-instructions.md",
  ".windsurf/**",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
]);

const DEFAULT_EXCLUDES = Object.freeze([
  ".git/**",
  ".hg/**",
  ".monet/**",
  ".svn/**",
  "build/**",
  "coverage/**",
  "dist/**",
  "node_modules/**",
  "vendor/**",
]);

const CONFIG_HASH_DOMAIN = "monet-src-ingest-config/v1";
const MANIFEST_HASH_DOMAIN = "monet-src-manifest/v1";
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const UNSUPPORTED_GLOB_RE = /[{}()|!\[\]?]/;

export interface EffectiveSourceScanConfig {
  autoDetect: boolean;
  include: string[];
  exclude: string[];
  limits: SourceScannerLimits;
}

export interface EffectiveSourceScanConfigInput {
  autoDetect?: boolean;
  include?: string[];
  exclude?: string[];
  limits?: Partial<SourceScannerLimits>;
}

export interface SourceScanFile {
  relativePath: string;
  type: "file";
  contentHash: string;
  byteLength: number;
}

export type SourceScanDiagnosticCode =
  | SourceChunkDiagnostic["code"]
  | "entry-budget-exceeded"
  | "file-budget-exceeded"
  | "file-too-large"
  | "invalid-utf8"
  | "io-error"
  | "parse-time-exceeded"
  | "symlink-rejected"
  | "root-escape-rejected"
  | "unsupported-node"
  | "toctou-rejected";

export interface SourceScanDiagnostic {
  code: SourceScanDiagnosticCode;
  message: string;
  relativePath?: string;
}

export interface SourceScanResult {
  status: "complete" | "partial";
  publishable: boolean;
  files: SourceScanFile[];
  chunks: SourceChunk[];
  manifestHash: string;
  ingestConfigHash: string;
  diagnostics: SourceScanDiagnostic[];
}

export interface ScanSourceSnapshotInput {
  root: string;
  config: EffectiveSourceScanConfig | EffectiveSourceScanConfigInput;
  /** Injectable monotonic-ish millisecond clock used only for the inclusive parse budget. */
  now?: () => number;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function normalizePattern(pattern: unknown, field: string): string {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern !== pattern.trim()) {
    throw new Error(`${field} must be a nonempty normalized POSIX pattern`);
  }
  if (CONTROL_RE.test(pattern) || pattern.includes("\\") || UNSUPPORTED_GLOB_RE.test(pattern)) {
    throw new Error(`${field} uses unsupported or unsafe glob syntax`);
  }
  if (pattern.startsWith("/") || /^[A-Za-z]:\//.test(pattern)) throw new Error(`${field} must be source-relative`);
  const segments = pattern.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${field} must be a normalized source-relative POSIX pattern`);
  }
  return pattern;
}

function normalizePatterns(patterns: unknown, field: string): string[] {
  if (!Array.isArray(patterns)) throw new Error(`${field} must be an array`);
  return [...new Set(patterns.map((pattern, index) => normalizePattern(pattern, `${field}[${index}]`)))].sort(compareUtf8);
}

function normalizeLimit(value: unknown, field: keyof SourceScannerLimits, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`limits.${field} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

/** Resolve auto-detection by unioning curated paths with explicit includes; excludes always win. */
export function effectiveSourceScanConfig(input: EffectiveSourceScanConfigInput): EffectiveSourceScanConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("scan config must be an object");
  if (input.autoDetect !== undefined && typeof input.autoDetect !== "boolean") throw new Error("autoDetect must be a boolean");
  const explicitIncludes = normalizePatterns(input.include ?? [], "include");
  const explicitExcludes = normalizePatterns(input.exclude ?? [], "exclude");
  const limits = input.limits ?? {};
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) throw new Error("limits must be an object");
  const allowedLimitKeys = new Set<keyof SourceScannerLimits>([
    "maxEntries", "maxFiles", "maxFileBytes", "maxTotalBytes", "maxParseMs", "maxChunkBytes", "maxChunks",
  ]);
  for (const key of Object.keys(limits)) {
    if (!allowedLimitKeys.has(key as keyof SourceScannerLimits)) throw new Error(`unknown scanner limit: ${key}`);
  }
  const autoDetect = input.autoDetect ?? false;
  return {
    autoDetect,
    include: [...new Set([...(autoDetect ? AUTO_DETECT_INCLUDES : []), ...explicitIncludes])].sort(compareUtf8),
    exclude: [...new Set([...DEFAULT_EXCLUDES, ...explicitExcludes])].sort(compareUtf8),
    limits: {
      maxEntries: normalizeLimit(limits.maxEntries ?? DEFAULT_SOURCE_SCANNER_LIMITS.maxEntries, "maxEntries"),
      maxFiles: normalizeLimit(limits.maxFiles ?? DEFAULT_SOURCE_SCANNER_LIMITS.maxFiles, "maxFiles"),
      maxFileBytes: normalizeLimit(limits.maxFileBytes ?? DEFAULT_SOURCE_SCANNER_LIMITS.maxFileBytes, "maxFileBytes"),
      maxTotalBytes: normalizeLimit(limits.maxTotalBytes ?? DEFAULT_SOURCE_SCANNER_LIMITS.maxTotalBytes, "maxTotalBytes"),
      maxParseMs: normalizeLimit(limits.maxParseMs ?? DEFAULT_SOURCE_SCANNER_LIMITS.maxParseMs, "maxParseMs"),
      maxChunkBytes: normalizeLimit(limits.maxChunkBytes ?? DEFAULT_SOURCE_SCANNER_LIMITS.maxChunkBytes, "maxChunkBytes", 1),
      maxChunks: normalizeLimit(limits.maxChunks ?? DEFAULT_SOURCE_SCANNER_LIMITS.maxChunks, "maxChunks"),
    },
  };
}

function matchSegment(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let starValueIndex = -1;
  while (valueIndex < value.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === value[valueIndex]) {
      patternIndex++;
      valueIndex++;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      while (pattern[patternIndex] === "*") patternIndex++;
      starIndex = patternIndex;
      starValueIndex = valueIndex;
    } else if (starIndex >= 0) {
      patternIndex = starIndex;
      valueIndex = ++starValueIndex;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === "*") patternIndex++;
  return patternIndex === pattern.length;
}

/** Anchored POSIX matching: `*` stays within one segment; a `**` segment spans zero or more. */
export function matchesSourceGlob(pattern: string, relativePath: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = relativePath.split("/");
  const memo = new Map<string, boolean>();
  const match = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (patternIndex === patternParts.length) result = pathIndex === pathParts.length;
    else if (patternParts[patternIndex] === "**") {
      result = match(patternIndex + 1, pathIndex) || (pathIndex < pathParts.length && match(patternIndex, pathIndex + 1));
    } else {
      result = pathIndex < pathParts.length && matchSegment(patternParts[patternIndex], pathParts[pathIndex])
        && match(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

function matchesAny(patterns: readonly string[], relativePath: string): boolean {
  return patterns.some((pattern) => matchesSourceGlob(pattern, relativePath));
}

/** Whether at least one strict descendant of relativePath could match pattern. */
function patternCanMatchDescendant(pattern: string, relativePath: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = relativePath.split("/");
  const memo = new Map<string, boolean>();
  const matchPrefix = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (pathIndex === pathParts.length) result = patternIndex < patternParts.length;
    else if (patternIndex === patternParts.length) result = false;
    else if (patternParts[patternIndex] === "**") {
      result = matchPrefix(patternIndex + 1, pathIndex) || matchPrefix(patternIndex, pathIndex + 1);
    } else {
      result = matchSegment(patternParts[patternIndex], pathParts[pathIndex])
        && matchPrefix(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return matchPrefix(0, 0);
}

function canContainSelectedDescendant(patterns: readonly string[], relativePath: string): boolean {
  return patterns.some((pattern) => patternCanMatchDescendant(pattern, relativePath));
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function identity(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

interface DirectoryIdentity {
  identity: FileIdentity;
  realPath: string;
}

interface SecureReadResult {
  bytes?: Buffer;
  diagnostic?: SourceScanDiagnostic;
  limitExceeded?: true;
}

function directoryIdentity(root: string, absolutePath: string): DirectoryIdentity | undefined {
  const stats = lstatSync(absolutePath, { bigint: true }) as BigIntStats;
  if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
  const realPath = realpathSync.native(absolutePath);
  if (!isContained(root, realPath)) return undefined;
  return { identity: identity(stats), realPath };
}

function sameDirectory(root: string, absolutePath: string, expected: DirectoryIdentity): boolean {
  try {
    const current = directoryIdentity(root, absolutePath);
    return current !== undefined && current.realPath === expected.realPath && sameIdentity(current.identity, expected.identity);
  } catch {
    return false;
  }
}

function secureRead(
  root: string,
  absolutePath: string,
  relativePath: string,
  enumeratedIdentity: FileIdentity,
  maxBytes: number,
  deadlineExceeded: () => boolean,
): SecureReadResult {
  let before: BigIntStats;
  let resolvedBefore: string;
  try {
    before = lstatSync(absolutePath, { bigint: true }) as BigIntStats;
    if (before.isSymbolicLink()) {
      return { diagnostic: { code: "symlink-rejected", message: "symbolic links are never followed", relativePath } };
    }
    if (!before.isFile()) {
      return { diagnostic: { code: "unsupported-node", message: "included path is not a regular file", relativePath } };
    }
    if (!sameIdentity(enumeratedIdentity, identity(before))) {
      return { diagnostic: { code: "toctou-rejected", message: "file identity changed after enumeration", relativePath } };
    }
    resolvedBefore = realpathSync.native(absolutePath);
    if (!isContained(root, resolvedBefore)) {
      return { diagnostic: { code: "root-escape-rejected", message: "resolved path escapes the source root", relativePath } };
    }
  } catch (error) {
    return { diagnostic: { code: "io-error", message: `cannot inspect included file: ${String(error)}`, relativePath } };
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true }) as BigIntStats;
    if (!opened.isFile() || !sameIdentity(identity(before), identity(opened))) {
      return { diagnostic: { code: "toctou-rejected", message: "file identity changed before read", relativePath } };
    }
    if (opened.size > BigInt(maxBytes)) return { limitExceeded: true };

    const parts: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      if (deadlineExceeded()) {
        return { diagnostic: { code: "parse-time-exceeded", message: "scan exceeded its inclusive parse budget during file read", relativePath } };
      }
      const allocation = Math.min(64 * 1024, maxBytes + 1 - total);
      const buffer = Buffer.allocUnsafe(allocation);
      const read = readSync(descriptor, buffer, 0, allocation, null);
      if (read === 0) break;
      parts.push(read === allocation ? buffer : buffer.subarray(0, read));
      total += read;
    }

    const afterRead = fstatSync(descriptor, { bigint: true }) as BigIntStats;
    const afterPath = lstatSync(absolutePath, { bigint: true }) as BigIntStats;
    const resolvedAfter = realpathSync.native(absolutePath);
    if (
      !sameIdentity(identity(opened), identity(afterRead)) ||
      !sameIdentity(identity(opened), identity(afterPath)) ||
      resolvedAfter !== resolvedBefore ||
      !isContained(root, resolvedAfter) ||
      BigInt(total) !== afterRead.size
    ) {
      return { diagnostic: { code: "toctou-rejected", message: "file identity changed during read", relativePath } };
    }
    if (total > maxBytes) return { limitExceeded: true };
    return { bytes: Buffer.concat(parts, total) };
  } catch (error) {
    return { diagnostic: { code: "io-error", message: `cannot safely read included file: ${String(error)}`, relativePath } };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function computeSourceIngestConfigHash(config: EffectiveSourceScanConfig): string {
  return hashSourceDomain(CONFIG_HASH_DOMAIN, [
    SOURCE_SCANNER_VERSION,
    SOURCE_CHUNKER_VERSION,
    String(config.autoDetect),
    JSON.stringify(config.include),
    JSON.stringify(config.exclude),
    JSON.stringify([
      config.limits.maxEntries,
      config.limits.maxFiles,
      config.limits.maxFileBytes,
      config.limits.maxTotalBytes,
      config.limits.maxParseMs,
      config.limits.maxChunkBytes,
      config.limits.maxChunks,
    ]),
  ]);
}

export function computeSourceManifestHash(files: readonly SourceScanFile[]): string {
  const canonicalFiles = [...files].sort((a, b) => compareUtf8(a.relativePath, b.relativePath));
  return hashSourceDomain(
    MANIFEST_HASH_DOMAIN,
    canonicalFiles.flatMap((file) => [file.relativePath, file.type, file.contentHash]),
  );
}

/**
 * Produce an immutable, deterministic view of selected Markdown. Selection and output order use
 * raw UTF-8 POSIX-path bytes. Security or resource uncertainty fails closed: the result is partial
 * and cannot be published, but deterministic successfully-read evidence remains inspectable.
 */
export function scanSourceSnapshot(input: ScanSourceSnapshotInput): SourceScanResult {
  const config = effectiveSourceScanConfig(input.config);
  const ingestConfigHash = computeSourceIngestConfigHash(config);
  const diagnostics: SourceScanDiagnostic[] = [];
  const files: SourceScanFile[] = [];
  const chunks: SourceChunk[] = [];
  const partialRoot = (diagnostic: SourceScanDiagnostic): SourceScanResult => ({
    status: "partial",
    publishable: false,
    files,
    chunks,
    manifestHash: computeSourceManifestHash(files),
    ingestConfigHash,
    diagnostics: [diagnostic],
  });
  const rootLexical = resolve(input.root);
  let root: string;
  let rootIdentity: DirectoryIdentity;
  try {
    const rootStats = lstatSync(rootLexical, { bigint: true }) as BigIntStats;
    if (rootStats.isSymbolicLink()) {
      return partialRoot({ code: "root-escape-rejected", message: "source root must not be a symbolic link" });
    }
    if (!rootStats.isDirectory()) {
      return partialRoot({ code: "unsupported-node", message: "source root must be a real directory" });
    }
    root = realpathSync.native(rootLexical);
    rootIdentity = { identity: identity(rootStats), realPath: root };
  } catch (error) {
    return partialRoot({ code: "io-error", message: `cannot inspect source root: ${String(error)}` });
  }
  const now = input.now ?? Date.now;
  const startedAt = now();
  const deadlineExceeded = (): boolean => Math.max(0, now() - startedAt) > config.limits.maxParseMs;

  // Empty explicit selection is a meaningful complete snapshot and avoids walking the tree.
  if (config.include.length === 0) {
    return {
      status: "complete",
      publishable: true,
      files,
      chunks,
      manifestHash: computeSourceManifestHash(files),
      ingestConfigHash,
      diagnostics,
    };
  }

  if (config.limits.maxFiles === 0) {
    return partialRoot({ code: "file-budget-exceeded", message: "a nonempty selection cannot be proven within a zero-file scan budget" });
  }
  if (config.limits.maxEntries === 0) {
    return partialRoot({ code: "entry-budget-exceeded", message: "a nonempty selection cannot be proven within a zero-entry scan budget" });
  }

  let totalBytes = 0;
  let selectedFiles = 0;
  let enumeratedEntries = 0;
  let stopped = false;

  const stopForDeadline = (relativePath?: string): boolean => {
    if (!deadlineExceeded()) return false;
    diagnostics.push({
      code: "parse-time-exceeded",
      message: `scan exceeded the inclusive ${config.limits.maxParseMs}ms parse budget`,
      ...(relativePath ? { relativePath } : {}),
    });
    stopped = true;
    return true;
  };

  const processFile = (absolutePath: string, relativePath: string, enumerated: FileIdentity): void => {
    if (selectedFiles >= config.limits.maxFiles) {
      diagnostics.push({
        code: "file-budget-exceeded",
        message: `scan exceeds the inclusive ${config.limits.maxFiles}-file limit`,
        relativePath,
      });
      stopped = true;
      return;
    }
    selectedFiles++;
    if (enumerated.size > BigInt(config.limits.maxFileBytes)) {
      diagnostics.push({
        code: "file-too-large",
        message: `file exceeds the inclusive ${config.limits.maxFileBytes}-byte limit`,
        relativePath,
      });
      return;
    }
    const remainingTotal = config.limits.maxTotalBytes - totalBytes;
    if (enumerated.size > BigInt(remainingTotal)) {
      diagnostics.push({
        code: "file-budget-exceeded",
        message: `scan exceeds the inclusive ${config.limits.maxTotalBytes}-byte total limit`,
        relativePath,
      });
      stopped = true;
      return;
    }
    const readLimit = Math.min(config.limits.maxFileBytes, remainingTotal);
    const read = secureRead(root, absolutePath, relativePath, enumerated, readLimit, deadlineExceeded);
    if (read.diagnostic) {
      diagnostics.push(read.diagnostic);
      if (read.diagnostic.code === "parse-time-exceeded" || read.diagnostic.code === "toctou-rejected" ||
          read.diagnostic.code === "root-escape-rejected") stopped = true;
      return;
    }
    if (read.limitExceeded || !read.bytes) {
      diagnostics.push({
        code: readLimit === config.limits.maxFileBytes ? "file-too-large" : "file-budget-exceeded",
        message: "file exceeded an inclusive byte limit during bounded read",
        relativePath,
      });
      stopped = true;
      return;
    }

    const contentHash = computeSourceContentHash(read.bytes);
    files.push({ relativePath, type: "file", contentHash, byteLength: read.bytes.length });
    totalBytes += read.bytes.length;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes).replace(/\r\n?/g, "\n");
    } catch {
      diagnostics.push({ code: "invalid-utf8", message: "included file is not strict UTF-8", relativePath });
      return;
    }
    const chunked = chunkSourceText({
      relativePath,
      text,
      fileContentHash: contentHash,
      ingestConfigHash,
      maxChunkBytes: config.limits.maxChunkBytes,
      maxChunks: config.limits.maxChunks - chunks.length,
      deadlineExceeded,
    });
    for (const chunk of chunked.chunks) chunks.push(chunk);
    diagnostics.push(...chunked.diagnostics);
    if (chunked.diagnostics.some((diagnostic) => diagnostic.code === "parse-time-exceeded")) {
      stopped = true;
      return;
    }
    stopForDeadline(relativePath);
  };

  const walkDirectory = (absoluteDir: string, relativeDir: string, expected: DirectoryIdentity): void => {
    if (stopped || stopForDeadline(relativeDir || undefined)) return;
    if (!sameDirectory(root, absoluteDir, expected)) {
      diagnostics.push({
        code: "toctou-rejected",
        message: "directory identity changed before enumeration",
        ...(relativeDir ? { relativePath: relativeDir } : {}),
      });
      stopped = true;
      return;
    }

    const entries: Dirent<string>[] = [];
    let directory: ReturnType<typeof opendirSync> | undefined;
    let directoryDescriptor: number | undefined;
    try {
      // Open without following a replacement symlink, verify the opened object, then enumerate
      // through the descriptor path where the host exposes one. This binds enumeration to the
      // identity checked above instead of resolving the caller-controlled path a second time.
      directoryDescriptor = openSync(
        absoluteDir,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = fstatSync(directoryDescriptor, { bigint: true }) as BigIntStats;
      if (!opened.isDirectory() || !sameIdentity(identity(opened), expected.identity)) {
        diagnostics.push({
          code: "toctou-rejected",
          message: "directory identity changed before descriptor-bound enumeration",
          ...(relativeDir ? { relativePath: relativeDir } : {}),
        });
        stopped = true;
        return;
      }
      // Linux procfs can reopen the exact descriptor. Node exposes no portable Dir fd, and
      // macOS rejects opendir(/dev/fd/<directory>), so other hosts retain the verified fd as
      // an identity guard while resolving the path with immediate and repeated checks.
      const descriptorPath = process.platform === "linux" ? `/proc/self/fd/${directoryDescriptor}` : undefined;
      directory = opendirSync(descriptorPath ?? absoluteDir);
      if (descriptorPath === undefined && !sameDirectory(root, absoluteDir, expected)) {
        diagnostics.push({
          code: "toctou-rejected",
          message: "directory identity changed before fallback enumeration",
          ...(relativeDir ? { relativePath: relativeDir } : {}),
        });
        stopped = true;
        return;
      }
      while (!stopped) {
        if (stopForDeadline(relativeDir || undefined)) break;
        const entry = directory.readSync();
        if (entry === null) break;
        if (enumeratedEntries >= config.limits.maxEntries) {
          diagnostics.push({
            code: "entry-budget-exceeded",
            message: `scan exceeds the inclusive ${config.limits.maxEntries}-entry traversal limit`,
            relativePath: relativeDir ? `${relativeDir}/${entry.name}` : entry.name,
          });
          stopped = true;
          break;
        }
        enumeratedEntries++;
        entries.push(entry);
      }
    } catch (error) {
      diagnostics.push({
        code: sameDirectory(root, absoluteDir, expected) ? "io-error" : "toctou-rejected",
        message: `cannot safely enumerate directory: ${String(error)}`,
        ...(relativeDir ? { relativePath: relativeDir } : {}),
      });
      stopped = true;
    } finally {
      directory?.closeSync();
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    }
    if (stopped) return;
    if (!sameDirectory(root, absoluteDir, expected)) {
      diagnostics.push({
        code: "toctou-rejected",
        message: "directory identity changed during enumeration",
        ...(relativeDir ? { relativePath: relativeDir } : {}),
      });
      stopped = true;
      return;
    }

    try {
      entries.sort((a, b) => {
        if (deadlineExceeded()) throw new Error("source-scan-deadline");
        return compareUtf8(`${a.name}${a.isDirectory() ? "/" : ""}`, `${b.name}${b.isDirectory() ? "/" : ""}`);
      });
    } catch (error) {
      if (error instanceof Error && error.message === "source-scan-deadline") {
        diagnostics.push({
          code: "parse-time-exceeded",
          message: `scan exceeded the inclusive ${config.limits.maxParseMs}ms parse budget during directory ordering`,
          ...(relativeDir ? { relativePath: relativeDir } : {}),
        });
      } else {
        diagnostics.push({ code: "io-error", message: `cannot order directory entries: ${String(error)}`, ...(relativeDir ? { relativePath: relativeDir } : {}) });
      }
      stopped = true;
      return;
    }
    for (const entry of entries) {
      if (stopped || stopForDeadline(relativeDir || undefined)) return;
      if (!sameDirectory(root, absoluteDir, expected)) {
        diagnostics.push({
          code: "toctou-rejected",
          message: "directory identity changed before child inspection",
          ...(relativeDir ? { relativePath: relativeDir } : {}),
        });
        stopped = true;
        return;
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (matchesAny(config.exclude, relativePath)) continue;
      const absolutePath = resolve(absoluteDir, entry.name);
      let stats: BigIntStats;
      try {
        stats = lstatSync(absolutePath, { bigint: true }) as BigIntStats;
      } catch (error) {
        diagnostics.push({ code: "io-error", message: `cannot inspect path: ${String(error)}`, relativePath });
        continue;
      }
      const selected = matchesAny(config.include, relativePath);
      if (stats.isSymbolicLink()) {
        if (selected || canContainSelectedDescendant(config.include, relativePath)) {
          diagnostics.push({ code: "symlink-rejected", message: "selected symbolic links and selected subtree prefixes are never followed", relativePath });
        }
        continue;
      }
      if (stats.isDirectory()) {
        let childIdentity: DirectoryIdentity | undefined;
        try {
          childIdentity = directoryIdentity(root, absolutePath);
        } catch {
          childIdentity = undefined;
        }
        if (!childIdentity) {
          diagnostics.push({ code: "toctou-rejected", message: "directory changed identity or escaped the root", relativePath });
          stopped = true;
          return;
        }
        walkDirectory(absolutePath, relativePath, childIdentity);
      } else if (stats.isFile()) {
        if (selected) processFile(absolutePath, relativePath, identity(stats));
      } else if (selected) {
        diagnostics.push({ code: "unsupported-node", message: "included path is not a regular file", relativePath });
      }
    }
    if (!stopped && !sameDirectory(root, absoluteDir, expected)) {
      diagnostics.push({
        code: "toctou-rejected",
        message: "directory identity changed during child processing",
        ...(relativeDir ? { relativePath: relativeDir } : {}),
      });
      stopped = true;
    }
  };

  walkDirectory(rootLexical, "", rootIdentity);
  if (!stopped && !sameDirectory(root, rootLexical, rootIdentity)) {
    diagnostics.push({ code: "toctou-rejected", message: "source root identity changed during scan" });
  }

  files.sort((a, b) => compareUtf8(a.relativePath, b.relativePath));
  const partial = diagnostics.length > 0;
  return {
    status: partial ? "partial" : "complete",
    publishable: !partial,
    files,
    chunks,
    manifestHash: computeSourceManifestHash(files),
    ingestConfigHash,
    diagnostics,
  };
}
