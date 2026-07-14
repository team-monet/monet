import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, posix, relative, resolve, sep } from "node:path";
import type { StoragePort } from "./storage";
import type {
  CreateSourceInput,
  KnowledgeSource,
  SourceAuthorizationContext,
  SourceGetOptions,
  SourceListOptions,
  SourceRefreshPolicy,
  SourceRepoMapping,
  SourceStatus,
  SourceTransportPolicy,
  SourceTransportScheme,
  UpdateSourceInput,
} from "./source-types";

export interface SourceRow {
  id: string;
  type: "repo-md" | "git-md";
  name: string;
  repository_identity: string;
  remote_url: string | null;
  local_path: string;
  local_path_key: string;
  branch: string | null;
  circle: string;
  auto_detect: number;
  include_json: string;
  exclude_json: string;
  repo_mappings_json: string;
  allowed_caller_ids_json: string;
  allowed_project_ids_json: string;
  transport_schemes_json: string;
  transport_hosts_json: string;
  write_back: "none" | "pull-request";
  refresh_mode: "manual" | "interval";
  refresh_interval_seconds: number | null;
  config_version: number;
  applied_config_version: number | null;
  active_run_id: string | null;
  active_snapshot_id: string | null;
  active_ingest_config_hash: string | null;
  lease_fence: number;
  lifecycle: "active" | "tombstoned";
  created_at: number;
  updated_at: number;
  tombstoned_at: number | null;
}

interface CanonicalSourceConfig {
  id: string;
  type: "repo-md" | "git-md";
  name: string;
  repositoryIdentity: string;
  remoteUrl: string | null;
  localPath: string;
  localPathKey: string;
  branch: string | null;
  circle: string;
  autoDetect: boolean;
  include: string[];
  exclude: string[];
  repoMappings: SourceRepoMapping[];
  access: { allowedCallerIds: string[]; allowedProjectIds: string[] };
  transport: SourceTransportPolicy | null;
  writeBack: "none" | "pull-request";
  refresh: SourceRefreshPolicy;
}

export interface SourceRegistryOptions {
  idGen: () => string;
  sourceStorageDir?: string;
  canonicalizeCircle?: (circle: string) => string;
  now?: () => number;
}

const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const WINDOWS_RESERVED_COMPONENT_RE = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/i;
const BRANCH_FORBIDDEN_RE = /[\u0000-\u0020\u007f~^:?*\[\\]/;
const PATTERN_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const UNSAFE_GLOB_SYNTAX_RE = /[{}()|!\[\]?]/;
const MAX_PATTERN_LENGTH = 512;
const MAX_PATTERNS_PER_LIST = 256;
const MAX_REPO_MAPPINGS = 128;
const MAX_REPO_MAPPING_PATHS = 512;
const MUTABLE_KEYS = new Set([
  "name",
  "autoDetect",
  "include",
  "exclude",
  "repoMappings",
  "access",
  "transport",
  "writeBack",
  "refresh",
]);
const IMMUTABLE_KEYS = new Set(["id", "type", "repositoryIdentity", "remoteUrl", "localPath", "branch", "circle"]);

function requireNonemptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a nonempty string`);
  return value.trim();
}

function normalizeBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

interface CanonicalPathInfo {
  lexical: string;
  effective: string;
}

function canonicalPathInfo(value: unknown, field: string): CanonicalPathInfo {
  const path = requireNonemptyString(value, field);
  if (!isAbsolute(path)) throw new Error(`${field} must be an absolute path`);
  const lexical = resolve(normalize(path));
  let cursor = lexical;
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  let effective = lexical;
  if (existsSync(cursor)) {
    try {
      effective = resolve(realpathSync.native(cursor), ...suffix);
    } catch {
      // A concurrent unlink or unreadable ancestor falls back to the already-canonical lexical path.
    }
  }
  return { lexical, effective };
}

function canonicalPath(value: unknown, field: string): string {
  return canonicalPathInfo(value, field).effective;
}

function pathComparisonKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function localPathOwnershipKey(path: string): string {
  return pathComparisonKey(resolve(normalize(path))).split(sep).join("/");
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(pathComparisonKey(parent), pathComparisonKey(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeStringArray(value: unknown, field: string, requireNonempty = false): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const values = value.map((item, index) => requireNonemptyString(item, `${field}[${index}]`));
  const normalized = [...new Set(values)].sort();
  if (requireNonempty && normalized.length === 0) throw new Error(`${field} must be nonempty`);
  return normalized;
}

function normalizePattern(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a nonempty string`);
  if (value !== value.trim()) throw new Error(`${field} must be a normalized POSIX source-relative pattern`);
  const pattern = value;
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`${field} exceeds ${MAX_PATTERN_LENGTH} characters`);
  if (PATTERN_CONTROL_RE.test(pattern)) throw new Error(`${field} must not contain NUL or control characters`);
  if (UNSAFE_GLOB_SYNTAX_RE.test(pattern)) {
    throw new Error(`${field} uses unsupported brace, extglob, pipe, negation, character-class, or question-mark syntax`);
  }
  if (pattern.includes("\\")) throw new Error(`${field} must use POSIX separators and must not contain backslashes`);
  if (posix.isAbsolute(pattern) || /^[A-Za-z]:\//.test(pattern)) throw new Error(`${field} must be source-relative`);
  const segments = pattern.split("/");
  if (segments.some((segment) => segment === "..")) throw new Error(`${field} must not contain parent traversal segments`);
  if (segments.some((segment) => segment === "" || segment === ".") || posix.normalize(pattern) !== pattern) {
    throw new Error(`${field} must be a normalized POSIX source-relative pattern`);
  }
  return pattern;
}

function normalizePatternArray(value: unknown, field: string, max = MAX_PATTERNS_PER_LIST): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > max) throw new Error(`${field} must contain at most ${max} patterns`);
  return [...new Set(value.map((item, index) => normalizePattern(item, `${field}[${index}]`)))].sort();
}

function normalizeHost(value: unknown, field: string): string {
  const host = requireNonemptyString(value, field).toLowerCase();
  if (host.includes("/") || host.includes("@") || host.includes(":")) throw new Error(`${field} must be a hostname without credentials or a port`);
  return host;
}

function normalizeRemoteUrl(value: unknown): { remoteUrl: string; repositoryIdentity: string; scheme: SourceTransportScheme; host: string } {
  const raw = requireNonemptyString(value, "remoteUrl");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("remoteUrl must be an absolute credential-free https or ssh URL");
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "https" && scheme !== "ssh") throw new Error("remoteUrl scheme must be https or ssh");
  if (url.password || (scheme === "https" && url.username)) throw new Error("remoteUrl must not contain embedded credentials");
  if (scheme === "ssh" && url.username && !/^[A-Za-z0-9._-]+$/.test(url.username)) {
    throw new Error("remoteUrl SSH user must be a credential-free username");
  }
  if (url.search || url.hash) throw new Error("remoteUrl must not contain a query or fragment");
  if (/%2f|%5c/i.test(url.pathname)) throw new Error("remoteUrl repository path must not contain encoded separators");
  const host = url.hostname.toLowerCase();
  if (!host) throw new Error("remoteUrl must contain a host");
  let path = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) throw new Error("remoteUrl must identify a repository");
  if (host === "github.com" && segments.length !== 2) {
    throw new Error("GitHub remoteUrl must have exactly owner/repository path segments");
  }
  if (host === "github.com") path = `/${segments.map((part) => part.toLowerCase()).join("/")}`;
  const authority = url.port ? `${host}:${url.port}` : host;
  if (url.port) throw new Error("remoteUrl must not contain a port; transport hosts are exact hostnames");
  return {
    remoteUrl: `${scheme}://${scheme === "ssh" && url.username ? `${url.username}@` : ""}${authority}${path}`,
    repositoryIdentity: `${authority}${path}`,
    scheme,
    host,
  };
}

/** Normalize a URL-like repository or retain an explicit opaque project identity. */
export function normalizeRepositoryIdentity(value: string): string {
  const identity = requireNonemptyString(value, "repositoryIdentity");
  if (isAbsolute(identity)) throw new Error("repositoryIdentity must not be a local path");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(identity)) return normalizeRemoteUrl(identity).repositoryIdentity;
  if (identity.includes("@")) throw new Error("repositoryIdentity must not contain credentials");
  const stripped = identity.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!stripped) throw new Error("repositoryIdentity must be nonempty");
  const parts = stripped.split("/");
  if (parts.length >= 3 && parts[0].includes(".")) {
    parts[0] = parts[0].toLowerCase();
    if (parts[0] === "github.com") {
      for (let i = 1; i < parts.length; i++) parts[i] = parts[i].toLowerCase();
    }
    return parts.join("/");
  }
  return stripped;
}

function normalizeBranch(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error("branch is not a valid explicit Git branch name");
  }
  const branch = value;
  if (
    branch.toUpperCase() === "HEAD" ||
    branch.startsWith("-") ||
    branch.startsWith(".") ||
    branch.endsWith(".") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch === "@" ||
    BRANCH_FORBIDDEN_RE.test(branch) ||
    branch.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error("branch is not a valid explicit Git branch name");
  }
  return branch;
}

function normalizeTransport(value: unknown): SourceTransportPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("transport policy is required for git-md");
  const raw = value as Partial<SourceTransportPolicy>;
  const schemes = normalizeStringArray(raw.allowedUrlSchemes, "transport.allowedUrlSchemes", true).map((scheme) => {
    if (scheme !== "https" && scheme !== "ssh") throw new Error("transport.allowedUrlSchemes supports only https and ssh");
    return scheme;
  }) as SourceTransportScheme[];
  const hosts = normalizeStringArray(raw.allowedHosts, "transport.allowedHosts", true).map((host, index) =>
    normalizeHost(host, `transport.allowedHosts[${index}]`),
  );
  return { allowedUrlSchemes: [...new Set(schemes)].sort(), allowedHosts: [...new Set(hosts)].sort() };
}

function normalizeRefresh(value: unknown): SourceRefreshPolicy {
  const refresh = value ?? { mode: "manual" };
  if (!refresh || typeof refresh !== "object" || Array.isArray(refresh)) throw new Error("refresh must be an object");
  const raw = refresh as Partial<SourceRefreshPolicy>;
  if (raw.mode !== "manual" && raw.mode !== "interval") throw new Error("refresh.mode must be manual or interval");
  if (raw.mode === "interval") {
    if (!Number.isFinite(raw.intervalSeconds) || !Number.isInteger(raw.intervalSeconds) || (raw.intervalSeconds ?? 0) <= 0) {
      throw new Error("refresh.intervalSeconds must be a finite positive integer for interval mode");
    }
    return { mode: "interval", intervalSeconds: raw.intervalSeconds };
  }
  if (raw.intervalSeconds !== undefined) throw new Error("refresh.intervalSeconds is valid only for interval mode");
  return { mode: "manual" };
}

function normalizeRepoMappings(value: unknown): SourceRepoMapping[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("repoMappings must be an array");
  if (value.length > MAX_REPO_MAPPINGS) throw new Error(`repoMappings must contain at most ${MAX_REPO_MAPPINGS} entries`);
  const byRepo = new Map<string, string[] | undefined>();
  let totalPaths = 0;
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`repoMappings[${index}] must be an object`);
    const mapping = item as Partial<SourceRepoMapping>;
    const repo = normalizeRepositoryIdentity(requireNonemptyString(mapping.repo, `repoMappings[${index}].repo`));
    const paths = mapping.paths === undefined ? undefined : normalizePatternArray(mapping.paths, `repoMappings[${index}].paths`);
    totalPaths += paths?.length ?? 0;
    if (totalPaths > MAX_REPO_MAPPING_PATHS) {
      throw new Error(`repoMappings paths must contain at most ${MAX_REPO_MAPPING_PATHS} patterns in total`);
    }
    const hasPrevious = byRepo.has(repo);
    const previous = byRepo.get(repo);
    if (!hasPrevious) byRepo.set(repo, paths);
    else if (previous === undefined || paths === undefined) byRepo.set(repo, undefined);
    else byRepo.set(repo, [...new Set([...previous, ...paths])].sort());
  }
  return [...byRepo.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([repo, paths]) => (paths === undefined ? { repo } : { repo, paths }));
}

function deriveStatus(row: Pick<SourceRow, "lifecycle" | "config_version" | "applied_config_version">): SourceStatus {
  if (row.lifecycle === "tombstoned") return "tombstoned";
  if (row.applied_config_version === null) return "pending-initial-sync";
  if (row.applied_config_version === row.config_version) return "active";
  if (row.applied_config_version < row.config_version) return "pending-replacement";
  throw new Error("source registry is corrupt: appliedConfigVersion exceeds configVersion");
}

function parseJsonArray<T>(value: string): T[] {
  return JSON.parse(value) as T[];
}

export function rowToSource(row: SourceRow): KnowledgeSource {
  const transportSchemes = parseJsonArray<SourceTransportScheme>(row.transport_schemes_json);
  const transportHosts = parseJsonArray<string>(row.transport_hosts_json);
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    repositoryIdentity: row.repository_identity,
    ...(row.remote_url === null ? {} : { remoteUrl: row.remote_url }),
    localPath: row.local_path,
    ...(row.branch === null ? {} : { branch: row.branch }),
    circle: row.circle,
    autoDetect: row.auto_detect === 1,
    include: parseJsonArray<string>(row.include_json),
    exclude: parseJsonArray<string>(row.exclude_json),
    repoMappings: parseJsonArray<SourceRepoMapping>(row.repo_mappings_json),
    access: {
      allowedCallerIds: parseJsonArray<string>(row.allowed_caller_ids_json),
      allowedProjectIds: parseJsonArray<string>(row.allowed_project_ids_json),
    },
    ...(row.type === "git-md" ? { transport: { allowedUrlSchemes: transportSchemes, allowedHosts: transportHosts } } : {}),
    writeBack: row.write_back,
    refresh: row.refresh_interval_seconds === null
      ? { mode: row.refresh_mode }
      : { mode: row.refresh_mode, intervalSeconds: row.refresh_interval_seconds },
    configVersion: row.config_version,
    appliedConfigVersion: row.applied_config_version,
    activeRunId: row.active_run_id,
    activeSnapshotId: row.active_snapshot_id,
    activeIngestConfigHash: row.active_ingest_config_hash,
    leaseFence: row.lease_fence,
    lifecycle: row.lifecycle,
    status: deriveStatus(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tombstonedAt: row.tombstoned_at,
  };
}

function mutableConfig(config: CanonicalSourceConfig): unknown {
  return {
    name: config.name,
    autoDetect: config.autoDetect,
    include: config.include,
    exclude: config.exclude,
    repoMappings: config.repoMappings,
    access: config.access,
    transport: config.transport,
    writeBack: config.writeBack,
    refresh: config.refresh,
  };
}

/** Synchronous registry over the same SQLite connection as MonetCore. */
export class SourceRegistry {
  private readonly sourceStorageDir: string;
  private readonly sourceStoragePaths: CanonicalPathInfo;
  private readonly canonicalizeCircle: (circle: string) => string;
  private readonly now: () => number;

  constructor(
    private readonly db: StoragePort,
    private readonly options: SourceRegistryOptions,
  ) {
    const storageDir = options.sourceStorageDir === undefined
      ? resolve(homedir(), ".monet", "sources")
      : resolve(options.sourceStorageDir);
    this.sourceStoragePaths = canonicalPathInfo(storageDir, "sourceStorageDir");
    this.sourceStorageDir = this.sourceStoragePaths.effective;
    this.canonicalizeCircle = options.canonicalizeCircle ?? ((circle) => circle);
    this.now = options.now ?? Date.now;
  }

  /** Additive and idempotent; engine migration owns the user_version sentinel. */
  ensureSchema(): void {
    this.db.immediateTransaction(() => {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('repo-md', 'git-md')),
        name TEXT NOT NULL,
        repository_identity TEXT NOT NULL,
        remote_url TEXT,
        local_path TEXT NOT NULL,
        local_path_key TEXT NOT NULL,
        branch TEXT,
        circle TEXT NOT NULL,
        auto_detect INTEGER NOT NULL DEFAULT 0,
        include_json TEXT NOT NULL DEFAULT '[]',
        exclude_json TEXT NOT NULL DEFAULT '[]',
        repo_mappings_json TEXT NOT NULL DEFAULT '[]',
        allowed_caller_ids_json TEXT NOT NULL,
        allowed_project_ids_json TEXT NOT NULL,
        transport_schemes_json TEXT NOT NULL DEFAULT '[]',
        transport_hosts_json TEXT NOT NULL DEFAULT '[]',
        write_back TEXT NOT NULL DEFAULT 'none' CHECK (write_back IN ('none', 'pull-request')),
        refresh_mode TEXT NOT NULL DEFAULT 'manual' CHECK (refresh_mode IN ('manual', 'interval')),
        refresh_interval_seconds INTEGER,
        config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
        applied_config_version INTEGER,
        active_run_id TEXT,
        active_snapshot_id TEXT,
        active_ingest_config_hash TEXT,
        lease_fence INTEGER NOT NULL DEFAULT 1 CHECK (lease_fence > 0),
        lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'tombstoned')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        tombstoned_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_sources_lifecycle_id
        ON knowledge_sources(lifecycle, id);
    `);
    const columns = this.db.prepare(`PRAGMA table_info(knowledge_sources)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "local_path_key")) {
      this.db.exec(`ALTER TABLE knowledge_sources ADD COLUMN local_path_key TEXT`);
    }
    if (!columns.some((column) => column.name === "active_run_id")) {
      this.db.exec(`ALTER TABLE knowledge_sources ADD COLUMN active_run_id TEXT`);
    }
    if (!columns.some((column) => column.name === "active_snapshot_id")) {
      this.db.exec(`ALTER TABLE knowledge_sources ADD COLUMN active_snapshot_id TEXT`);
    }
    if (!columns.some((column) => column.name === "active_ingest_config_hash")) {
      this.db.exec(`ALTER TABLE knowledge_sources ADD COLUMN active_ingest_config_hash TEXT`);
    }
    const rows = this.db.prepare(`SELECT id, local_path FROM knowledge_sources WHERE local_path_key IS NULL`).all() as Array<{
      id: string;
      local_path: string;
    }>;
    for (const row of rows) {
      this.db.prepare(`UPDATE knowledge_sources SET local_path_key = ? WHERE id = ?`).run(localPathOwnershipKey(row.local_path), row.id);
    }
    const gitRows = this.db.prepare(`SELECT id, local_path FROM knowledge_sources WHERE type = 'git-md'`).all() as Array<{ id: string; local_path: string }>;
    for (const row of gitRows) {
      const legacy = resolve(this.sourceStorageDir, row.id);
      const allocated = resolve(this.sourceStorageDir, "git-md", row.id, "repository.git");
      if (row.local_path === allocated) continue;
      if (row.local_path !== legacy || existsSync(legacy) || existsSync(allocated)) {
        throw new Error("git-md allocator migration is ambiguous or contains unsupported filesystem content");
      }
      this.db.prepare(`UPDATE knowledge_sources SET local_path = ?, local_path_key = ? WHERE id = ?`)
        .run(allocated, localPathOwnershipKey(allocated), row.id);
    }
    // v7 is not yet shipped: replace the first-round all-history path index with active ownership.
    this.db.exec(`
      DROP INDEX IF EXISTS uq_knowledge_sources_local_path;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_sources_active_local_path_key
        ON knowledge_sources(local_path_key) WHERE lifecycle = 'active';
    `);
    })();
  }

  private canonicalize(input: CreateSourceInput, forcedId?: string, existingGitLocalPath?: string): CanonicalSourceConfig {
    if (input.type !== "repo-md" && input.type !== "git-md") throw new Error("source type must be repo-md or git-md");
    const rawId = forcedId ?? input.id ?? this.options.idGen();
    if (typeof rawId !== "string" || rawId.length === 0 || rawId !== rawId.trim()) {
      throw new Error("id must be a lowercase portable source authority/path component (1-64 letters, digits, or interior hyphens)");
    }
    const id = rawId;
    if (!SOURCE_ID_RE.test(id) || WINDOWS_RESERVED_COMPONENT_RE.test(id)) {
      throw new Error("id must be a lowercase portable source authority/path component (1-64 letters, digits, or interior hyphens)");
    }
    const name = requireNonemptyString(input.name, "name");
    const rawCircle = requireNonemptyString(input.circle, "circle");
    const circle = requireNonemptyString(this.canonicalizeCircle(rawCircle), "circle");
    const include = normalizePatternArray(input.include ?? [], "include");
    let exclude = normalizePatternArray(input.exclude ?? [], "exclude");
    const repoMappings = normalizeRepoMappings(input.repoMappings);
    if (!input.access || typeof input.access !== "object") throw new Error("access policy is required");
    const access = {
      allowedCallerIds: normalizeStringArray(input.access.allowedCallerIds, "access.allowedCallerIds", true),
      allowedProjectIds: normalizeStringArray(input.access.allowedProjectIds, "access.allowedProjectIds", true),
    };
    const writeBack = input.writeBack ?? "none";
    if (writeBack !== "none" && writeBack !== "pull-request") throw new Error("writeBack must be none or pull-request");
    const refresh = normalizeRefresh(input.refresh);

    if (input.type === "repo-md") {
      if ((input as unknown as Record<string, unknown>).remoteUrl !== undefined ||
          (input as unknown as Record<string, unknown>).branch !== undefined ||
          (input as unknown as Record<string, unknown>).transport !== undefined) {
        throw new Error("repo-md must not configure remoteUrl, branch, or transport");
      }
      const localPathInfo = canonicalPathInfo(input.localPath, "localPath");
      const aliases = [localPathInfo.lexical, localPathInfo.effective];
      const managedAliases = [this.sourceStoragePaths.lexical, this.sourceStoragePaths.effective];
      if (aliases.some((root) => managedAliases.some((managed) => pathContains(managed, root)))) {
        throw new Error("repo-md localPath must not overlap Monet's managed sourceStorageDir");
      }
      const localPath = localPathInfo.effective;
      const reservedExcludes = new Set<string>();
      for (const root of aliases) {
        for (const managed of managedAliases) {
          if (pathContains(root, managed) && pathComparisonKey(root) !== pathComparisonKey(managed)) {
            const relativeManaged = relative(root, managed).split(sep).join("/");
            if (relativeManaged && !relativeManaged.startsWith("../")) {
              reservedExcludes.add(normalizePattern(`${relativeManaged}/**`, "reserved managed source path"));
            }
          }
        }
      }
      exclude = [...new Set([...exclude, ...reservedExcludes])].sort();
      if (writeBack !== "none") throw new Error("repo-md writeBack must be none");
      const repositoryIdentity = input.repositoryIdentity === undefined
        ? `local:${localPath}`
        : normalizeRepositoryIdentity(input.repositoryIdentity);
      return {
        id,
        type: "repo-md",
        name,
        repositoryIdentity,
        remoteUrl: null,
        localPath,
        localPathKey: localPathOwnershipKey(localPath),
        branch: null,
        circle,
        autoDetect: normalizeBoolean(input.autoDetect, "autoDetect", false),
        include,
        exclude,
        repoMappings,
        access,
        transport: null,
        writeBack,
        refresh,
      };
    }

    if ((input as unknown as Record<string, unknown>).localPath !== undefined && existingGitLocalPath === undefined) {
      throw new Error("git-md localPath is Monet-owned and cannot be supplied");
    }

    const remote = normalizeRemoteUrl(input.remoteUrl);
    const branch = normalizeBranch(input.branch);
    const transport = normalizeTransport(input.transport);
    if (!transport.allowedUrlSchemes.includes(remote.scheme) || !transport.allowedHosts.includes(remote.host)) {
      throw new Error("remoteUrl is not allowed by the source transport policy");
    }
    const repositoryIdentity = input.repositoryIdentity === undefined
      ? remote.repositoryIdentity
      : normalizeRepositoryIdentity(input.repositoryIdentity);
    if (repositoryIdentity !== remote.repositoryIdentity) {
      throw new Error("repositoryIdentity must match the normalized git-md remoteUrl");
    }
    if (writeBack === "pull-request" && remote.host !== "github.com") {
      throw new Error("pull-request writeBack is supported only for git-md GitHub sources");
    }
    const localPath = existingGitLocalPath ?? resolve(this.sourceStorageDir, "git-md", id, "repository.git");
    if (localPath !== this.sourceStorageDir && !localPath.startsWith(`${this.sourceStorageDir}${sep}`)) {
      throw new Error("allocated source localPath escapes the Monet source directory");
    }
    return {
      id,
      type: "git-md",
      name,
      repositoryIdentity,
      remoteUrl: remote.remoteUrl,
      localPath,
      localPathKey: localPathOwnershipKey(localPath),
      branch,
      circle,
      autoDetect: normalizeBoolean(input.autoDetect, "autoDetect", false),
      include,
      exclude,
      repoMappings,
      access,
      transport,
      writeBack,
      refresh,
    };
  }

  createSource(input: CreateSourceInput): KnowledgeSource {
    const txn = this.db.immediateTransaction(() => {
      // Circle alias resolution is deliberately inside the immediate write fence: after waiting
      // for an in-flight rename/merge, creation observes and stores the newly canonical circle.
      const source = this.canonicalize(input);
      const existing = this.db.prepare(`SELECT lifecycle FROM knowledge_sources WHERE id = ?`).get(source.id) as
        | { lifecycle: "active" | "tombstoned" }
        | undefined;
      if (existing) {
        if (existing.lifecycle === "tombstoned") throw new Error("source id is permanently tombstoned and cannot be reused");
        throw new Error("source id already exists");
      }
      const pathOwner = this.db
        .prepare(`SELECT id FROM knowledge_sources WHERE local_path_key = ? AND lifecycle = 'active' LIMIT 1`)
        .get(source.localPathKey) as
        | { id: string }
        | undefined;
      if (pathOwner) throw new Error("source localPath is already owned by another active source id");
      const now = this.now();
      this.db.prepare(
        `INSERT INTO knowledge_sources (
          id, type, name, repository_identity, remote_url, local_path, local_path_key, branch, circle,
          auto_detect, include_json, exclude_json, repo_mappings_json,
          allowed_caller_ids_json, allowed_project_ids_json, transport_schemes_json,
          transport_hosts_json, write_back, refresh_mode, refresh_interval_seconds,
          config_version, applied_config_version, lease_fence, lifecycle, created_at, updated_at, tombstoned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 1, 'active', ?, ?, NULL)`,
      ).run(
        source.id,
        source.type,
        source.name,
        source.repositoryIdentity,
        source.remoteUrl,
        source.localPath,
        source.localPathKey,
        source.branch,
        source.circle,
        source.autoDetect ? 1 : 0,
        JSON.stringify(source.include),
        JSON.stringify(source.exclude),
        JSON.stringify(source.repoMappings),
        JSON.stringify(source.access.allowedCallerIds),
        JSON.stringify(source.access.allowedProjectIds),
        JSON.stringify(source.transport?.allowedUrlSchemes ?? []),
        JSON.stringify(source.transport?.allowedHosts ?? []),
        source.writeBack,
        source.refresh.mode,
        source.refresh.intervalSeconds ?? null,
        now,
        now,
      );
      return this.getSource(source.id, { includeTombstoned: true })!;
    });
    return txn();
  }

  updateSource(id: string, patch: UpdateSourceInput): KnowledgeSource {
    const sourceId = requireNonemptyString(id, "id");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("source update must be an object");
    for (const key of Object.keys(patch)) {
      if (!MUTABLE_KEYS.has(key) && !IMMUTABLE_KEYS.has(key)) throw new Error(`unknown source update field: ${key}`);
    }
    const txn = this.db.immediateTransaction(() => {
      const current = this.getSource(sourceId, { includeTombstoned: true });
      if (!current) throw new Error("source not found");
      if (current.lifecycle === "tombstoned") throw new Error("tombstoned source cannot be updated");

      if (patch.id !== undefined && patch.id !== current.id) {
        throw new Error("source-identity-immutable: remove and create a new source id instead");
      }
      if (patch.type !== undefined && patch.type !== current.type) {
        throw new Error("source-identity-immutable: remove and create a new source id instead");
      }
      if (
        patch.repositoryIdentity !== undefined &&
        normalizeRepositoryIdentity(patch.repositoryIdentity) !== current.repositoryIdentity
      ) {
        throw new Error("source-identity-immutable: remove and create a new source id instead");
      }
      if (
        patch.circle !== undefined &&
        requireNonemptyString(this.canonicalizeCircle(requireNonemptyString(patch.circle, "circle")), "circle") !== current.circle
      ) {
        throw new Error("source-identity-immutable: remove and create a new source id instead");
      }
      if (patch.localPath !== undefined && canonicalPath(patch.localPath, "localPath") !== current.localPath) {
        throw new Error("source-identity-immutable: remove and create a new source id instead");
      }
      if (patch.remoteUrl !== undefined) {
        const normalized = normalizeRemoteUrl(patch.remoteUrl).remoteUrl;
        if (normalized !== current.remoteUrl) {
          throw new Error("source-identity-immutable: remove and create a new source id instead");
        }
      }
      if (patch.branch !== undefined && normalizeBranch(patch.branch) !== current.branch) {
        throw new Error("source-identity-immutable: remove and create a new source id instead");
      }
      if (current.type === "repo-md" && patch.transport !== undefined) {
        throw new Error("repo-md must not configure transport");
      }

      const has = (key: keyof UpdateSourceInput) => Object.prototype.hasOwnProperty.call(patch, key);
      const base = {
        id: current.id,
        type: current.type,
        name: has("name") ? patch.name! : current.name,
        repositoryIdentity: has("repositoryIdentity") ? patch.repositoryIdentity! : current.repositoryIdentity,
        circle: has("circle") ? patch.circle! : current.circle,
        autoDetect: has("autoDetect") ? patch.autoDetect! : current.autoDetect,
        include: has("include") ? patch.include! : current.include,
        exclude: has("exclude") ? patch.exclude! : current.exclude,
        repoMappings: has("repoMappings") ? patch.repoMappings! : current.repoMappings,
        access: has("access") ? patch.access! : current.access,
        writeBack: has("writeBack") ? patch.writeBack! : current.writeBack,
        refresh: has("refresh") ? patch.refresh! : current.refresh,
      };
      const candidate = current.type === "repo-md"
        ? this.canonicalize({ ...base, type: "repo-md", localPath: patch.localPath ?? current.localPath }, current.id)
        : this.canonicalize({
            ...base,
            type: "git-md",
            remoteUrl: patch.remoteUrl ?? current.remoteUrl!,
            branch: patch.branch ?? current.branch!,
            transport: has("transport") ? patch.transport! : current.transport!,
          }, current.id, current.localPath);

      const immutableChanged =
        candidate.repositoryIdentity !== current.repositoryIdentity ||
        candidate.remoteUrl !== (current.remoteUrl ?? null) ||
        candidate.localPath !== current.localPath ||
        candidate.branch !== (current.branch ?? null) ||
        candidate.circle !== current.circle;
      if (immutableChanged) throw new Error("source-identity-immutable: remove and create a new source id instead");

      const currentCanonical: CanonicalSourceConfig = {
        id: current.id,
        type: current.type,
        name: current.name,
        repositoryIdentity: current.repositoryIdentity,
        remoteUrl: current.remoteUrl ?? null,
        localPath: current.localPath,
        localPathKey: localPathOwnershipKey(current.localPath),
        branch: current.branch ?? null,
        circle: current.circle,
        autoDetect: current.autoDetect,
        include: current.include,
        exclude: current.exclude,
        repoMappings: current.repoMappings,
        access: current.access,
        transport: current.transport ?? null,
        writeBack: current.writeBack,
        refresh: current.refresh,
      };
      if (JSON.stringify(mutableConfig(candidate)) === JSON.stringify(mutableConfig(currentCanonical))) return current;

      const now = this.now();
      this.db.prepare(
        `UPDATE knowledge_sources SET
          name = ?, auto_detect = ?, include_json = ?, exclude_json = ?, repo_mappings_json = ?,
          allowed_caller_ids_json = ?, allowed_project_ids_json = ?, transport_schemes_json = ?,
          transport_hosts_json = ?, write_back = ?, refresh_mode = ?, refresh_interval_seconds = ?,
          config_version = config_version + 1, lease_fence = lease_fence + 1, updated_at = ?
        WHERE id = ? AND lifecycle = 'active'`,
      ).run(
        candidate.name,
        candidate.autoDetect ? 1 : 0,
        JSON.stringify(candidate.include),
        JSON.stringify(candidate.exclude),
        JSON.stringify(candidate.repoMappings),
        JSON.stringify(candidate.access.allowedCallerIds),
        JSON.stringify(candidate.access.allowedProjectIds),
        JSON.stringify(candidate.transport?.allowedUrlSchemes ?? []),
        JSON.stringify(candidate.transport?.allowedHosts ?? []),
        candidate.writeBack,
        candidate.refresh.mode,
        candidate.refresh.intervalSeconds ?? null,
        now,
        current.id,
      );
      return this.getSource(current.id, { includeTombstoned: true })!;
    });
    return txn();
  }

  listSources(options: SourceListOptions = {}): KnowledgeSource[] {
    const rows = options.includeTombstoned
      ? this.db.prepare(`SELECT * FROM knowledge_sources ORDER BY id ASC`).all()
      : this.db.prepare(`SELECT * FROM knowledge_sources WHERE lifecycle = 'active' ORDER BY id ASC`).all();
    return (rows as SourceRow[]).map(rowToSource);
  }

  getSource(id: string, options: SourceGetOptions = {}): KnowledgeSource | null {
    const row = (options.includeTombstoned
      ? this.db.prepare(`SELECT * FROM knowledge_sources WHERE id = ?`).get(id)
      : this.db.prepare(`SELECT * FROM knowledge_sources WHERE id = ? AND lifecycle = 'active'`).get(id)) as SourceRow | undefined;
    return row ? rowToSource(row) : null;
  }

  removeSource(id: string): KnowledgeSource | null {
    const sourceId = requireNonemptyString(id, "id");
    const txn = this.db.immediateTransaction(() => {
      const current = this.getSource(sourceId, { includeTombstoned: true });
      if (!current) return null;
      if (current.lifecycle === "tombstoned") return current;
      const now = this.now();
      this.db.prepare(
        `UPDATE knowledge_sources SET lifecycle = 'tombstoned', lease_fence = lease_fence + 1,
          updated_at = ?, tombstoned_at = ? WHERE id = ? AND lifecycle = 'active'`,
      ).run(now, now, sourceId);
      return this.getSource(sourceId, { includeTombstoned: true })!;
    });
    return txn();
  }

  authorizeSource(sourceId: string, callerId: string, projectId: string): boolean;
  authorizeSource(sourceId: string, context: SourceAuthorizationContext): boolean;
  authorizeSource(sourceId: string, callerOrContext: string | SourceAuthorizationContext, projectId?: string): boolean {
    const context = typeof callerOrContext === "string"
      ? { callerId: callerOrContext, projectId: projectId ?? "" }
      : callerOrContext;
    const source = this.getSource(sourceId);
    if (!source) return false;
    return source.access.allowedCallerIds.includes(context.callerId) && source.access.allowedProjectIds.includes(context.projectId);
  }
}
