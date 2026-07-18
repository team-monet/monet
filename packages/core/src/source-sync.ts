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
import { computeSourceIngestFingerprint, computeSourceOperationId, sourceHeadingAnchor } from "./source-chunker";
import { computeSourceIngestConfigHash, computeSourceManifestHash, matchesSourceGlob, scanSourceSnapshot } from "./source-scanner";
import type { SourceScanDiagnostic, SourceScanResult } from "./source-scanner";
import type {
  BeginSourceRunInput, BeginSourceRunResult, KnowledgeSource, PublishSourceRunInput,
  RecordSourceBindingReceiptInput, SourceChunkRecord, SourceCleanupItem, SourceFileRecord,
  SourceManifestChunkInput, SourceManifestFileInput, SourceManifestSkippedFileInput, SourceSyncRun, StageSourceManifestInput,
  SourceRemoval, SourceRemovalItem,
  SourcePublishedManifest,
} from "./source-types";

const compareUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

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
  // SNAPSHOT CONSISTENCY STATUS: for cases (a)/(b) — same-path and subtree-nested materializer
  // skips of previously-published paths — the gap is CLOSED: treeLevelCarryCandidates +
  // carryForwardPriorFiles (source-materializer.ts) copy the carried bytes from the prior sealed
  // snapshot into the new one BEFORE sealing, and validateSealedSnapshotAgainstGit reconciles via
  // marker.carriedPaths (entries ∪ carriedPaths, still an exact match). Cross-check regression
  // tests hold the two carry decisions in lockstep for those shapes. REMAINING OPEN (tracked):
  // case (c) below — a rename whose destination is TREE-LEVEL diagnosed this run — is carried
  // here under a NEW path the pre-seal mirror structurally cannot know (it iterates prior files
  // only; rename pairs are not computed pre-seal). For that one shape the manifest still claims
  // bytes the snapshot lacks: git-md fails the ledger cross-check post-publish; repo-md leaves a
  // source_path gap. Closing it needs pre-seal rename knowledge — a follow-up design decision;
  // see treeLevelCarryCandidates' docstring and the invariant comment in source-ledger.ts.
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
  for (const { outputPath, priorPath } of carrySources) {
    const priorFile = priorByPath.get(priorPath);
    if (!priorFile) continue;
    carriedFiles.push({
      relativePath: outputPath, type: priorFile.type,
      contentHash: priorFile.contentHash, byteLength: priorFile.byteLength,
    });
    for (const chunk of activeChunks.filter((candidate) => candidate.relativePath === priorPath)) {
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
      carriedChunks.push({
        bindingId: chunk.bindingId,
        bindingGeneration,
        operationId: computeSourceOperationId(source.id, chunk.bindingId, carriedIngestFingerprint, run.snapshotId, bindingGeneration),
        relativePath: outputPath,
        headingPath: [...chunk.headingPath],
        occurrence: chunk.occurrence,
        segmentIndex: chunk.segmentIndex,
        contentHash: chunk.contentHash,
        ingestFingerprint: carriedIngestFingerprint,
        metadata: chunk.metadata,
        // Unchanged path: the stored sourceRef is still exactly correct. Renamed path: sourceRef
        // is a canonical function of (sourceId, relativePath, headingPath, occurrence) — see
        // requireCanonicalSourceRef — so it must be rebuilt against the NEW path or staging throws.
        sourceRef: outputPath === priorPath ? chunk.sourceRef
          : `source://${source.id}/${outputPath.split("/").map((segment) => encodeURIComponent(segment)).join("/")}` +
            `#${encodeURIComponent(sourceHeadingAnchor(chunk.headingPath))}~${chunk.occurrence}`,
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
    // BLOCKER 5a: computed once, early, and threaded through mat to every materialize call this
    // invocation makes. The materializer intentionally has no ledger access, so this is the only
    // way it can locate and validate the prior sealed snapshot needed for pre-seal carry-forward.
    // Mirrors planManifest's own (later, independent) priorRun/priorFiles computation exactly —
    // same source.activeRunId, same core.listSourceFiles(..., true) — so the two carry decisions
    // read the same prior-published truth.
    if (source.activeRunId) {
      const priorRunForCarry = core.getSourceRun(source.activeRunId);
      if (priorRunForCarry) {
        mat.priorPublication = {
          runId: priorRunForCarry.id,
          snapshotId: priorRunForCarry.snapshotId,
          ingestConfigHash: priorRunForCarry.ingestConfigHash,
          files: core.listSourceFiles(source.activeRunId, true).map((file) => ({ relativePath: file.relativePath })),
        };
      }
    }
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
    // Diagnostics from the initial pin materialization, valid only for the exact run it begot.
    // The later "scanning" materialize call below targets the same already-sealed snapshot and
    // is a cache-reuse hit (diagnostics: []) by design, so its own result is not the source of
    // truth for a freshly-pinned run; this is.
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
        // CODEX FIX (3606534127): self-heal re-verifies/repairs the snapshot that IS the active
        // publication — it has no new carry decision to make (whatever it carried, if anything,
        // was decided when it was originally sealed), so the prior-publication carry fence must
        // not apply here. Passing the ambient mat.priorPublication (which describes the CURRENT
        // active run — i.e. this exact run) would wrongly compare this snapshot's own
        // carriedFromRunId (its OWN prior, an earlier run) against itself and evict a perfectly
        // valid snapshot every time it carried anything at all.
        if (type !== "git-md") await materializeCommit(source, source.activeSnapshotId, { ...mat, priorPublication: undefined, config: run.effectiveConfig });
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
      // CODEX FIX (3606534127): same reasoning as the cleaning-state self-heal above — re-
      // materializing the CURRENTLY ACTIVE snapshot is never a "should this carry from the current
      // prior" decision, so the prior-publication fence must not apply.
      await materializeCommit(source, source.activeSnapshotId, { ...mat, priorPublication: undefined, config: activeRun.effectiveConfig });
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
        // run.snapshotId === pinned.snapshotId and run.effectiveConfig matches what `pinned` just
        // materialized with, so this is exact evidence for the run the "scanning" block is about
        // to (redundantly, cache-hit) re-materialize.
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
          // The pin no longer describes this run's snapshot: this materialize call (below) is now
          // the fresh, authoritative one for the replacement commit.
          pinnedDiagnostics = undefined;
          pinnedCarryForwardUnavailable = undefined;
          runConfigHash = computeSourceIngestConfigHash(run.effectiveConfig);
          mutate();
          snapshotPath = sourceSnapshotPath(source, run.snapshotId, runConfigHash, options.sourceStorageDir, mutate, mat.safeTreeOps);
          materialized = await materializeCommit(source, run.snapshotId, { ...mat, config: run.effectiveConfig });
        }
      }
      const scanLimits = run.effectiveConfig.limits;
      const scanned = (options.scan ?? scanSourceSnapshot)({ root: snapshotPath, config: run.effectiveConfig });
      // Merge tree-materialization skips (never reached the scanner) with scan-time skips
      // (materialized but excluded on read) into one skip-and-diagnose evidence set for this run.
      // The "scanning" state's own materialize call above is a cache-reuse hit (diagnostics: [])
      // whenever this exact run was just freshly pinned in this same invocation, so prefer that
      // pin's real evidence when it applies to this exact run.
      const skipDiagnostics = [...(pinnedDiagnostics ?? materialized.diagnostics), ...scanned.diagnostics];
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
      const priorPublishedPaths = new Set((mat.priorPublication?.files ?? []).map((file) => file.relativePath));
      const budgetResidualPaths = scanned.diagnostics
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
