import { randomUUID } from "node:crypto";
import type { IngestResult, SourceConceptRollbackResult } from "./engine";
import {
  detectRepoMdRenames, materializeGitMdCommit, materializeRepoMdCommit, materializeRepoMdHead, pointSourceCurrent,
  removeSourceMaterializations, repairActiveSourceSnapshotStrictSuperset, sourceSnapshotPath, revokeSourceCurrent,
  validateSourceMaterializationRemoval, validateSourcePublishedPath,
  validateStagedSourcePublication, withGitMdMaterializerLock, withRepoMdMaterializerLock,
} from "./source-materializer";
import type { RepoMdMaterialization, RepoMdMaterializerOptions } from "./source-materializer";
import { syncManagedGitRepository, validateManagedGitRepository } from "./source-git";
import type { RemoteGitOptions } from "./source-git";
import {
  computeSourceIngestFingerprint, computeSourceOperationId, computeSourceRefOccurrences, sourceHeadingAnchor, sourceHeadingIdentityKey,
  deriveSourceFileTitle, SOURCE_CHUNKER_VERSION,
} from "./source-chunker";
import { computeSourceIngestConfigHash, computeSourceManifestHash, matchesSourceGlob, scanSourceSnapshot, SOURCE_SCANNER_VERSION } from "./source-scanner";
import type { SourceScanDiagnostic, SourceScanResult } from "./source-scanner";
import type {
  BeginSourceRunInput, BeginSourceRunResult, KnowledgeSource, PublishSourceRunInput,
  RecordSourceBindingReceiptInput, SourceChunkRecord, SourceCleanupItem, SourceFileRecord,
  SourceManifestChunkInput, SourceManifestFileInput, SourceManifestSkippedFileInput, SourceSyncRun, StageSourceManifestInput,
  SourceRemoval, SourceRemovalItem,
  SourcePublishedManifest,
} from "./source-types";

const compareUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

function mergeScanDiagnostics(...groups: readonly (readonly SourceScanDiagnostic[])[]): SourceScanDiagnostic[] {
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

export type RepoMdSyncFaultPoint =
  | "after-pin" | "after-begin" | "after-stage" | "after-store" | "after-engine-written"
  | "after-refresh" | "after-committed" | "after-activation" | "after-publish" | "after-current" | "after-cleanup"
  | "after-noop-verification"
  | "after-remove-current" | "after-remove-item" | "after-remove-snapshots"
  | "before-remove-complete" | "after-remove-complete"
  | "after-recompute";

type CallerMaterializerOptions = Omit<Partial<RepoMdMaterializerOptions>,
  "sourceStorageDir" | "config" | "lockStaleMs" | "now" | "assertOwnership" | "activePublication">;

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
  /** File=concept (ratified, Phase 1): supersedes ONE chunk's observation pair. Replaces the
   *  retired refreshSourceConcept (a concept-level active-observation-pointer swap that only
   *  ever worked because a source concept had exactly one observation). */
  supersedeSourceChunkObservation(conceptId: string, observationId: string, expectedPredecessorObservationId: string): Promise<void>;
  /** REVIEW FIX (round 4, Codex thread 6): plain read — which concept owns this observation right
   *  now, or null if it doesn't exist. Lets reconcileExistingStagedBindings detect a cross-concept
   *  predecessor during tombstoned-source removal recovery without needing a priorActiveByBinding
   *  map threaded in. */
  observationConceptId(observationId: string): string | null;
  /** REVIEW FIX (round 5, Codex thread R5-2): every chunk's binding_id for one run, in rowid
   *  (physical insertion) order — see the engine method's own docstring for why
   *  planCarryForwardManifest needs this to re-sequence a pre-document_sequence store's carried
   *  chunks. */
  sourceChunkInsertOrder(runId: string): string[];
  /** File=concept (ratified, Phase 1), item 4: recomputes a file concept's title/body/embedding
   *  from its currently active chunk observations. Call ONLY after the run has durably
   *  published — see the engine method's own docstring for why pre-publish would leak. */
  recomputeSourceConceptBody(conceptId: string): Promise<void>;
  /** File=concept (ratified, Phase 1): does this concept still have ANY active chunk under it
   *  (this source, any file)? Drives retire-absent's conditional retirement (item 5: "file
   *  deleted -> concept retired", NOT "chunk deleted -> concept retired") — a concept is only
   *  fully retired once its LAST chunk goes, not its first. */
  hasActiveSourceChunks(conceptId: string): boolean;
  /** REVIEW FIX (BLOCKER): every concept this source has durably touched but not yet recomputed
   *  for — see recomputeSourceConceptBody's own docstring (engine.ts) for the durable half of
   *  this mechanism. Swept at the start of every sync (sweepPendingRecomputes, below). */
  listPendingRecomputeConcepts(sourceId: string): string[];
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

function activePublicationRecoverySignature(source: KnowledgeSource): string {
  return JSON.stringify({
    type: source.type,
    lifecycle: source.lifecycle,
    activeRunId: source.activeRunId,
    activeSnapshotId: source.activeSnapshotId,
    activeIngestConfigHash: source.activeIngestConfigHash,
    configVersion: source.configVersion,
    leaseFence: source.leaseFence,
  });
}

function requireUnchangedActivePublication(
  core: SourceSyncCorePort,
  source: KnowledgeSource,
  expectedRecoverySignature: string,
  publication: SourcePublishedManifest,
  expectedGitSignature?: string,
): KnowledgeSource {
  const current = requireActiveSource(core, source.id, source.type);
  if (expectedGitSignature !== undefined && gitMdSourceSignature(current) !== expectedGitSignature) {
    throw new Error("git-md source changed during remote synchronization");
  }
  if (activePublicationRecoverySignature(current) !== expectedRecoverySignature) {
    throw new Error("source active publication changed during local recovery");
  }
  core.validateSourceActivePublication(
    current.id, publication.runId, publication.snapshotId, publication.ingestConfigHash,
  );
  return current;
}

function activePublishedManifest(core: SourceSyncCorePort, source: KnowledgeSource): SourcePublishedManifest {
  if (!source.activeRunId || !source.activeSnapshotId || !source.activeIngestConfigHash) {
    throw new Error("source active publication metadata is incomplete");
  }
  const run = core.getSourceRun(source.activeRunId);
  if (!run || run.snapshotId !== source.activeSnapshotId) {
    throw new Error("source active publication run/snapshot fence is inconsistent");
  }
  // The registry hash may intentionally be stale after a scanner/parser version change. The
  // canonical published ledger remains the durable active run tuple until the replacement run
  // publishes, so authenticate that tuple rather than reconstructing rows under the stale hash.
  return core.getSourcePublishedManifest(
    source.id, run.id, run.snapshotId, run.ingestConfigHash,
  );
}

function stagedPublishedManifest(core: SourceSyncCorePort, run: SourceSyncRun): SourcePublishedManifest {
  if (!run.manifestHash) throw new Error("staged source run is missing its manifest hash");
  return {
    sourceId: run.sourceId,
    runId: run.id,
    snapshotId: run.snapshotId,
    ingestConfigHash: run.ingestConfigHash,
    configVersion: run.configVersion,
    leaseFence: run.leaseFence,
    manifestHash: run.manifestHash,
    files: core.listSourceFiles(run.id),
  };
}

/** Authenticate and recover the stored active publication before connector-specific acquisition. */
function recoverActivePublication(
  core: SourceSyncCorePort,
  source: KnowledgeSource,
  options: RuntimeOptions,
  materializer: RepoMdMaterializerOptions,
): KnowledgeSource {
  if (!source.activeRunId && !source.activeSnapshotId && !source.activeIngestConfigHash) return source;
  if (!source.activeRunId || !source.activeSnapshotId || !source.activeIngestConfigHash) {
    throw new Error("source active publication metadata is incomplete");
  }
  const expectedRecoverySignature = activePublicationRecoverySignature(source);
  const expectedGitSignature = source.type === "git-md" ? gitMdSourceSignature(source) : undefined;
  const publication = activePublishedManifest(core, source);
  const revalidate = (): void => {
    // Preserve the coordinator's exact lock-token/inode, scheduler-lease, authorization,
    // preflight, and connector fences before checking the durable publication identity.
    assertRuntimeOwnership(options);
    requireUnchangedActivePublication(
      core, source, expectedRecoverySignature, publication, expectedGitSignature,
    );
  };
  revalidate();
  let publishedPathValid = false;
  try {
    validateSourcePublishedPath(
      source, publication.snapshotId, publication.ingestConfigHash, options.sourceStorageDir, publication, revalidate,
    );
    publishedPathValid = true;
  } catch { /* The sealed variant is revalidated below before any pointer repair. */ }
  if (!publishedPathValid) {
    repairActiveSourceSnapshotStrictSuperset(source, publication, {
      ...materializer,
      assertOwnership: revalidate,
      fault: (point) => {
        materializer.fault?.(point);
        revalidate();
      },
    });
    pointSourceCurrent(source, publication.snapshotId, publication.ingestConfigHash, {
      ...materializer,
      assertOwnership: revalidate,
      fault: (point) => {
        materializer.fault?.(point);
        revalidate();
      },
    }, publication);
  }
  revalidate();
  validateSourcePublishedPath(
    source, publication.snapshotId, publication.ingestConfigHash, options.sourceStorageDir, publication, revalidate,
  );
  revalidate();
  validateSourcePublishedPath(
    source, publication.snapshotId, publication.ingestConfigHash, options.sourceStorageDir, publication, revalidate,
  );
  return requireUnchangedActivePublication(
    core, source, expectedRecoverySignature, publication, expectedGitSignature,
  );
}

async function materializeCommit(source: KnowledgeSource, snapshotId: string, options: RepoMdMaterializerOptions) {
  return source.type === "git-md"
    ? materializeGitMdCommit(source, snapshotId, options)
    : materializeRepoMdCommit(source, snapshotId, options);
}

function materializerOptions(options: RuntimeOptions): RepoMdMaterializerOptions {
  const {
    sourceStorageDir: _callerStorage, config: _callerConfig, lockStaleMs: _callerLock,
    now: _callerClock, activePublication: _callerPublication, ...caller
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
  skipDiagnostics: readonly SourceScanDiagnostic[],
): Promise<StageSourceManifestInput> {
  const active = source.activeRunId ? core.listSourceChunks(source.activeRunId, true) : [];
  const activeChunks = active.filter((chunk) => chunk.lifecycle === "active");
  const byIdentity = new Map(activeChunks.map((chunk) => [naturalKey(chunk), chunk]));
  const consumed = new Set<string>();
  const priorRun = source.activeRunId ? core.getSourceRun(source.activeRunId) : null;
  const priorFiles = source.activeRunId ? core.listSourceFiles(source.activeRunId, true) : [];
  const priorPaths = new Set(priorFiles.map((file) => file.relativePath));
  const nextPaths = new Set(scan.files.map((file) => file.relativePath));
  // CLOSURE FIX: a path this run could only diagnose (not-markdown, oversized, invalid content,
  // etc.) was neither confirmed present nor confirmed absent, so it must not be inferred deleted —
  // deletion is derived only from a successfully completed scan of that exact path.
  // MINOR FIX: a single path can legitimately collect more than one diagnostic in a run; persist
  // all of them in staged order rather than collapsing to the last one seen — the durable audit
  // trail (source_skipped_files) is already keyed by (run_id, sequence) with no per-path
  // uniqueness, so only this in-memory step was lossy.
  const skippedByPath = new Map<string, SourceScanDiagnostic[]>();
  for (const diagnostic of skipDiagnostics) {
    if (diagnostic.relativePath === undefined) continue;
    const list = skippedByPath.get(diagnostic.relativePath);
    if (list) list.push(diagnostic); else skippedByPath.set(diagnostic.relativePath, [diagnostic]);
  }
  const skippedPaths = new Set(skippedByPath.keys());
  const priorByPath = new Map(priorFiles.map((file) => [file.relativePath, file]));
  const skipped: SourceManifestSkippedFileInput[] = [...skippedByPath.entries()]
    .sort(([a], [b]) => compareUtf8(a, b))
    .flatMap(([relativePath, diags]) => diags.map((diagnostic) => ({
      relativePath, code: diagnostic.code, message: diagnostic.message,
      // Best-effort and known only for a path that was previously published (its last-confirmed
      // size); a path that has never successfully scanned has no size to report.
      ...(priorByPath.has(relativePath) ? { byteLength: priorByPath.get(relativePath)!.byteLength } : {}),
    })));
  // BLOCKER 4 FIX: a skip diagnostic's relativePath may name a directory-shaped node (a selected
  // subtree replaced by a symlink is diagnosed at the subtree root, e.g. "docs"), not just a file.
  // Protection must extend to every prior path nested under it, not only an exact-string match —
  // otherwise every previously published descendant is wrongly inferred deleted alongside it.
  const protectingSkipPath = (path: string): string | undefined =>
    [...skippedPaths].find((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const deletedPaths = new Set(
    [...priorPaths].filter((path) => !nextPaths.has(path) && protectingSkipPath(path) === undefined),
  );
  const addedPaths = new Set([...nextPaths].filter((path) => !priorPaths.has(path)));
  // BLOCKER 2 FIX: a rename target that itself fails validation this run (e.g. a corrupted
  // encoding introduced by the same commit that renamed it) never reaches scan.files, so it's
  // never in addedPaths — without this, git rename evidence for it is discarded below and the old
  // binding is inferred deleted instead of carried under its new name. A skip-diagnosed path is
  // just as valid a rename destination as a freshly scanned one.
  //
  // AUDIT-FLAGGED KNOWN-NARROW GAP (non-blocking, deliberately not fixed): a rename whose
  // destination lands UNDER a directory-shaped diagnostic this run (e.g. OLD.md renamed to
  // docs/NEW.md in the same run docs/ becomes a symlink) is not protected — "docs/NEW.md" is
  // exact-matched by neither skippedPaths (only "docs" itself is diagnosed) nor a prefix check
  // against a KNOWN candidate path, because unlike blocker 4's carry-forward (which iterates
  // already-known PRIOR paths and asks "is this protected"), a rename destination is not knowable
  // at all here — it is, by construction, never scanned, never diagnosed, and never git-tree-
  // visible once its parent is a symlink (never followed). There is no candidate path to extend
  // renameCandidateTargets or protectingSkipPath with. Cost/benefit: fixing this would need
  // resolving a rename destination hidden behind a not-followed symlink, in tension with the
  // scanner's own fail-closed symlink posture — left as a known-narrow shape rather than done.
  const renameCandidateTargets = new Set([...addedPaths, ...skippedPaths]);
  const movedToFrom = new Map<string, string>();
  if (priorRun && priorRun.scanConfigVersion === run.scanConfigVersion && deletedPaths.size && renameCandidateTargets.size) {
    // Git rename evidence is advisory. A resumed run may outlive replacement of
    // its managed repository; publication must still converge using the durable
    // manifests instead of wedging on unavailable/poisoned diff evidence.
    let gitMoves = new Map<string, string>();
    try {
      if (source.type === "git-md") validateManagedGitRepository(repositoryRoot);
      // Pass renameCandidateTargets (nextPaths ∪ skippedPaths), not nextPaths alone:
      // detectRepoMdRenames applies its own internal `newSelectedPaths.has(to)` filter
      // (source-materializer.ts) before ever returning a pair, so relaxing only the filter below
      // is not sufficient — a skip-diagnosed destination must already be an eligible `to` here.
      gitMoves = await detectRepoMdRenames(
        repositoryRoot, priorRun.snapshotId, run.snapshotId, priorPaths, renameCandidateTargets, {
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
      if (!deletedPaths.has(from) || !renameCandidateTargets.has(to) || usedOld.has(from) || usedNew.has(to)) continue;
      movedToFrom.set(to, from); usedOld.add(from); usedNew.add(to);
    }
    // Content proof is intentionally stricter and is disabled by any effective ingest-config
    // change. It is also scoped to addedPaths only, unlike the git-evidence pass above: a skipped
    // destination was never successfully read this run, so it has no content hash to prove
    // identity against — git rename evidence is the only detector available for that case.
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
      documentSequence: chunk.documentSequence,
      contentHash: chunk.contentHash,
      ingestFingerprint: chunk.ingestFingerprint,
      metadata: chunk.metadata,
      sourceRef: `source://${source.id}/${chunk.sourceRef}`,
      content: chunk.body,
      ...(changedIdentity && prior ? { bindingIdHint: { bindingId: prior.bindingId, priorRunId: prior.runId } } : {}),
    };
  });
  // CLOSURE FIX, continued: a previously-published path this run could only diagnose (not
  // confirm absent) carries its exact prior file record and chunk(s) forward byte-for-byte. This
  // keeps the binding present (not absent) at publish, so publishRun's deletion inference never
  // sees it and its concept's engine-side lifecycle stays untouched; it also preserves binding
  // continuity so a future sync where the file heals resumes the same concept rather than forking
  // a new one. Carrying content forward unchanged routes it through materializeStagedBindings'
  // existing unchanged-content fast path (write_state='skipped' — that axis, never overloaded with
  // files_skipped/skipped-file diagnostics, which record why THIS run couldn't read it fresh).
  //
  // Three shapes carry forward, all sourced from the same prior file/chunk records, differing only
  // in which prior path supplies them and which path they're re-published under:
  //   (a) same-path skip: previously published at P; P itself is diagnosed this run.
  //   (b) subtree protection (blocker 4): previously published at P; some ancestor prefix of P is
  //       diagnosed this run (a selected subtree replaced by a symlink) — carried under P.
  //   (c) renamed into a skip (blocker 2): previously published at OLD; git identifies OLD as
  //       renamed to NEW this run, and NEW is itself diagnosed — carried under NEW, reusing OLD's
  //       binding so a later heal of NEW resumes the same concept instead of forking a new one.
  //
  // Cases (a)/(b) copy the carried bytes into staging before the canonical scan and seal. Case (c)
  // can still produce a manifest/snapshot mismatch because rename evidence is computed later; the
  // mandatory pre-activation ledger parity gate catches it and preserves the prior publication.
  // CODEX FIX (3606534107): a same-path/subtree carry candidate must still be selected by the
  // CURRENT effective include/exclude config, not just previously published and diagnosis-
  // protected. Without this, a config change that newly excludes a descendant of a diagnosed
  // subtree (e.g. adding "docs/private.md" to exclude while "docs" is a symlink) gets silently
  // overridden by carry-forward — the exclusion is never enforced until the subtree heals. The
  // rename case (below) needs no equivalent check: a path only ever lands in skippedPaths by
  // generating a diagnostic THIS run, and both the scanner and enumerateSelectedTree skip an
  // excluded path silently, before any diagnostic is possible — so every rename target here is
  // already, structurally, still selected.
  const isCurrentlySelected = (path: string): boolean =>
    run.effectiveConfig.include.some((pattern) => matchesSourceGlob(pattern, path))
    && !run.effectiveConfig.exclude.some((pattern) => matchesSourceGlob(pattern, path));
  const carrySources: Array<{ outputPath: string; priorPath: string }> = [
    ...[...priorPaths]
      .filter((path) => !nextPaths.has(path) && protectingSkipPath(path) !== undefined && isCurrentlySelected(path))
      .map((path) => ({ outputPath: path, priorPath: path })),
    ...[...skippedPaths]
      .filter((path) => !priorPaths.has(path) && movedToFrom.has(path))
      .map((path) => ({ outputPath: path, priorPath: movedToFrom.get(path)! })),
  ].sort((a, b) => compareUtf8(a.outputPath, b.outputPath));
  const carriedFiles: SourceManifestFileInput[] = [];
  const carriedChunks: SourceManifestChunkInput[] = [];
  // REVIEW FIX (round 5, Codex thread R5-2): lazily computed once, only if some carried file's
  // document_sequence values turn out tied (the pre-document_sequence-column backfill signature —
  // see below and sourceChunkInsertOrder's own docstring). Most carries never need this at all (a
  // store that has always run under document_sequence never has duplicates within one file), so
  // this stays a no-op query in the common case.
  let insertOrderIndex: Map<string, number> | undefined;
  const insertOrderIndexFor = (): Map<string, number> => {
    if (!insertOrderIndex) {
      const order = priorRun ? core.sourceChunkInsertOrder(priorRun.id) : [];
      insertOrderIndex = new Map(order.map((bindingId, index) => [bindingId, index]));
    }
    return insertOrderIndex;
  };
  for (const { outputPath, priorPath } of carrySources) {
    const priorFile = priorByPath.get(priorPath);
    if (!priorFile) continue;
    // REVIEW FIX (round 5, Codex thread R5-1): a store that predates the title column backfills
    // every existing source_files/source_staged_files row to title='' (schema-upgrade default,
    // source-ledger.ts's ensureSchema). If one of those pre-upgrade files is skip-diagnosed (not
    // successfully re-scanned) on its FIRST sync after the upgrade, priorFile here is that exact
    // backfilled row — carrying its title verbatim pushes '' into carriedFiles, and
    // requireString(file.title, "file.title") in validateManifest (source-ledger.ts) rejects an
    // empty string, hard-failing the carry that exists specifically to PRESERVE this file's prior
    // publication. Falls back the same way a fresh scan would for a file with no frontmatter
    // title: deriveSourceFileTitle's own outputPath-basename derivation. Real-store-live: this
    // reshape's own migration hits exactly this shape on any pre-upgrade store with even one
    // transiently-unreadable file on its first post-upgrade sync.
    const carriedTitle = priorFile.title.trim().length > 0 ? priorFile.title : deriveSourceFileTitle(null, outputPath);
    carriedFiles.push({
      relativePath: outputPath, type: priorFile.type,
      contentHash: priorFile.contentHash, byteLength: priorFile.byteLength, title: carriedTitle,
    });
    const filesChunks = activeChunks.filter((candidate) => candidate.relativePath === priorPath);
    // REVIEW FIX (round 5, Codex thread R5-2): a store that predates the document_sequence column
    // backfills every existing chunk row to document_sequence=1 (schema-upgrade default,
    // source-ledger.ts's ensureSchema). If this file's carried chunks are all (or partly) tied at
    // that placeholder, recomputeSourceConceptBody's `ORDER BY document_sequence` sees an
    // all-or-partly-tied sort key for a multi-heading file and falls back to SQLite's own
    // tie-break (a lexicographic heading-path sort, NOT document order) — reordering the
    // reconstructed body away from how the sections actually appeared in the file. Detected here
    // by duplicate document_sequence values WITHIN this one file's own carried chunk set — a
    // genuinely fresh chunking pass (chunkSourceText, source-chunker.ts) never produces those,
    // since it assigns them as a strictly increasing per-file emission counter. Re-sequenced from
    // insertion (rowid) order instead when tied — the closest available proxy for original
    // document order (see sourceChunkInsertOrder's own docstring for why).
    const hasTiedDocumentSequence = new Set(filesChunks.map((chunk) => chunk.documentSequence)).size < filesChunks.length;
    const resequencedDocumentSequence = hasTiedDocumentSequence
      ? new Map(
          [...filesChunks]
            .sort((a, b) => (insertOrderIndexFor().get(a.bindingId) ?? 0) - (insertOrderIndexFor().get(b.bindingId) ?? 0))
            .map((chunk, index) => [chunk.bindingId, index + 1] as const),
        )
      : undefined;
    // REVIEW FIX (MINOR): the minimum-chunk merge pass (item 8) can leave a heading-anchor group's
    // raw occurrence values sparse — an earlier occurrence merged forward into a later one (see
    // mergeUndersizedSections, source-chunker.ts) drops that number entirely, so a group that used
    // to be {1,2,3} can now surface as {2,3}. computeSourceRefOccurrences' canonical rank is always
    // DENSE (1,2,3... by sorted order WITHIN the group, source-chunker.ts), so it no longer equals
    // the raw occurrence column once a group has a gap. Recomputed here, per file, over exactly the
    // chunks staged for THAT file (never scan.files — a carried file's chunks are the ONLY chunks
    // validateManifest will ever see at this outputPath, by construction of carrySources above) —
    // the same computation validateManifest (source-ledger.ts) independently repeats and checks
    // sourceRef's trailing number against. Using the raw occurrence value directly here instead
    // used to throw "chunk.sourceRef occurrence does not match its canonical heading identity" the
    // instant a renamed carry's group had ever lost an earlier occurrence to the merge pass.
    const canonicalRanks = computeSourceRefOccurrences(
      filesChunks.map((chunk) => ({ relativePath: outputPath, headingPath: chunk.headingPath, occurrence: chunk.occurrence })),
    );
    for (const chunk of filesChunks) {
      const bindingGeneration = core.nextSourceBindingGeneration(source.id, chunk.bindingId);
      // BLOCKER 6 FIX: always recompute under the CURRENT run's ingestConfigHash rather than
      // reusing the prior chunk's fingerprint verbatim. This reproduces the identical value when
      // config hasn't changed (a deterministic function of the same inputs) and produces a valid
      // one when it has. validateManifest checks every chunk's fingerprint against
      // run.ingestConfigHash unconditionally, carried or not; the one existing config-hash fence
      // above only gates content-hash rename matching, never carry-forward, so carry-forward is
      // reachable in the same run as a config change and must not depend on that fence.
      const carriedIngestFingerprint = computeSourceIngestFingerprint({
        contentHash: chunk.contentHash, headingPath: chunk.headingPath,
        metadata: chunk.metadata, ingestConfigHash: run.ingestConfigHash,
      });
      const canonicalRank = canonicalRanks.get(
        sourceHeadingIdentityKey({ relativePath: outputPath, headingPath: chunk.headingPath, occurrence: chunk.occurrence }),
      )!;
      carriedChunks.push({
        bindingId: chunk.bindingId,
        bindingGeneration,
        operationId: computeSourceOperationId(source.id, chunk.bindingId, carriedIngestFingerprint, run.snapshotId, bindingGeneration),
        relativePath: outputPath,
        headingPath: [...chunk.headingPath],
        occurrence: chunk.occurrence,
        segmentIndex: chunk.segmentIndex,
        documentSequence: resequencedDocumentSequence?.get(chunk.bindingId) ?? chunk.documentSequence,
        contentHash: chunk.contentHash,
        ingestFingerprint: carriedIngestFingerprint,
        metadata: chunk.metadata,
        // Unchanged path: the stored sourceRef is still exactly correct. Renamed path: sourceRef
        // is a canonical function of (sourceId, relativePath, headingPath, CANONICAL RANK — never
        // the raw occurrence column, see above) — see requireCanonicalSourceRef — so it must be
        // rebuilt against the new path or staging throws.
        sourceRef: outputPath === priorPath ? chunk.sourceRef
          : `source://${source.id}/${outputPath.split("/").map((segment) => encodeURIComponent(segment)).join("/")}` +
            `#${encodeURIComponent(sourceHeadingAnchor(chunk.headingPath))}~${canonicalRank}`,
        content: chunk.content,
        // A renamed carry changes this binding's natural identity (relativePath) exactly like a
        // fresh rename match above — validateBindingProof requires the same proof of an authorized
        // identity change, not just an unchanged same-path carry.
        ...(outputPath !== priorPath ? { bindingIdHint: { bindingId: chunk.bindingId, priorRunId: chunk.runId } } : {}),
      });
    }
  }
  const files = [...scan.files, ...carriedFiles];
  const allChunks = [...chunks, ...carriedChunks];
  return {
    runId: run.id, scanStatus: "complete", manifestHash: computeSourceManifestHash(files),
    files, chunks: allChunks, skipped,
  };
}

async function materializeStagedBindings(
  core: SourceSyncCorePort,
  source: KnowledgeSource,
  run: SourceSyncRun,
  options: RuntimeOptions,
): Promise<void> {
  const active = source.activeRunId ? core.listSourceChunks(source.activeRunId, true) : [];
  const priorActiveByBinding = new Map(active.filter((chunk) => chunk.lifecycle === "active").map((chunk) => [chunk.bindingId, chunk]));
  // FILE=CONCEPT (ratified, Phase 1), item 5: same-path fallback for an existing file whose
  // entire chunk structure changed at an UNCHANGED path — no individual chunk's bindingId
  // survives the natural-key match in that shape, but the file itself is not new.
  const priorFileConceptByPath = new Map<string, string>();
  for (const chunk of priorActiveByBinding.values()) {
    if (chunk.conceptId) priorFileConceptByPath.set(chunk.relativePath, chunk.conceptId);
  }
  const stagedChunks = core.listSourceChunks(run.id);

  // Resolve/create the file concept ONCE per file (per CURRENT relativePath in this run), from
  // ALL of that file's staged chunks together, upfront — never from just the first chunk the
  // write loop below happens to reach. Iteration order must never matter: a partially-
  // restructured rename (some chunks carry their bindingId forward via the ledger's own carry-
  // forward, others don't because their heading/segment position also changed) would otherwise
  // risk landing different chunks of the SAME file on two different concepts depending on which
  // one the loop hit first.
  // REVIEW FIX (round 4, Codex thread 3, decision + documentation, no code change): this map is
  // built from stagedChunks alone, so a valid file that emits zero chunks (frontmatter-only — the
  // chunker legitimately supports that shape) never gets an entry here, and therefore never gets a
  // fileConceptThisRun target or a source concept at all — it is still recorded faithfully in
  // source_files (publishRun) for provenance/audit, just never promoted into the concept/observation
  // layer. Deliberate, not an oversight: this substrate models CONTENT (memory_list/memory_fetch
  // surface concepts built from chunk text), and a chunkless file has no content to build one from
  // — minting an empty-outline concept for it would add a schema/write-path surface (a durable
  // per-(source,relativePath) concept pointer with no chunk to anchor it, needing its own carry-
  // forward-on-rename and orphan-retirement-on-delete handling, mirroring source_chunks' own for a
  // case that carries no actual evidence) for a file whose entire reason to exist in this system is
  // to have none. If a frontmatter field's VALUE ever needs to be memorable, that is future work for
  // the chunker/scanner to surface as real chunk content, not a reason to synthesize a concept here.
  const stagedByPath = new Map<string, SourceChunkRecord[]>();
  for (const chunk of stagedChunks) {
    const list = stagedByPath.get(chunk.relativePath);
    if (list) list.push(chunk); else stagedByPath.set(chunk.relativePath, [chunk]);
  }
  const fileConceptThisRun = new Map<string, string>();
  for (const [relativePath, chunksOfFile] of stagedByPath) {
    // Prefer whatever a PRIOR PARTIAL attempt of this exact run already resolved (resume safety:
    // a crash between committing this file's chunk #1 and its chunk #2 must not mint a second
    // concept for chunk #2 on retry).
    const resumed = chunksOfFile.find((chunk) => chunk.writeState !== "intent" && chunk.conceptId)?.conceptId;
    // bindingId continuity (rename-aware, via the ledger's own carry-forward) — scored across
    // EVERY chunk of the file, not just one.
    const viaBinding = chunksOfFile
      .map((chunk) => priorActiveByBinding.get(chunk.bindingId)?.conceptId)
      .find((id): id is string => !!id);
    const resolved = resumed ?? viaBinding ?? priorFileConceptByPath.get(relativePath);
    if (resolved) fileConceptThisRun.set(relativePath, resolved);
  }

  for (let staged of stagedChunks) {
    if (staged.writeState === "skipped" || staged.writeState === "committed") continue;
    const prior = priorActiveByBinding.get(staged.bindingId);
    // REVIEW FIX (round 4, Codex thread 8): the unchanged-content fast path must also agree with
    // fileConceptThisRun's resolved target for this file — otherwise a chunk that already sits
    // under the RIGHT concept skips as before, but a chunk whose unchanged content still lives on a
    // non-winning LEGACY per-chunk concept (a file mid-consolidation, some siblings already healed
    // to the winning concept in a prior run, this one never touched since) would keep skipping
    // forever, since "content unchanged" alone said nothing about which concept it's parked under.
    // Falls through to the "intent" branch below on a mismatch, which already has the cross-concept
    // handling (terminal supersession of the old concept's observation) this healing needs — same
    // shape as an ordinary content change, just re-attaching identical content to the correct concept.
    const resolvedConceptId = fileConceptThisRun.get(staged.relativePath);
    if (staged.writeState === "intent" && prior && prior.ingestFingerprint === staged.ingestFingerprint
        && prior.contentHash === staged.contentHash && prior.sourceRef === staged.sourceRef
        && (!resolvedConceptId || prior.conceptId === resolvedConceptId)) {
      assertRuntimeOwnership(options);
      core.recordSourceBindingReceipt({ runId: run.id, bindingId: staged.bindingId, writeState: "skipped" });
      continue;
    }
    if (staged.writeState === "intent") {
      assertRuntimeOwnership(options);
      // Every chunk of a brand-new (never-before-seen) file resolves to nothing above — the
      // FIRST one processed creates the concept via forceNew, below, then seeds
      // fileConceptThisRun so every later chunk of the SAME file (guaranteed to be processed
      // consecutively — listSourceChunks orders by relative_path) attaches to it instead of
      // minting one of its own.
      const attachTo = fileConceptThisRun.get(staged.relativePath);
      const stored = await core.storeSource(staged.content, {
        circle: source.circle,
        sourceRefs: [staged.sourceRef],
        operationId: staged.operationId,
        ...(attachTo ? { attachTo } : { resolution: "forceNew" as const }),
      });
      options.fault?.("after-store");
      assertRuntimeOwnership(options);
      staged = core.recordSourceBindingReceipt({
        runId: run.id, bindingId: staged.bindingId, conceptId: stored.conceptId,
        observationId: stored.observationId, predecessorObservationId: prior?.observationId ?? null,
        writeState: "engine-written",
      });
      options.fault?.("after-engine-written");
      fileConceptThisRun.set(staged.relativePath, staged.conceptId!);
    }
    if (!staged.conceptId || !staged.observationId) throw new Error("staged source receipt is incomplete");
    if (staged.predecessorObservationId) {
      // FILE=CONCEPT (ratified, Phase 1): this binding's predecessor observation can live under a
      // DIFFERENT concept than the one it just wrote to — most commonly the one-time migration off
      // the old one-concept-per-chunk model, where fileConceptThisRun resolved this file's
      // consolidated target concept from a SIBLING binding, not this one's own prior concept.
      // supersedeSourceChunkObservation is a same-concept CAS (requireOwned rejects a predecessor
      // under a different concept than its successor) — there is no such pair here, and it throws.
      //
      // REVIEW FIX (round 5, Codex thread R5-4): the cross-concept predecessor is deliberately left
      // COMPLETELY UNTOUCHED here — not terminally superseded, not superseded with any successor.
      // publishRun (source-ledger.ts) retires it instead, in the SAME transaction that actually
      // advances active_run_id. Retiring it here, mid-materialize, well before this run durably
      // publishes, made the old concept's still-genuinely-published content invisible to every
      // authorized read (queryAuthorizedSourcePublications joins against source.active_run_id,
      // which is still the OLD run for the entire staging window) — see publishRun's own comment
      // for the full reasoning. The old concept becomes an orphan once its last chunk supersedes
      // this way (zero active source_chunks rows) — a separate one-time sweep retires it (never
      // automatic here: that decision needs a store-wide "is this concept's LAST chunk really
      // gone" check, not a per-binding one).
      if (!prior || prior.conceptId === staged.conceptId) {
        assertRuntimeOwnership(options);
        await core.supersedeSourceChunkObservation(staged.conceptId, staged.observationId, staged.predecessorObservationId);
        options.fault?.("after-refresh");
      }
    }
    assertRuntimeOwnership(options);
    core.recordSourceBindingReceipt({ runId: run.id, bindingId: staged.bindingId, writeState: "committed" });
    options.fault?.("after-committed");
  }
}

/**
 * FILE=CONCEPT (ratified, Phase 1), item 4. Recomputes title/body/embedding for every file
 * concept this run actually wrote NEW evidence for — derived from the run's own DURABLE
 * published chunk records (write_state='committed'), never from in-memory state accumulated
 * during materializeStagedBindings, so this is safe to call on every reach of "this run is
 * published" regardless of whether that happened in this exact invocation or a prior one before
 * a crash (recomputeSourceConceptBody is itself idempotent — re-deriving from the CURRENT active
 * chunk set every time — so a redundant call here is a no-op cost, never a correctness risk).
 * 'skipped' chunks are excluded deliberately: an unchanged file's body is already correct, and
 * re-embedding it on every routine sync is exactly the per-chunk cost item 6 retires.
 *
 * This resume-safety claim is only as true as every call site that reaches "published" actually
 * calling it — REVIEW FIX (BLOCKER): one early-return resume path didn't (the still-cleaning fast
 * path in syncSource, below), and a crash between a durable publish and this very call could
 * strand a concept on a run that's no longer resumable at all (publishRun collapses
 * published->cleaning->cleaned in ONE transaction whenever a run has zero cleanup items — the
 * common case). sweepPendingRecomputes (below), backed by the durable source_recompute_pending
 * table publishRun writes in that same transaction, is what makes the claim true unconditionally:
 * every call site that can reach "published" without calling this function directly is still
 * covered by the sweep running at the very start of the next sync, noop or not.
 */
async function recomputeTouchedSourceConcepts(core: SourceSyncCorePort, run: SourceSyncRun, options: RuntimeOptions): Promise<void> {
  const published = core.listSourceChunks(run.id, true);
  const touched = new Set(
    published.filter((chunk) => chunk.writeState === "committed" && chunk.conceptId).map((chunk) => chunk.conceptId!),
  );
  // REVIEW FIX (round 4, Codex thread 2/(a)): a retire-absent cleanup item means this run removed
  // a section with no successor chunk of its own — the committed-chunk filter above never sees it
  // (publishRun's touchedConcepts, source-ledger.ts, has the identical gap, which is why it now
  // ALSO marks these concepts source_recompute_pending in the same transaction as the cleanup item
  // — see that method). Without this, a file that ONLY loses a section — its other sections
  // unchanged, hence 'skipped' — would still heal eventually (the durable pending marker is swept
  // at the start of the NEXT sync regardless), but only after an entire extra sync cycle, while
  // THIS run's own result and every read in between kept serving the stale, pre-deletion body.
  // Recomputing it here closes that gap immediately, in the same run that did the deleting — safe
  // to call even when drainCleanup (which always runs before this, both call sites) already
  // retired the concept outright (its last chunk gone): recomputeSourceConceptBody's own first
  // check (status!=='active') no-ops and clears the pending row either way.
  for (const item of core.listSourceCleanupItems(run.id)) {
    if (item.kind === "retire-absent" && item.conceptId) touched.add(item.conceptId);
  }
  for (const conceptId of touched) {
    assertRuntimeOwnership(options);
    await core.recomputeSourceConceptBody(conceptId);
  }
}

/**
 * REVIEW FIX (BLOCKER): the durable half of the recompute resume-safety guarantee. Sweeps every
 * concept this source has durably touched (publishRun, in the same transaction as the chunk
 * write) but not yet recomputed for — self-healing a concept stranded by ANY crash between a
 * durable publish and its recompute, including ones that leave the run itself unresumable (see
 * recomputeTouchedSourceConcepts' docstring). Called unconditionally at the start of every sync,
 * before any state-based dispatch, so even a noop invocation (nothing changed on disk) still
 * heals a concept a PRIOR crashed invocation stranded.
 */
async function sweepPendingRecomputes(core: SourceSyncCorePort, sourceId: string, options: RuntimeOptions): Promise<void> {
  for (const conceptId of core.listPendingRecomputeConcepts(sourceId)) {
    assertRuntimeOwnership(options);
    await core.recomputeSourceConceptBody(conceptId);
    options.fault?.("after-recompute");
  }
}

/** Tombstoned recovery may converge existing writes, but must never create new evidence. */
/**
 * REVIEW FIX (round 4, Codex thread 6; revised round 5, Codex thread R5-6): mirror
 * materializeStagedBindings' own cross-concept branch (above). During the legacy consolidation
 * path, an engine-written binding's successor can land under the WINNING file concept while
 * predecessorObservationId still belongs to the OLD per-chunk concept fileConceptThisRun didn't
 * pick for this file. supersedeSourceChunkObservation is a same-concept CAS (requireOwned rejects
 * a predecessor under a different concept than its successor) and throws in that shape — which
 * would wedge tombstoned-source removal recovery on exactly the binding it exists to unblock.
 * observationConceptId is a plain read with no ledger/run coupling, so this stays independent of
 * source.activeRunId/priorActiveByBinding (this function, unlike materializeStagedBindings, has
 * no `source` in scope).
 *
 * ROUND 5 REVISION: a cross-concept predecessor is now left COMPLETELY UNTOUCHED here (round 4
 * terminally superseded it inline, then had to thread an in-memory deferredChunkSupersessions
 * list through recoverRemovedRepoSource to flip its chunk row afterward — R5-6 found a genuine
 * crash window in that: a process death after drainCleanup acknowledges its cleanup items but
 * before that in-memory list is applied loses it for good, leaving a chunk permanently pointing
 * at a dead observation with no durable record left to heal it, wedging every future removal
 * attempt on this source). This run never publishes (recoverRemovedRepoSource always aborts a
 * "staging" run right after this function returns) — the predecessor belongs to the PRIOR, still-
 * active run and is entirely unrelated to this abandoned attempt: it is correctly retired (or
 * not) by removeTombstonedRepoSource's own removal-item enumeration over source.active_run_id,
 * independently of whatever this run tried to do. Nothing here needs to be durable because
 * nothing here needs to happen at all.
 */
async function reconcileExistingStagedBindings(
  core: SourceSyncCorePort,
  run: SourceSyncRun,
  options: RuntimeOptions,
): Promise<void> {
  for (const staged of core.listSourceChunks(run.id)) {
    if (staged.writeState !== "engine-written") continue;
    if (!staged.conceptId || !staged.observationId) throw new Error("engine-written source receipt is incomplete");
    if (staged.predecessorObservationId) {
      const predecessorConceptId = core.observationConceptId(staged.predecessorObservationId);
      const crossConcept = predecessorConceptId !== null && predecessorConceptId !== staged.conceptId;
      if (!crossConcept) {
        assertRuntimeOwnership(options);
        await core.supersedeSourceChunkObservation(staged.conceptId, staged.observationId, staged.predecessorObservationId);
        options.fault?.("after-refresh");
      }
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
      // FILE=CONCEPT (ratified, Phase 1), item 5: "file deleted -> concept retired", NOT "chunk
      // deleted -> concept retired". A retire-absent item fires per REMOVED CHUNK, but under
      // file=concept many chunks share one file concept — only retire it once none of its
      // siblings are still active (the whole file is gone), never on the first chunk to vanish
      // out of a file that otherwise still exists. publishSourceRun already demoted every prior
      // chunk and inserted only this run's surviving ones as active before any cleanup item is
      // even created, so this reflects the file's FINAL state, not a mid-drain snapshot.
      assertRuntimeOwnership(options);
      if (!core.hasActiveSourceChunks(item.conceptId)) core.retireConcept(item.conceptId);
      assertRuntimeOwnership(options);
      core.acknowledgeSourceCleanup(item.id);
    } else {
      const staged = stagedByBinding.get(item.bindingId);
      // REVIEW FIX (round 4, Codex thread 6, continued): rollbackSourceRunBinding's own
      // authorization requires the predecessor to belong to the SAME concept as the just-
      // committed successor (a true "undo," restoring the predecessor to active under ITS OWN
      // concept) — see that method. The identical legacy-consolidation shape
      // reconcileExistingStagedBindings (above) now handles for the CAS call has no coherent
      // "rollback" here either: there is no single concept that is simultaneously the restored
      // predecessor's home and the just-committed successor's home, so rollbackSourceRunBinding
      // would throw on it (pre-fix, this reopened the exact wedge fixing the CAS call alone
      // still left: reconcileExistingStagedBindings converges the binding to 'committed', which
      // is precisely what routes it into THIS branch). Treat a cross-concept predecessor as the
      // terminal case instead, same as an uncommitted binding — the successor observation is
      // authorized dead evidence at this point (the run is being aborted/the source removed),
      // not something with a well-defined concept to reinstate.
      const predecessorConceptId = core.observationConceptId(item.predecessorObservationId);
      const crossConcept = predecessorConceptId !== null && predecessorConceptId !== item.conceptId;
      if (staged?.writeState === "committed" && !crossConcept) {
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
  const publication = activePublishedManifest(core, active);
  if (snapshotId !== publication.snapshotId) throw new Error("unchanged candidate does not match the canonical active publication");
  pointSourceCurrent(active, publication.snapshotId, publication.ingestConfigHash, materializer, publication);
  options.preflight?.();
  validateSourcePublishedPath(active, publication.snapshotId, publication.ingestConfigHash, options.sourceStorageDir, publication);
  options.preflight?.();
  validateSourcePublishedPath(active, publication.snapshotId, publication.ingestConfigHash, options.sourceStorageDir, publication);
  mutate();
  core.recordSourceVerification({
    sourceId: active.id, runId: publication.runId, snapshotId: publication.snapshotId,
    ingestConfigHash: publication.ingestConfigHash,
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
    // REVIEW FIX (round 4, Codex thread 15): resumeSourceRun hands back ANY nonterminal run for
    // this source with no version check — a run created under an OLDER SOURCE_SCANNER_VERSION/
    // SOURCE_CHUNKER_VERSION (a live "scanning" run when the process restarts under upgraded
    // code, the exact case Codex flagged) gets handed straight back to this function, which then
    // re-scans and re-stages under the CURRENT (newer) chunker. Verified empirically: a
    // "scanning" run whose persisted ingestConfigHash was computed under an older
    // SOURCE_CHUNKER_VERSION (computeSourceIngestConfigHash folds the chunker version directly
    // into that hash, source-scanner.ts) makes EVERY subsequent stageManifest call throw
    // "chunk.ingestFingerprint does not match chunk content, heading, metadata, and ingest
    // config" — resumeSourceRun keeps handing the SAME stuck run back on every retry, so this
    // wedges the source permanently, not just once. Scoped to "scanning" specifically: it is the
    // one state that actually RE-DERIVES fingerprints against the current chunker on resume (this
    // is the confirmed, reproduced failure); "staging"/"activating"/"cleaning" continue from
    // ALREADY-staged rows without recomputing anything, so they neither hit this exact throw nor
    // benefit from being aborted here — and abortRun's own state guard rejects "cleaning" outright
    // (a run that reached "cleaning" already published; there is nothing to abort). A version-
    // stale "scanning" run is aborted here instead of resumed — the SAME machinery (abortRun's
    // ensureOrphanCleanup, drainCleanup below) that already reconciles any other reason a run gets
    // aborted mid-flight, so any evidence it wrote (none yet possible in "scanning" — staging
    // hasn't started) heals the same way. Aborting frees resumeSourceRun to return null next
    // time, letting the normal "nothing to resume" path start a genuinely FRESH run under the
    // current version.
    if (run !== null && run.state === "scanning" && run.scanConfigVersion !== `${SOURCE_SCANNER_VERSION}/${SOURCE_CHUNKER_VERSION}`) {
      assertAuthorizedOwnership();
      core.abortSourceRun(run.id, "failed", "source scan/chunker version changed since this run began");
      run = null;
    }
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
      // REVIEW FIX (round 4, Codex thread 12): sweep BEFORE admission can return early — a
      // scheduled source that published successfully and then crashed (or lost its lease) before
      // recomputeTouchedSourceConcepts ran is "not due" by every scheduling signal (it just
      // synced), so admission would skip it every subsequent pass while its file concept sits on
      // the placeholder/stale body sweepPendingRecomputes exists to heal — see that function's own
      // docstring and queryAuthorizedSourcePublications' pending-row read gate (engine.ts), which
      // now depends on this sweep actually running promptly rather than only eventually. Only for
      // an active source (mirrors the lifecycle!=='active' branch inside execute(), below, which
      // the ordinary in-execute() sweep call implicitly runs after already). Duplicates that later
      // call for the non-admission-skipped path — both are idempotent no-ops once a concept's
      // pending row is cleared, so running it twice on one invocation costs one extra no-op query
      // per source, never a correctness risk.
      if (source.lifecycle === "active") await sweepPendingRecomputes(core, sourceId, guardedOptions);
      if (!options.scheduledAdmission(source, run)) return SCHEDULED_SYNC_SKIPPED;
    }

    const execute = async (): Promise<RepoMdSyncResult> => {
    // The initial pin is the exact candidate for the run it creates. Reuse it in this invocation;
    // resumed runs rebuild their non-active candidate from the immutable source commit.
    let pinnedMaterialization: RepoMdMaterialization | undefined;
    let pinnedDiagnostics: SourceScanDiagnostic[] | undefined;
    // BLOCKER 5a: mirrors pinnedDiagnostics exactly — valid only for the exact run the pin begot,
    // undefined (fall back to the scanning block's own materialize result) on genuine resume.
    let pinnedCarryForwardUnavailable: string[] | undefined;

    if (source.lifecycle !== "active") {
      if (run) await recoverRemovedRepoSource(core, run, guardedOptions);
      const stillResumable = core.resumeSourceRun(sourceId);
      if (stillResumable) throw new Error("tombstoned source recovery did not converge its resumable run");
      return removeTombstonedRepoSource(core, source, guardedOptions);
    }
    if (type === "git-md") authorizedGitMdSignature = gitMdSourceSignature(source);
    assertAuthorizedOwnership();

    // REVIEW FIX (BLOCKER): unconditional, before any state-based dispatch below (including the
    // noop path a crashed-after-publish run resolves to on its very next sync) — see
    // sweepPendingRecomputes' own docstring.
    await sweepPendingRecomputes(core, sourceId, guardedOptions);

    try { source = recoverActivePublication(core, source, guardedOptions, mat); }
    catch (error) {
      recordCurrentPrePinFailure(error);
      throw error;
    }
    mat.activePublication = source.activeRunId ? activePublishedManifest(core, source) : undefined;

    if (run?.state === "aborted") {
      await drainCleanup(core, run, guardedOptions);
      run = core.resumeSourceRun(sourceId);
    }
    if (run?.state === "cleaning") {
      source = requireActiveSource(core, sourceId, type);
      await drainCleanup(core, run, guardedOptions);
      // REVIEW FIX (BLOCKER): this is a resume of an ALREADY-published run — a PR#49-era fast path
      // that predates recomputeTouchedSourceConcepts and returned "published" without ever calling
      // it. Fixed directly here (immediate, not deferred to the next sync's sweep) — the durable
      // sweep above is the backstop if THIS call is itself interrupted, not a substitute for it.
      await recomputeTouchedSourceConcepts(core, run, guardedOptions);
      options.fault?.("after-recompute");
      return { sourceId, snapshotId: source.activeSnapshotId, runId: run.id, status: "published", diagnostics: [] };
    }

    source = requireActiveSource(core, sourceId, type);

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
        // run.snapshotId === pinned.snapshotId and run.effectiveConfig matches what `pinned` just
        // materialized with, so this is exact evidence for the run the "scanning" block is about
        // to consume.
        pinnedMaterialization = pinned;
        pinnedDiagnostics = pinned.diagnostics;
        pinnedCarryForwardUnavailable = pinned.carryForwardUnavailable;
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
      let materialized = pinnedMaterialization;
      if (!materialized) try {
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
          // The pin no longer describes this run's snapshot: this materialize call (below) is now
          // the fresh, authoritative one for the replacement commit.
          pinnedMaterialization = undefined;
          pinnedDiagnostics = undefined;
          pinnedCarryForwardUnavailable = undefined;
          runConfigHash = computeSourceIngestConfigHash(run.effectiveConfig);
          mutate();
          snapshotPath = sourceSnapshotPath(source, run.snapshotId, runConfigHash, options.sourceStorageDir, mutate, mat.safeTreeOps);
          materialized = await materializeCommit(source, run.snapshotId, { ...mat, config: run.effectiveConfig });
        }
      }
      if (materialized.preSealStatus === "partial") {
        mutate();
        core.abortSourceRun(run.id, "partial", JSON.stringify(materialized.diagnostics));
        return {
          sourceId, snapshotId: run.snapshotId, runId: run.id, status: "partial",
          diagnostics: materialized.diagnostics,
        };
      }
      const scanLimits = run.effectiveConfig.limits;
      const scanned = (options.scan ?? scanSourceSnapshot)({ root: snapshotPath, config: run.effectiveConfig });
      // Merge tree-materialization skips (never reached the scanner) with scan-time skips
      // (materialized but excluded on read) into one skip-and-diagnose evidence set for this run.
      // A freshly pinned run reuses its in-memory materialization above, preserving that pin's
      // rejection evidence. A resumed run rebuilds its disposable candidate and uses the rebuilt
      // materialization's evidence instead.
      const skipDiagnostics = mergeScanDiagnostics(pinnedDiagnostics ?? materialized.diagnostics, scanned.diagnostics);
      // BLOCKER 5a EDGE CASE: pre-seal carry-forward (source-materializer.ts) could not source
      // some previously-published paths' bytes because the prior sealed snapshot it needed was
      // missing, corrupt, or otherwise failed validation. Those paths' bytes are NOT in this run's
      // snapshot; never let planManifest carry them into a manifest that would claim otherwise —
      // degrade to the same graceful tree-level-partial exit an over-budget or unreadable corpus
      // takes today, rather than a hard failure or (worse) a manifest/snapshot mismatch.
      const carryForwardUnavailable = pinnedCarryForwardUnavailable ?? materialized.carryForwardUnavailable;
      if (carryForwardUnavailable.length > 0) {
        const unavailableDiagnostics: SourceScanDiagnostic[] = carryForwardUnavailable.map((relativePath) => ({
          code: "io-error",
          message: "prior sealed snapshot required to carry this previously published path forward is unavailable",
          relativePath,
        }));
        const diagnostics = [...skipDiagnostics, ...unavailableDiagnostics];
        mutate();
        core.abortSourceRun(run.id, "partial", JSON.stringify(diagnostics));
        return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "partial", diagnostics };
      }
      // CODEX FIX (3606534097) step 4, the order-dependent residual: chunk-budget-exceeded depends
      // on cumulative chunk usage across the WHOLE walk (maxChunks minus however many chunks
      // earlier files in walk order already consumed), not on this file's own bytes alone, so it
      // cannot be predicted or pre-seal-substituted the way invalid-utf8/invalid-frontmatter now
      // are (John's ruling "A", the shared classifier — source-chunker.ts). If the scanner
      // budget-skips a previously-published, currently-selected file, the sealed snapshot has its
      // fresh (content-valid) bytes but the manifest would still carry the OLD ones — the same
      // manifest/snapshot mismatch shape blocker 5a and this fix close, reached a different way.
      // Degrade to the same graceful tree-level-partial exit; loud, and self-heals on the very next
      // sync once walk order or budget shifts (identical commit, no new failure to accumulate).
      const priorPublishedPaths = new Set((mat.activePublication?.files ?? []).map((file) => file.relativePath));
      const budgetResidualPaths = skipDiagnostics
        .filter((diagnostic) => diagnostic.code === "chunk-budget-exceeded"
          && diagnostic.relativePath !== undefined && priorPublishedPaths.has(diagnostic.relativePath))
        .map((diagnostic) => diagnostic.relativePath!);
      if (budgetResidualPaths.length > 0) {
        mutate();
        core.abortSourceRun(run.id, "partial", JSON.stringify(skipDiagnostics));
        return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "partial", diagnostics: skipDiagnostics };
      }
      if (!scanned.publishable || scanned.status === "partial") {
        mutate();
        core.abortSourceRun(run.id, "partial", JSON.stringify(skipDiagnostics));
        return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "partial", diagnostics: skipDiagnostics };
      }
      const planned = await planManifest(
        core, source, run, scanned, options.idGen ?? randomUUID,
        materialized.repositoryRoot, mat, skipDiagnostics,
      );
      // BLOCKER 1 FIX: planManifest may append carried-forward files/chunks (from a previously
      // published path this run could only diagnose) on top of an already-at-or-near-budget fresh
      // scan. validateManifest enforces the run's limits unconditionally and THROWS on overrun,
      // which the outer error handling records as a hard "failed" run — re-wedging the exact
      // failure loop this feature exists to cure. Check the same limits here first and, if
      // exceeded, exit through the same graceful tree-level-partial path an over-budget corpus
      // takes today, instead of ever reaching that throw.
      //
      // AUDIT FIX: this must cover every dimension validateManifest independently gates
      // (source-ledger.ts), not just the ones a fresh scan can already hit on its own. Carried
      // chunks bypass the chunker (their content is copied verbatim in planManifest), so
      // validateManifest is their ONLY size gate — reachable by a plain config change: publish a
      // chunk of size S under the default maxChunkBytes, lower maxChunkBytes below S, then skip-
      // diagnose that file on the next sync (any reason) so its OLD, still-oversized-under-the-NEW-
      // limit chunk gets carried. Without this check that reaches validateManifest's throw exactly
      // like the untested dimensions did before the original blocker-1 fix.
      const plannedTotalBytes = planned.files.reduce((sum, file) => sum + file.byteLength, 0);
      const oversizedCarriedFile = planned.files.some((file) => file.byteLength > scanLimits.maxFileBytes);
      const oversizedCarriedChunk = planned.chunks.some((chunk) => Buffer.byteLength(chunk.content, "utf8") > scanLimits.maxChunkBytes);
      if (planned.files.length > scanLimits.maxFiles
          || planned.chunks.length > scanLimits.maxChunks
          || !Number.isSafeInteger(plannedTotalBytes) || plannedTotalBytes > scanLimits.maxTotalBytes
          || oversizedCarriedFile || oversizedCarriedChunk) {
        const budgetDiagnostic: SourceScanDiagnostic = {
          code: "file-budget-exceeded",
          message: "carry-forward of previously published, now skip-diagnosed content exceeds the run's inclusive files/chunks/bytes budget",
        };
        const diagnostics = [...skipDiagnostics, budgetDiagnostic];
        mutate();
        core.abortSourceRun(run.id, "partial", JSON.stringify(diagnostics));
        return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "partial", diagnostics };
      }
      mutate();
      core.stageSourceManifest(planned);
      options.fault?.("after-stage");
      run = core.getSourceRun(run.id)!;
    }

    if (run.state === "staging") {
      await materializeStagedBindings(core, source, run, guardedOptions);
      try {
        validateStagedSourcePublication(source, stagedPublishedManifest(core, run), options.sourceStorageDir, mutate);
      } catch (error) {
        mutate();
        const aborted = core.abortSourceRun(
          run.id, "failed", error instanceof Error ? error.message : "staged source publication parity failed",
        );
        await drainCleanup(core, aborted, guardedOptions);
        throw error;
      }
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
        validateStagedSourcePublication(source, stagedPublishedManifest(core, run), options.sourceStorageDir, mutate);
      } catch (error) {
        mutate();
        const aborted = core.abortSourceRun(
          run.id, "failed", error instanceof Error ? error.message : "source activation parity failed",
        );
        await drainCleanup(core, aborted, guardedOptions);
        throw error;
      }
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
      const publishedManifest = activePublishedManifest(core, source);
      if (source.activeRunId !== run.id || source.activeSnapshotId !== run.snapshotId
          || publishedManifest.ingestConfigHash !== runConfigHash) throw new Error("source publication changed after durable publish");
      core.validateSourceActivePublication(source.id, run.id, run.snapshotId, runConfigHash);
      pointSourceCurrent(source, run.snapshotId, runConfigHash, mat, publishedManifest);
      validateSourcePublishedPath(source, run.snapshotId, runConfigHash, options.sourceStorageDir, publishedManifest);
      run = core.getSourceRun(run.id)!;
    }
    if (run.state === "cleaning") await drainCleanup(core, run, guardedOptions);
    // FILE=CONCEPT (ratified, Phase 1), item 4: strictly post-publish, on every path that
    // reaches "this run is published" (fresh or resumed) — see recomputeTouchedSourceConcepts'
    // own docstring for why pre-publish would leak and why a redundant call here is safe.
    await recomputeTouchedSourceConcepts(core, run, guardedOptions);
    options.fault?.("after-recompute");
    source = requireActiveSource(core, sourceId, type);
    const finalPublication = activePublishedManifest(core, source);
    core.validateSourceActivePublication(source.id, run.id, run.snapshotId, runConfigHash);
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
