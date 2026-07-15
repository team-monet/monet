import { randomUUID } from "node:crypto";
import type { IngestResult, SourceConceptRollbackResult } from "./engine";
import {
  detectRepoMdRenames, materializeGitMdCommit, materializeRepoMdCommit, materializeRepoMdHead, pointSourceCurrent,
  removeSourceMaterializations, sourceSnapshotPath, revokeSourceCurrent, validateSourceMaterializationRemoval, validateSourcePublishedPath,
  withGitMdMaterializerLock, withRepoMdMaterializerLock,
} from "./source-materializer";
import type { RepoMdMaterializerOptions } from "./source-materializer";
import { syncManagedGitRepository, validateManagedGitRepository } from "./source-git";
import type { RemoteGitOptions } from "./source-git";
import { computeSourceOperationId } from "./source-chunker";
import { computeSourceIngestConfigHash, scanSourceSnapshot } from "./source-scanner";
import type { SourceScanDiagnostic, SourceScanResult } from "./source-scanner";
import type {
  BeginSourceRunInput, BeginSourceRunResult, KnowledgeSource, PublishSourceRunInput,
  RecordSourceBindingReceiptInput, SourceChunkRecord, SourceCleanupItem, SourceFileRecord,
  SourceSyncRun, StageSourceManifestInput,
  SourceRemoval, SourceRemovalItem,
  SourcePublishedManifest,
} from "./source-types";

export type RepoMdSyncFaultPoint =
  | "after-pin" | "after-begin" | "after-stage" | "after-store" | "after-engine-written"
  | "after-refresh" | "after-committed" | "after-activation" | "after-publish" | "after-current" | "after-cleanup"
  | "after-noop-verification"
  | "after-remove-current" | "after-remove-item" | "after-remove-snapshots"
  | "before-remove-complete" | "after-remove-complete";

type CallerMaterializerOptions = Omit<Partial<RepoMdMaterializerOptions>, "sourceStorageDir" | "config" | "lockStaleMs" | "now" | "assertOwnership">;

export interface RepoMdSyncOptions {
  lockStaleMs?: number;
  fault?: (point: RepoMdSyncFaultPoint) => void;
  materializer?: CallerMaterializerOptions;
}

export interface RepoMdSyncResult {
  sourceId: string;
  snapshotId: string | null;
  runId: string | null;
  status: "noop" | "published" | "partial" | "aborted" | "removed";
  diagnostics: SourceScanDiagnostic[];
}

export interface SourceSyncCorePort {
  getSource(sourceId: string, options?: { includeTombstoned?: boolean }): KnowledgeSource | null;
  beginSourceRun(input: BeginSourceRunInput): BeginSourceRunResult;
  resumeSourceRun(sourceId: string): SourceSyncRun | null;
  getSourceRun(runId: string): SourceSyncRun | null;
  stageSourceManifest(input: StageSourceManifestInput): SourceSyncRun;
  listSourceFiles(runId: string, published?: boolean): SourceFileRecord[];
  listSourceChunks(runId: string, published?: boolean): SourceChunkRecord[];
  listSourceCleanupItems(runId: string): SourceCleanupItem[];
  nextSourceBindingGeneration(sourceId: string, bindingId: string): number;
  recordSourceBindingReceipt(input: RecordSourceBindingReceiptInput): SourceChunkRecord;
  beginSourceActivation(runId: string): string;
  publishSourceRun(input: PublishSourceRunInput): SourceSyncRun;
  abortSourceRun(runId: string, result: "failed" | "partial", reason?: string): SourceSyncRun;
  acknowledgeSourceCleanup(itemId: string): SourceCleanupItem;
  storeSource(content: string, opts: {
    circle: string; sourceRefs: string[]; operationId: string;
    resolution?: "forceNew"; attachTo?: string;
  }): Promise<IngestResult>;
  refreshSourceConcept(conceptId: string, observationId: string, expectedActiveObservationId: string): Promise<unknown>;
  rollbackSourceRunBinding(runId: string, bindingId: string): Promise<SourceConceptRollbackResult>;
  supersedeObservation(observationId: string, successor?: string | null): unknown;
  retireConcept(conceptId: string): unknown;
  beginSourceRemoval(sourceId: string): SourceRemoval;
  getSourceRemoval(sourceId: string): SourceRemoval | null;
  listSourceRemovalItems(sourceId: string): SourceRemovalItem[];
  acknowledgeSourceRemovalItem(itemId: string): SourceRemovalItem;
  markSourceRemovalFilesRevoked(sourceId: string): SourceRemoval;
  completeSourceRemoval(sourceId: string): SourceRemoval;
  recordSourcePrePinFailure(input: { sourceId: string; reason: string; configVersion: number; leaseFence: number }): number;
  recordSourceRunInvocation(input: {
    sourceId: string; runId: string; result: "success" | "failed" | "partial";
    reason?: string; configVersion: number; leaseFence: number;
  }): number;
  recordSourceVerification(input: {
    sourceId: string; runId: string; snapshotId: string; ingestConfigHash: string;
    configVersion: number; leaseFence: number;
  }): number;
  validateSourceActivePublication(sourceId: string, runId: string, snapshotId: string, ingestConfigHash: string): void;
  getSourcePublishedManifest(sourceId: string, runId: string, snapshotId: string, ingestConfigHash: string): SourcePublishedManifest;
}

interface RuntimeOptions extends RepoMdSyncOptions {
  sourceStorageDir: string;
  idGen?: () => string;
  /** Connector authorization/lifecycle fence, run inside the lock before any recovery or mutation. */
  preflight?: () => void;
  scan?: typeof scanSourceSnapshot;
  remoteGit?: RemoteGitOptions;
  /** Internal exact source-lock fence; never caller-controlled. */
  assertOwnership?: () => void;
  /** Scheduler-only admission, evaluated after acquiring the exact per-source lock. */
  scheduledAdmission?: (source: KnowledgeSource, resumable: SourceSyncRun | null) => boolean;
  scheduledFence?: { configVersion: number; leaseFence: number };
  /** Nonthrowing scheduler-lease assertion supplied only by privileged maintenance dispatch. */
  scheduledAssertLeaseOwner?: () => boolean;
}

const SCHEDULED_SYNC_SKIPPED = Symbol("scheduled-sync-skipped");
type InternalSyncResult = RepoMdSyncResult | typeof SCHEDULED_SYNC_SKIPPED;

class SourceSchedulerLeaseLostError extends Error {
  constructor() { super("source scheduler lease ownership was lost"); }
}

function assertScheduledLease(options: RuntimeOptions): void {
  if (!options.scheduledAssertLeaseOwner) return;
  let owned = false;
  try { owned = options.scheduledAssertLeaseOwner(); } catch { owned = false; }
  if (!owned) throw new SourceSchedulerLeaseLostError();
}

function isSchedulerLeaseLost(error: unknown): boolean {
  return error instanceof SourceSchedulerLeaseLostError;
}

function assertRuntimeOwnership(options: RuntimeOptions): void {
  options.assertOwnership?.();
}

const naturalKey = (chunk: Pick<SourceChunkRecord, "relativePath" | "headingPath" | "occurrence" | "segmentIndex">): string =>
  JSON.stringify([chunk.relativePath, chunk.headingPath, chunk.occurrence, chunk.segmentIndex]);

function requireSourceLineage(core: SourceSyncCorePort, sourceId: string, type: KnowledgeSource["type"]): KnowledgeSource {
  const source = core.getSource(sourceId, { includeTombstoned: true });
  if (!source || source.type !== type) {
    throw new Error(`sync${type === "git-md" ? "Git" : "Repo"}MdSource requires a registered ${type} source lineage`);
  }
  return source;
}

function requireActiveSource(core: SourceSyncCorePort, sourceId: string, type: KnowledgeSource["type"]): KnowledgeSource {
  const source = requireSourceLineage(core, sourceId, type);
  if (source.lifecycle !== "active") {
    throw new Error(`sync${type === "git-md" ? "Git" : "Repo"}MdSource requires an active registered ${type} source`);
  }
  return source;
}

function gitMdSourceSignature(source: KnowledgeSource): string {
  return JSON.stringify({
    type: source.type, lifecycle: source.lifecycle, remoteUrl: source.remoteUrl, branch: source.branch,
    transport: source.transport, localPath: source.localPath, configVersion: source.configVersion,
    leaseFence: source.leaseFence, autoDetect: source.autoDetect, include: source.include, exclude: source.exclude,
    repoMappings: source.repoMappings,
  });
}

function requireUnchangedGitMdSource(core: SourceSyncCorePort, sourceId: string, expected: string): KnowledgeSource {
  const current = requireActiveSource(core, sourceId, "git-md");
  if (gitMdSourceSignature(current) !== expected) throw new Error("git-md source changed during remote synchronization");
  return current;
}

function requireExactActivePublication(
  core: SourceSyncCorePort,
  source: KnowledgeSource,
  expectedSignature: string,
): KnowledgeSource {
  const current = requireUnchangedGitMdSource(core, source.id, expectedSignature);
  if (!source.activeRunId || !source.activeSnapshotId || !source.activeIngestConfigHash
      || current.activeRunId !== source.activeRunId || current.activeSnapshotId !== source.activeSnapshotId
      || current.activeIngestConfigHash !== source.activeIngestConfigHash) {
    throw new Error("git-md active publication changed during local recovery");
  }
  core.validateSourceActivePublication(
    current.id, current.activeRunId, current.activeSnapshotId, current.activeIngestConfigHash,
  );
  return current;
}

function activePublishedManifest(core: SourceSyncCorePort, source: KnowledgeSource): SourcePublishedManifest {
  if (!source.activeRunId || !source.activeSnapshotId || !source.activeIngestConfigHash) {
    throw new Error("git-md active publication metadata is incomplete");
  }
  return core.getSourcePublishedManifest(
    source.id, source.activeRunId, source.activeSnapshotId, source.activeIngestConfigHash,
  );
}

/** Restore only the stable pointer from an already-published sealed variant, before any remote work. */
function repairGitMdActivePublication(
  core: SourceSyncCorePort,
  source: KnowledgeSource,
  options: RuntimeOptions,
  materializer: RepoMdMaterializerOptions,
): KnowledgeSource {
  if (!source.activeRunId && !source.activeSnapshotId && !source.activeIngestConfigHash) return source;
  if (!source.activeRunId || !source.activeSnapshotId || !source.activeIngestConfigHash) {
    throw new Error("git-md active publication metadata is incomplete");
  }
  const expectedSignature = gitMdSourceSignature(source);
  requireExactActivePublication(core, source, expectedSignature);
  const revalidate = (): void => {
    options.preflight?.();
    requireExactActivePublication(core, source, expectedSignature);
  };
  let publishedPathValid = false;
  const publication = activePublishedManifest(core, source);
  try {
    validateSourcePublishedPath(source, source.activeSnapshotId, source.activeIngestConfigHash, options.sourceStorageDir, publication);
    publishedPathValid = true;
  } catch { /* The sealed variant is revalidated below before any pointer repair. */ }
  if (!publishedPathValid) {
    pointSourceCurrent(source, source.activeSnapshotId, source.activeIngestConfigHash, {
      ...materializer,
      fault: (point) => {
        materializer.fault?.(point);
        revalidate();
      },
    }, publication);
  }
  revalidate();
  validateSourcePublishedPath(source, source.activeSnapshotId, source.activeIngestConfigHash, options.sourceStorageDir, publication);
  revalidate();
  validateSourcePublishedPath(source, source.activeSnapshotId, source.activeIngestConfigHash, options.sourceStorageDir, publication);
  return requireExactActivePublication(core, source, expectedSignature);
}

async function materializeCommit(source: KnowledgeSource, snapshotId: string, options: RepoMdMaterializerOptions) {
  return source.type === "git-md"
    ? materializeGitMdCommit(source, snapshotId, options)
    : materializeRepoMdCommit(source, snapshotId, options);
}

function materializerOptions(options: RuntimeOptions): RepoMdMaterializerOptions {
  const {
    sourceStorageDir: _callerStorage, config: _callerConfig, lockStaleMs: _callerLock,
    now: _callerClock, ...caller
  } = (options.materializer ?? {}) as Partial<RepoMdMaterializerOptions>;
  return {
    ...caller,
    sourceStorageDir: options.sourceStorageDir,
    lockStaleMs: options.lockStaleMs,
    ...(options.assertOwnership ? { assertOwnership: options.assertOwnership } : {}),
  };
}

const fileRelativeKey = (chunk: Pick<SourceChunkRecord, "headingPath" | "occurrence" | "segmentIndex">): string =>
  JSON.stringify([chunk.headingPath, chunk.occurrence, chunk.segmentIndex]);

async function planManifest(
  core: SourceSyncCorePort,
  source: KnowledgeSource,
  run: SourceSyncRun,
  scan: SourceScanResult,
  idGen: () => string,
  repositoryRoot: string,
  materializer: Pick<RepoMdMaterializerOptions, "execFile" | "localGitTimeoutMs" | "gitExecutable">,
): Promise<StageSourceManifestInput> {
  const active = source.activeRunId ? core.listSourceChunks(source.activeRunId, true) : [];
  const activeChunks = active.filter((chunk) => chunk.lifecycle === "active");
  const byIdentity = new Map(activeChunks.map((chunk) => [naturalKey(chunk), chunk]));
  const consumed = new Set<string>();
  const priorRun = source.activeRunId ? core.getSourceRun(source.activeRunId) : null;
  const priorFiles = source.activeRunId ? core.listSourceFiles(source.activeRunId, true) : [];
  const priorPaths = new Set(priorFiles.map((file) => file.relativePath));
  const nextPaths = new Set(scan.files.map((file) => file.relativePath));
  const deletedPaths = new Set([...priorPaths].filter((path) => !nextPaths.has(path)));
  const addedPaths = new Set([...nextPaths].filter((path) => !priorPaths.has(path)));
  const movedToFrom = new Map<string, string>();
  if (priorRun && priorRun.scanConfigVersion === run.scanConfigVersion && deletedPaths.size && addedPaths.size) {
    // Git rename evidence is advisory. A resumed run may outlive replacement of
    // its managed repository; publication must still converge using the durable
    // manifests instead of wedging on unavailable/poisoned diff evidence.
    let gitMoves = new Map<string, string>();
    try {
      if (source.type === "git-md") validateManagedGitRepository(repositoryRoot);
      gitMoves = await detectRepoMdRenames(
        repositoryRoot, priorRun.snapshotId, run.snapshotId, priorPaths, nextPaths, {
          execFile: materializer.execFile,
          ...(source.type === "git-md" ? {
            timeoutMs: materializer.localGitTimeoutMs ?? 120_000,
            gitExecutable: materializer.gitExecutable,
          } : {}),
        },
      );
    } catch {
      gitMoves = new Map();
    }
    const usedOld = new Set<string>();
    const usedNew = new Set<string>();
    for (const [from, to] of gitMoves) {
      if (!deletedPaths.has(from) || !addedPaths.has(to) || usedOld.has(from) || usedNew.has(to)) continue;
      movedToFrom.set(to, from); usedOld.add(from); usedNew.add(to);
    }
    // Content proof is intentionally stricter and is disabled by any effective ingest-config change.
    if (priorRun.ingestConfigHash === run.ingestConfigHash) {
      const oldByHash = new Map<string, Array<{ relativePath: string }>>();
      const newByHash = new Map<string, Array<{ relativePath: string }>>();
      // Uniqueness is global across both complete selected manifests. Restricting
      // this count to their deleted/added subsets would falsely move one member
      // of a duplicate family while an identical retained file still exists.
      for (const file of priorFiles) {
        const list = oldByHash.get(file.contentHash) ?? []; list.push(file); oldByHash.set(file.contentHash, list);
      }
      for (const file of scan.files) {
        const list = newByHash.get(file.contentHash) ?? []; list.push(file); newByHash.set(file.contentHash, list);
      }
      for (const [hash, oldFiles] of oldByHash) {
        const newFiles = newByHash.get(hash) ?? [];
        const oldPath = oldFiles[0]?.relativePath;
        const newPath = newFiles[0]?.relativePath;
        if (oldFiles.length === 1 && newFiles.length === 1 && oldPath && newPath
            && deletedPaths.has(oldPath) && addedPaths.has(newPath)
            && !usedOld.has(oldPath) && !usedNew.has(newPath)) {
          movedToFrom.set(newPath, oldPath);
        }
      }
    }
  }
  const movedChunk = new Map<string, SourceChunkRecord>();
  for (const prior of activeChunks) movedChunk.set(JSON.stringify([prior.relativePath, fileRelativeKey(prior)]), prior);
  const chunks = scan.chunks.map((chunk) => {
    let prior = byIdentity.get(naturalKey(chunk));
    let changedIdentity = false;
    if (prior && !consumed.has(prior.bindingId)) consumed.add(prior.bindingId);
    else {
      prior = undefined;
      const oldPath = movedToFrom.get(chunk.relativePath);
      const candidate = oldPath ? movedChunk.get(JSON.stringify([oldPath, fileRelativeKey(chunk)])) : undefined;
      if (candidate && !consumed.has(candidate.bindingId)) {
        prior = candidate;
        changedIdentity = true;
        consumed.add(candidate.bindingId);
      }
    }
    const bindingId = prior?.bindingId ?? idGen();
    const bindingGeneration = core.nextSourceBindingGeneration(source.id, bindingId);
    return {
      bindingId,
      bindingGeneration,
      operationId: computeSourceOperationId(source.id, bindingId, chunk.ingestFingerprint, run.snapshotId, bindingGeneration),
      relativePath: chunk.relativePath,
      headingPath: [...chunk.headingPath],
      occurrence: chunk.occurrence,
      segmentIndex: chunk.segmentIndex,
      contentHash: chunk.contentHash,
      ingestFingerprint: chunk.ingestFingerprint,
      metadata: chunk.metadata,
      sourceRef: `source://${source.id}/${chunk.sourceRef}`,
      content: chunk.body,
      ...(changedIdentity && prior ? { bindingIdHint: { bindingId: prior.bindingId, priorRunId: prior.runId } } : {}),
    };
  });
  return { runId: run.id, scanStatus: "complete", manifestHash: scan.manifestHash, files: scan.files, chunks };
}

async function materializeStagedBindings(
  core: SourceSyncCorePort,
  source: KnowledgeSource,
  run: SourceSyncRun,
  options: RuntimeOptions,
): Promise<void> {
  const active = source.activeRunId ? core.listSourceChunks(source.activeRunId, true) : [];
  const priorByBinding = new Map(active.filter((chunk) => chunk.lifecycle === "active").map((chunk) => [chunk.bindingId, chunk]));
  for (let staged of core.listSourceChunks(run.id)) {
    if (staged.writeState === "skipped" || staged.writeState === "committed") continue;
    const prior = priorByBinding.get(staged.bindingId);
    if (staged.writeState === "intent" && prior && prior.ingestFingerprint === staged.ingestFingerprint
        && prior.contentHash === staged.contentHash && prior.sourceRef === staged.sourceRef) {
      assertRuntimeOwnership(options);
      core.recordSourceBindingReceipt({ runId: run.id, bindingId: staged.bindingId, writeState: "skipped" });
      continue;
    }
    if (staged.writeState === "intent") {
      assertRuntimeOwnership(options);
      const stored = await core.storeSource(staged.content, {
        circle: source.circle,
        sourceRefs: [staged.sourceRef],
        operationId: staged.operationId,
        ...(prior?.conceptId ? { attachTo: prior.conceptId } : { resolution: "forceNew" as const }),
      });
      options.fault?.("after-store");
      assertRuntimeOwnership(options);
      staged = core.recordSourceBindingReceipt({
        runId: run.id, bindingId: staged.bindingId, conceptId: stored.conceptId,
        observationId: stored.observationId, predecessorObservationId: prior?.observationId ?? null,
        writeState: "engine-written",
      });
      options.fault?.("after-engine-written");
    }
    if (!staged.conceptId || !staged.observationId) throw new Error("staged source receipt is incomplete");
    if (staged.predecessorObservationId) {
      assertRuntimeOwnership(options);
      await core.refreshSourceConcept(staged.conceptId, staged.observationId, staged.predecessorObservationId);
      options.fault?.("after-refresh");
    }
    assertRuntimeOwnership(options);
    core.recordSourceBindingReceipt({ runId: run.id, bindingId: staged.bindingId, writeState: "committed" });
    options.fault?.("after-committed");
  }
}

/** Tombstoned recovery may converge existing writes, but must never create new evidence. */
async function reconcileExistingStagedBindings(
  core: SourceSyncCorePort,
  run: SourceSyncRun,
  options: RuntimeOptions,
): Promise<void> {
  for (const staged of core.listSourceChunks(run.id)) {
    if (staged.writeState !== "engine-written") continue;
    if (!staged.conceptId || !staged.observationId) throw new Error("engine-written source receipt is incomplete");
    if (staged.predecessorObservationId) {
      assertRuntimeOwnership(options);
      await core.refreshSourceConcept(staged.conceptId, staged.observationId, staged.predecessorObservationId);
      options.fault?.("after-refresh");
    }
    assertRuntimeOwnership(options);
    core.recordSourceBindingReceipt({ runId: run.id, bindingId: staged.bindingId, writeState: "committed" });
    options.fault?.("after-committed");
  }
}

async function drainCleanup(core: SourceSyncCorePort, run: SourceSyncRun, options: RuntimeOptions): Promise<void> {
  const stagedByBinding = new Map(core.listSourceChunks(run.id).map((chunk) => [chunk.bindingId, chunk]));
  for (const item of core.listSourceCleanupItems(run.id)) {
    if (item.acknowledgedAt !== null) continue;
    if (item.kind === "quarantine-non-authorizing") {
      assertRuntimeOwnership(options);
      core.acknowledgeSourceCleanup(item.id);
    } else if (!item.conceptId || !item.observationId) {
      throw new Error("authorized source cleanup is missing engine evidence IDs");
    } else if (item.kind === "retire-absent" || item.predecessorObservationId === null) {
      assertRuntimeOwnership(options);
      core.supersedeObservation(item.observationId, null);
      assertRuntimeOwnership(options);
      core.retireConcept(item.conceptId);
      assertRuntimeOwnership(options);
      core.acknowledgeSourceCleanup(item.id);
    } else {
      const staged = stagedByBinding.get(item.bindingId);
      if (staged?.writeState === "committed") {
        assertRuntimeOwnership(options);
        await core.rollbackSourceRunBinding(run.id, item.bindingId);
      } else {
        assertRuntimeOwnership(options);
        core.supersedeObservation(item.observationId, null);
      }
      assertRuntimeOwnership(options);
      core.acknowledgeSourceCleanup(item.id);
    }
    options.fault?.("after-cleanup");
  }
}

function isFenceError(error: unknown): boolean {
  return error instanceof Error && /fence is stale/.test(error.message);
}

function isRecoverableGitCommitAvailabilityError(error: unknown): boolean {
  return error instanceof Error
    && !/deadline|timed out|lock ownership|source changed/i.test(error.message)
    && /managed git-md repository|fsck|rev-parse|commit is unavailable|unavailable or changed|ENOENT/i.test(error.message);
}

function recordPrePinFailure(
  core: SourceSyncCorePort, source: KnowledgeSource, error: unknown, assertOwnership: () => void,
): void {
  try {
    assertOwnership();
    core.recordSourcePrePinFailure({
      sourceId: source.id, reason: error instanceof Error ? error.message : String(error),
      configVersion: source.configVersion, leaseFence: source.leaseFence,
    });
  } catch { /* A stale failure receipt must never mask the primary repair/fetch/fence failure. */ }
}

function verifyUnchangedPublication(
  core: SourceSyncCorePort,
  active: KnowledgeSource,
  snapshotId: string,
  options: RuntimeOptions,
  materializer: RepoMdMaterializerOptions,
  mutate: () => void,
  onVerified: () => void = () => undefined,
): RepoMdSyncResult {
  if (!active.activeRunId || !active.activeSnapshotId || !active.activeIngestConfigHash) {
    throw new Error("unchanged source is missing its active publication tuple");
  }
  const publication = active.type === "git-md" ? activePublishedManifest(core, active) : undefined;
  pointSourceCurrent(active, active.activeSnapshotId, active.activeIngestConfigHash, materializer, publication);
  options.preflight?.();
  validateSourcePublishedPath(active, active.activeSnapshotId, active.activeIngestConfigHash, options.sourceStorageDir, publication);
  options.preflight?.();
  validateSourcePublishedPath(active, active.activeSnapshotId, active.activeIngestConfigHash, options.sourceStorageDir, publication);
  mutate();
  core.recordSourceVerification({
    sourceId: active.id, runId: active.activeRunId, snapshotId: active.activeSnapshotId,
    ingestConfigHash: active.activeIngestConfigHash,
    configVersion: active.configVersion, leaseFence: active.leaseFence,
  });
  onVerified();
  options.fault?.("after-noop-verification");
  return { sourceId: active.id, snapshotId, runId: null, status: "noop", diagnostics: [] };
}

async function recoverRemovedRepoSource(
  core: SourceSyncCorePort,
  run: SourceSyncRun,
  options: RuntimeOptions,
): Promise<void> {
  if (run.state === "scanning") {
    assertRuntimeOwnership(options);
    run = core.abortSourceRun(run.id, "failed", "source lifecycle is no longer active");
  } else if (run.state === "staging") {
    await reconcileExistingStagedBindings(core, run, options);
    assertRuntimeOwnership(options);
    run = core.abortSourceRun(run.id, "failed", "source lifecycle is no longer active");
  } else if (run.state === "activating") {
    assertRuntimeOwnership(options);
    run = core.abortSourceRun(run.id, "failed", "source lifecycle is no longer active");
  }
  if (run.state === "aborted" || run.state === "cleaning") await drainCleanup(core, run, options);
}

async function removeTombstonedRepoSource(
  core: SourceSyncCorePort,
  source: KnowledgeSource,
  options: RuntimeOptions,
): Promise<RepoMdSyncResult> {
  assertRuntimeOwnership(options);
  // Reject every unsafe nested node before the ledger creates removal intent/items.
  // Destructive cleanup repeats this preflight at its own mutation boundary.
  validateSourceMaterializationRemoval(source, options.sourceStorageDir, options.materializer?.safeTreeOps);
  let removal = core.beginSourceRemoval(source.id);
  if (removal.state !== "complete") {
    revokeSourceCurrent(source, options.sourceStorageDir, assertRuntimeOwnership.bind(null, options), options.materializer?.safeTreeOps);
    options.fault?.("after-remove-current");
    for (const item of core.listSourceRemovalItems(source.id)) {
      if (item.acknowledgedAt !== null) continue;
      assertRuntimeOwnership(options);
      core.supersedeObservation(item.observationId, null);
      assertRuntimeOwnership(options);
      core.retireConcept(item.conceptId);
      assertRuntimeOwnership(options);
      core.acknowledgeSourceRemovalItem(item.id);
      options.fault?.("after-remove-item");
    }
    removeSourceMaterializations(source, options.sourceStorageDir, assertRuntimeOwnership.bind(null, options), options.materializer?.safeTreeOps);
    options.fault?.("after-remove-snapshots");
    assertRuntimeOwnership(options);
    removal = core.markSourceRemovalFilesRevoked(source.id);
    options.fault?.("before-remove-complete");
    assertRuntimeOwnership(options);
    removal = core.completeSourceRemoval(source.id);
    options.fault?.("after-remove-complete");
  }
  return {
    sourceId: source.id, snapshotId: removal.snapshotId, runId: removal.runId,
    status: "removed", diagnostics: [],
  };
}

/** Resumable repo-md committed-HEAD pipeline. The ledger is always consulted before HEAD. */
export async function syncRepoMdSource(
  core: SourceSyncCorePort,
  sourceId: string,
  options: RuntimeOptions,
): Promise<RepoMdSyncResult> {
  const result = await syncSource(core, sourceId, options, "repo-md");
  if (result === SCHEDULED_SYNC_SKIPPED) throw new Error("scheduled admission is unavailable on public source sync");
  return result;
}

export type GitMdSyncOptions = RepoMdSyncOptions & { remoteGit?: RemoteGitOptions };
export type GitMdSyncResult = RepoMdSyncResult;

export async function syncGitMdSource(
  core: SourceSyncCorePort,
  sourceId: string,
  options: RuntimeOptions,
): Promise<GitMdSyncResult> {
  const result = await syncSource(core, sourceId, options, "git-md");
  if (result === SCHEDULED_SYNC_SKIPPED) throw new Error("scheduled admission is unavailable on public source sync");
  return result;
}

export async function syncScheduledRepoMdSource(
  core: SourceSyncCorePort,
  sourceId: string,
  options: RuntimeOptions,
): Promise<RepoMdSyncResult | null> {
  try {
    const result = await syncSource(core, sourceId, options, "repo-md");
    return result === SCHEDULED_SYNC_SKIPPED ? null : result;
  } catch (error) {
    if (isSchedulerLeaseLost(error)) return null;
    throw error;
  }
}

export async function syncScheduledGitMdSource(
  core: SourceSyncCorePort,
  sourceId: string,
  options: RuntimeOptions,
): Promise<RepoMdSyncResult | null> {
  try {
    const result = await syncSource(core, sourceId, options, "git-md");
    return result === SCHEDULED_SYNC_SKIPPED ? null : result;
  } catch (error) {
    if (isSchedulerLeaseLost(error)) return null;
    throw error;
  }
}

async function syncSource(
  core: SourceSyncCorePort,
  sourceId: string,
  options: RuntimeOptions,
  type: KnowledgeSource["type"],
): Promise<InternalSyncResult> {
  const mat = materializerOptions(options);
  const withLock = type === "git-md" ? withGitMdMaterializerLock : withRepoMdMaterializerLock;
  let durableRunObserved = false;
  let durableSuccessObserved = false;
  let prePinFailureRecorded = false;
  let coordinatorEntered = false;
  try {
  return await withLock(sourceId, mat, async ({ assertOwnership }) => {
    coordinatorEntered = true;
    let authorizedGitMdSignature: string | null = null;
    const assertAuthorizedOwnership = (): void => {
      assertOwnership();
      assertScheduledLease(options);
      options.preflight?.();
      if (type === "git-md" && authorizedGitMdSignature !== null) {
        requireUnchangedGitMdSource(core, sourceId, authorizedGitMdSignature);
      }
    };
    mat.assertOwnership = assertAuthorizedOwnership;
    const mutate = assertAuthorizedOwnership;
    const guardedOptions: RuntimeOptions = { ...options, assertOwnership: assertAuthorizedOwnership };
    assertAuthorizedOwnership();
    let source = requireSourceLineage(core, sourceId, type);
    let run = core.resumeSourceRun(sourceId);
    durableRunObserved = run !== null;
    let invocationRun = run;
    let invocationVerified = false;
    const recordCurrentPrePinFailure = (error: unknown): void => {
      if (prePinFailureRecorded) return;
      recordPrePinFailure(core, source, error, mutate);
      prePinFailureRecorded = true;
    };

    if (options.scheduledAdmission) {
      assertScheduledLease(options);
      if (!options.scheduledAdmission(source, run)) return SCHEDULED_SYNC_SKIPPED;
    }

    const execute = async (): Promise<RepoMdSyncResult> => {

    if (source.lifecycle !== "active") {
      if (run) await recoverRemovedRepoSource(core, run, guardedOptions);
      const stillResumable = core.resumeSourceRun(sourceId);
      if (stillResumable) throw new Error("tombstoned source recovery did not converge its resumable run");
      return removeTombstonedRepoSource(core, source, guardedOptions);
    }
    if (type === "git-md") authorizedGitMdSignature = gitMdSourceSignature(source);
    assertAuthorizedOwnership();

    if (type === "git-md") {
      try { source = repairGitMdActivePublication(core, source, guardedOptions, mat); }
      catch (error) {
        recordCurrentPrePinFailure(error);
        throw error;
      }
    }

    if (run?.state === "aborted") {
      await drainCleanup(core, run, guardedOptions);
      run = core.resumeSourceRun(sourceId);
    }
    if (run?.state === "cleaning") {
      source = requireActiveSource(core, sourceId, type);
      if (source.activeSnapshotId) {
        if (type !== "git-md") await materializeCommit(source, source.activeSnapshotId, { ...mat, config: run.effectiveConfig });
        pointSourceCurrent(source, source.activeSnapshotId, computeSourceIngestConfigHash(run.effectiveConfig), mat,
          type === "git-md" ? activePublishedManifest(core, source) : undefined);
      }
      await drainCleanup(core, run, guardedOptions);
      return { sourceId, snapshotId: source.activeSnapshotId, runId: run.id, status: "published", diagnostics: [] };
    }

    source = requireActiveSource(core, sourceId, type);
    if (source.activeSnapshotId && type !== "git-md") {
      const activeRun = source.activeRunId ? core.getSourceRun(source.activeRunId) : null;
      if (!activeRun) throw new Error("active repo-md source is missing its published run");
      await materializeCommit(source, source.activeSnapshotId, { ...mat, config: activeRun.effectiveConfig });
      pointSourceCurrent(source, source.activeSnapshotId, computeSourceIngestConfigHash(activeRun.effectiveConfig), mat);
    }

    if (!run) {
      try {
        let pinned;
        let gitMdFence: string | null = null;
        if (type === "git-md") {
          gitMdFence = gitMdSourceSignature(source);
          try {
            const oid = await syncManagedGitRepository(source, options.sourceStorageDir, options.remoteGit, () => {
              options.preflight?.();
              requireUnchangedGitMdSource(core, sourceId, gitMdFence!);
            }, assertAuthorizedOwnership);
            assertAuthorizedOwnership();
            source = requireUnchangedGitMdSource(core, sourceId, gitMdFence);
            pinned = await materializeGitMdCommit(source, oid, mat);
          } catch (error) {
            recordCurrentPrePinFailure(error);
            throw error;
          }
        } else pinned = await materializeRepoMdHead(source, mat);
        options.preflight?.();
        if (gitMdFence) source = requireUnchangedGitMdSource(core, sourceId, gitMdFence);
        options.fault?.("after-pin");
        mutate();
        const begun = core.beginSourceRun({
          sourceId, snapshotId: pinned.snapshotId,
          expectedConfigVersion: source.configVersion,
          expectedLeaseFence: source.leaseFence,
        });
        if (begun.kind === "noop") {
          return verifyUnchangedPublication(core, begun.source, pinned.snapshotId, options, mat, mutate, () => {
            invocationVerified = true; durableSuccessObserved = true;
          });
        }
        run = begun.run;
        durableRunObserved = true;
        invocationRun = run;
        options.fault?.("after-begin");
      } catch (error) {
        if (type === "repo-md" && !invocationRun && !durableRunObserved && !invocationVerified
            && !isSchedulerLeaseLost(error)) recordCurrentPrePinFailure(error);
        throw error;
      }
    }

    let runConfigHash = computeSourceIngestConfigHash(run.effectiveConfig);
    mutate();
    let snapshotPath = sourceSnapshotPath(source, run.snapshotId, runConfigHash, options.sourceStorageDir, mutate, mat.safeTreeOps);
    if (run.state === "scanning") {
      let materialized;
      try {
        materialized = await materializeCommit(source, run.snapshotId, { ...mat, config: run.effectiveConfig });
      } catch (error) {
        const writeFree = core.listSourceFiles(run.id).length === 0 && core.listSourceChunks(run.id).length === 0;
        if (type !== "git-md" || !writeFree || !isRecoverableGitCommitAvailabilityError(error)) throw error;
        const fence = gitMdSourceSignature(source);
        const recoveredOid = await syncManagedGitRepository(source, options.sourceStorageDir, options.remoteGit, () => {
          options.preflight?.(); requireUnchangedGitMdSource(core, sourceId, fence);
        }, assertAuthorizedOwnership);
        assertAuthorizedOwnership();
        source = requireUnchangedGitMdSource(core, sourceId, fence);
        try {
          // A normal branch fetch may make the old pinned commit reachable
          // again. Preserve the durable run whenever that exact commit exists.
          materialized = await materializeCommit(source, run.snapshotId, { ...mat, config: run.effectiveConfig });
        } catch (retryError) {
          const stillWriteFree = core.listSourceFiles(run.id).length === 0 && core.listSourceChunks(run.id).length === 0;
          if (!stillWriteFree || recoveredOid === run.snapshotId || !isRecoverableGitCommitAvailabilityError(retryError)) throw retryError;
          mutate();
          core.abortSourceRun(run.id, "failed", "pinned git-md commit is unavailable after hardened refetch");
          mutate();
          const replacement = core.beginSourceRun({
            sourceId, snapshotId: recoveredOid, expectedConfigVersion: source.configVersion, expectedLeaseFence: source.leaseFence,
          });
          if (replacement.kind === "noop") {
            return verifyUnchangedPublication(core, replacement.source, recoveredOid, options, mat, mutate, () => {
              invocationVerified = true; durableSuccessObserved = true;
            });
          }
          run = replacement.run;
          durableRunObserved = true;
          invocationRun = run;
          runConfigHash = computeSourceIngestConfigHash(run.effectiveConfig);
          mutate();
          snapshotPath = sourceSnapshotPath(source, run.snapshotId, runConfigHash, options.sourceStorageDir, mutate, mat.safeTreeOps);
          materialized = await materializeCommit(source, run.snapshotId, { ...mat, config: run.effectiveConfig });
        }
      }
      const scanned = (options.scan ?? scanSourceSnapshot)({ root: snapshotPath, config: run.effectiveConfig });
      if (!scanned.publishable || scanned.status === "partial") {
        mutate();
        core.abortSourceRun(run.id, "partial", JSON.stringify(scanned.diagnostics));
        return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "partial", diagnostics: scanned.diagnostics };
      }
      const planned = await planManifest(
        core, source, run, scanned, options.idGen ?? randomUUID,
        materialized.repositoryRoot, mat,
      );
      mutate();
      core.stageSourceManifest(planned);
      options.fault?.("after-stage");
      run = core.getSourceRun(run.id)!;
    }

    if (run.state === "staging") {
      await materializeStagedBindings(core, source, run, guardedOptions);
      try {
        mutate();
        core.beginSourceActivation(run.id);
      } catch (error) {
        if (!isFenceError(error)) throw error;
        // Every intent/engine-written row is converged before abort so cleanup authorization is exact.
        await materializeStagedBindings(core, source, run, guardedOptions);
        mutate();
        const aborted = core.abortSourceRun(run.id, "failed", "source run fence is stale");
        await drainCleanup(core, aborted, guardedOptions);
        return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "aborted", diagnostics: [] };
      }
      run = core.getSourceRun(run.id)!;
      options.fault?.("after-activation");
    }

    if (run.state === "activating") {
      try {
        mutate();
        core.publishSourceRun({ runId: run.id, activationToken: run.activationToken! });
      } catch (error) {
        if (!isFenceError(error)) throw error;
        mutate();
        const aborted = core.abortSourceRun(run.id, "failed", "source run fence is stale");
        await drainCleanup(core, aborted, guardedOptions);
        return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "aborted", diagnostics: [] };
      }
      options.fault?.("after-publish");
      source = requireActiveSource(core, sourceId, type);
      const publishedManifest = type === "git-md" ? activePublishedManifest(core, source) : undefined;
      if (type === "git-md") {
        if (source.activeRunId !== run.id || source.activeSnapshotId !== run.snapshotId
            || source.activeIngestConfigHash !== runConfigHash) throw new Error("git-md publication changed after durable publish");
        core.validateSourceActivePublication(source.id, run.id, run.snapshotId, runConfigHash);
      }
      pointSourceCurrent(source, run.snapshotId, runConfigHash, mat, publishedManifest);
      validateSourcePublishedPath(source, run.snapshotId, runConfigHash, options.sourceStorageDir, publishedManifest);
      run = core.getSourceRun(run.id)!;
    }
    if (run.state === "cleaning") await drainCleanup(core, run, guardedOptions);
    source = requireActiveSource(core, sourceId, type);
    const finalPublication = type === "git-md" ? activePublishedManifest(core, source) : undefined;
    if (type === "git-md") core.validateSourceActivePublication(source.id, run.id, run.snapshotId, runConfigHash);
    pointSourceCurrent(source, run.snapshotId, runConfigHash, mat, finalPublication);
    validateSourcePublishedPath(source, run.snapshotId, runConfigHash, options.sourceStorageDir, finalPublication);
    options.fault?.("after-current");
    return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "published", diagnostics: [] };
    };

    try {
      const result = await execute();
      if (invocationRun && result.status !== "removed") {
        assertScheduledLease(options);
        const outcomeRun = core.getSourceRun(invocationRun.id) ?? invocationRun;
        const invocationResult = result.status === "published" || result.status === "noop" ? "success"
          : result.status === "partial" ? "partial" : "failed";
        core.recordSourceRunInvocation({
          sourceId, runId: outcomeRun.id, result: invocationResult,
          ...(invocationResult === "failed" && outcomeRun.reason ? { reason: outcomeRun.reason } : {}),
          configVersion: outcomeRun.configVersion, leaseFence: outcomeRun.leaseFence,
        });
      }
      return result;
    } catch (error) {
      if (type === "repo-md" && !invocationRun && !invocationVerified && !isSchedulerLeaseLost(error)) {
        recordCurrentPrePinFailure(error);
      }
      // Removal completion is authoritative: it purges attempt state, and a
      // post-completion fault must not resurrect a receipt for the retained run.
      if (invocationRun && !invocationVerified && !isSchedulerLeaseLost(error)
          && core.getSourceRemoval(sourceId)?.state !== "complete") {
        try {
          assertScheduledLease(options);
          core.recordSourceRunInvocation({
            sourceId, runId: invocationRun.id, result: "failed",
            reason: error instanceof Error ? error.message : String(error),
            configVersion: invocationRun.configVersion, leaseFence: invocationRun.leaseFence,
          });
        } catch { /* A corrupt/missing durable run receipt must never mask the primary failure. */ }
      }
      throw error;
    }
  });
  } catch (error) {
    // Lock/root failures can occur before the coordinator callback. The ledger's
    // atomic current-fence check makes this receipt safe without mutation authority.
    if (!isSchedulerLeaseLost(error) && !durableRunObserved && !durableSuccessObserved && !prePinFailureRecorded
        && (!coordinatorEntered || type === "repo-md")) {
      const current = core.getSource(sourceId, { includeTombstoned: true });
      const scheduledFenceMatches = !options.scheduledFence || (current?.configVersion === options.scheduledFence.configVersion
        && current.leaseFence === options.scheduledFence.leaseFence);
      if (current?.type === type && current.lifecycle === "active" && scheduledFenceMatches) {
        try {
          assertScheduledLease(options);
          core.recordSourcePrePinFailure({
            sourceId, reason: error instanceof Error ? error.message : String(error),
            configVersion: current.configVersion, leaseFence: current.leaseFence,
          });
        } catch { /* A stale fallback receipt must not mask the primary failure. */ }
      }
    }
    throw error;
  }
}
