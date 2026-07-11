/** Durable source kinds supported by the P0 registry. */
export type SourceType = "repo-md" | "git-md";

export type SourceWriteBack = "none" | "pull-request";
export type SourceRefreshMode = "manual" | "interval";
export type SourceLifecycle = "active" | "tombstoned";
export type SourceStatus = "pending-initial-sync" | "active" | "pending-replacement" | "tombstoned";
export type SourceTransportScheme = "https" | "ssh";

export interface SourceAccessPolicy {
  allowedCallerIds: string[];
  allowedProjectIds: string[];
}

export interface SourceTransportPolicy {
  allowedUrlSchemes: SourceTransportScheme[];
  allowedHosts: string[];
}

export interface SourceRefreshPolicy {
  mode: SourceRefreshMode;
  intervalSeconds?: number;
}

export interface SourceRepoMapping {
  repo: string;
  paths?: string[];
}

interface CreateSourceBase {
  /** Optional caller-chosen stable id. Omit to allocate one. */
  id?: string;
  name: string;
  /** Canonical repository identity, or an explicit opaque identity for a repo without a remote. */
  repositoryIdentity?: string;
  circle: string;
  autoDetect?: boolean;
  include?: string[];
  exclude?: string[];
  repoMappings?: SourceRepoMapping[];
  access: SourceAccessPolicy;
  writeBack?: SourceWriteBack;
  refresh?: SourceRefreshPolicy;
}

export interface CreateRepoMdSource extends CreateSourceBase {
  type: "repo-md";
  /** Existing user-owned repository root. The registry canonicalizes but never creates or deletes it. */
  localPath: string;
  remoteUrl?: never;
  branch?: never;
  transport?: never;
}

export interface CreateGitMdSource extends CreateSourceBase {
  type: "git-md";
  remoteUrl: string;
  branch: string;
  transport: SourceTransportPolicy;
  /** Monet allocates localPath; callers cannot choose a checkout location. */
  localPath?: never;
}

export type CreateSourceInput = CreateRepoMdSource | CreateGitMdSource;

/**
 * Runtime updates accept immutable keys so JavaScript callers receive a precise
 * source-identity-immutable error. TypeScript callers should normally pass only mutable keys.
 */
export type UpdateSourceInput = Partial<
  Omit<CreateSourceBase, "id"> & {
    id: string;
    type: SourceType;
    localPath: string;
    remoteUrl: string;
    branch: string;
    transport: SourceTransportPolicy;
  }
>;

export interface KnowledgeSource {
  id: string;
  type: SourceType;
  name: string;
  repositoryIdentity: string;
  remoteUrl?: string;
  localPath: string;
  branch?: string;
  circle: string;
  autoDetect: boolean;
  include: string[];
  exclude: string[];
  repoMappings: SourceRepoMapping[];
  access: SourceAccessPolicy;
  transport?: SourceTransportPolicy;
  writeBack: SourceWriteBack;
  refresh: SourceRefreshPolicy;
  configVersion: number;
  /** Remains null in the registry slice; a future atomic activation promotes it. */
  appliedConfigVersion: number | null;
  /** Advanced by every config mutation and by tombstoning to fence future runs. */
  leaseFence: number;
  lifecycle: SourceLifecycle;
  status: SourceStatus;
  createdAt: number;
  updatedAt: number;
  tombstonedAt: number | null;
}

export interface SourceListOptions {
  includeTombstoned?: boolean;
}

export interface SourceGetOptions {
  includeTombstoned?: boolean;
}

export interface SourceAuthorizationContext {
  callerId: string;
  projectId: string;
}

/** Exact config/fence tuple a future sync planner must capture before doing work. */
export interface SourceRunFence {
  sourceId: string;
  configVersion: number;
  leaseFence: number;
}
