import type { EffectiveSourceScanConfig } from "./source-scanner";
import type { SourceChunkMetadata } from "./source-chunker";

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
  /** Last source config atomically activated by the ledger, or null before first publication. */
  appliedConfigVersion: number | null;
  activeRunId: string | null;
  activeSnapshotId: string | null;
  activeIngestConfigHash: string | null;
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

/** Trusted connector-facing projection. Access policy and repository roots are never exposed. */
export interface ConnectorSourceSummary {
  id: string;
  type: SourceType;
  name: string;
  branch?: string;
  refresh: SourceRefreshPolicy;
}

export interface ConnectorSourceStatus {
  id: string;
  type: SourceType;
  branch?: string;
  lastAttemptAt?: number;
  lastSyncResult: "success" | "failed" | "partial" | "never";
  lastSuccessfulSyncAt?: number;
  indexedRevision?: string;
  freshness: "fresh" | "stale" | "unknown";
  filesIndexed: number;
  chunksIndexed: number;
  dirtyFiles: number;
  lastError?: string;
}

export interface ConnectorSourcePath {
  sourceId: string;
  type: SourceType;
  path: string;
  snapshotPath: string;
  revision: string;
  guidance: string;
}

/** Exact config/fence tuple a future sync planner must capture before doing work. */
export interface SourceRunFence {
  sourceId: string;
  configVersion: number;
  leaseFence: number;
}

export type SourceSyncRunState = "scanning" | "staging" | "activating" | "published" | "cleaning" | "cleaned" | "aborted";
export type SourceSyncRunResult = "success" | "failed" | "partial";
export type SourceChunkWriteState = "intent" | "engine-written" | "committed" | "skipped";

export interface SourceSyncRun {
  id: string;
  sourceId: string;
  snapshotId: string;
  ingestConfigHash: string;
  /** Schema/parser version for effectiveConfig; independent of the registry configVersion fence. */
  scanConfigVersion: string;
  effectiveConfig: EffectiveSourceScanConfig;
  configVersion: number;
  leaseFence: number;
  complete: boolean;
  state: SourceSyncRunState;
  result: SourceSyncRunResult | null;
  reason: string | null;
  activationToken: string | null;
  manifestHash: string | null;
  fileCount: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  finishedAt: number | null;
}

export interface BeginSourceRunInput {
  sourceId: string;
  snapshotId: string;
  /** Required by remote pipelines to close the pin-to-ledger concurrency gap atomically. */
  expectedConfigVersion?: number;
  /** Required by remote pipelines to close the pin-to-ledger concurrency gap atomically. */
  expectedLeaseFence?: number;
}

export type BeginSourceRunResult =
  | { kind: "noop"; source: KnowledgeSource }
  | { kind: "started"; run: SourceSyncRun };

export interface SourceManifestFileInput {
  relativePath: string;
  type: "file";
  contentHash: string;
  byteLength: number;
}

/** Independent durable proof for an already-published sealed source tree. */
export interface SourcePublishedManifest {
  sourceId: string;
  runId: string;
  snapshotId: string;
  ingestConfigHash: string;
  configVersion: number;
  leaseFence: number;
  manifestHash: string;
  files: SourceManifestFileInput[];
}

export interface SourceManifestChunkInput {
  bindingId: string;
  /** Monotone staged-attempt incarnation; aborted attempts reserve their generation permanently. */
  bindingGeneration: number;
  operationId: string;
  relativePath: string;
  headingPath: string[];
  occurrence: number;
  segmentIndex: number;
  contentHash: string;
  ingestFingerprint: string;
  metadata: SourceChunkMetadata;
  sourceRef: string;
  content: string;
  /** Explicit proof for carrying one active binding across a changed natural identity. */
  bindingIdHint?: { bindingId: string; priorRunId: string };
}

export interface StageSourceManifestInput {
  runId: string;
  scanStatus: "complete" | "partial";
  manifestHash: string;
  files: SourceManifestFileInput[];
  chunks: SourceManifestChunkInput[];
}

export interface RecordSourceBindingReceiptInput {
  runId: string;
  bindingId: string;
  conceptId?: string | null;
  observationId?: string | null;
  predecessorObservationId?: string | null;
  writeState: Exclude<SourceChunkWriteState, "intent">;
}

export interface PublishSourceRunInput {
  runId: string;
  activationToken: string;
  expectedManifestHash?: string;
}

export interface SourceFileRecord extends SourceManifestFileInput {
  sourceId: string;
  runId: string;
  snapshotId: string;
  configVersion: number;
}

export interface SourceChunkRecord extends SourceManifestChunkInput {
  sourceId: string;
  runId: string;
  snapshotId: string;
  configVersion: number;
  conceptId: string | null;
  observationId: string | null;
  predecessorObservationId: string | null;
  writeState: SourceChunkWriteState;
  lifecycle: "active" | "superseded" | "deleted" | null;
}

export interface SourceCleanupItem {
  id: string;
  sourceId: string;
  runId: string;
  /** Quarantine items diagnose foreign ownership and never authorize engine retirement/supersession. */
  kind: "retire-absent" | "reconcile-orphan" | "quarantine-non-authorizing";
  bindingId: string;
  operationId: string | null;
  conceptId: string | null;
  observationId: string | null;
  predecessorObservationId: string | null;
  createdAt: number;
  acknowledgedAt: number | null;
}

export interface SourceRemoval {
  sourceId: string;
  runId: string | null;
  snapshotId: string | null;
  ingestConfigHash: string | null;
  state: "retiring" | "files-revoked" | "complete";
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface SourceRemovalItem {
  id: string;
  sourceId: string;
  runId: string;
  bindingId: string;
  conceptId: string;
  observationId: string;
  acknowledgedAt: number | null;
}
