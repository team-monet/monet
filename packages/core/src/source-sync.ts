import { randomUUID } from "node:crypto";
import type { IngestResult, SourceConceptRollbackResult } from "./engine";
import {
  materializeRepoMdCommit, materializeRepoMdHead, pointRepoMdCurrent, removeRepoMdMaterializations,
  repoMdSnapshotPath, revokeRepoMdCurrent,
  withRepoMdMaterializerLock,
} from "./source-materializer";
import type { RepoMdMaterializerOptions } from "./source-materializer";
import { computeSourceOperationId } from "./source-chunker";
import { computeSourceIngestConfigHash, scanSourceSnapshot } from "./source-scanner";
import type { SourceScanDiagnostic, SourceScanResult } from "./source-scanner";
import type {
  BeginSourceRunInput, BeginSourceRunResult, KnowledgeSource, PublishSourceRunInput,
  RecordSourceBindingReceiptInput, SourceChunkRecord, SourceCleanupItem, SourceFileRecord,
  SourceSyncRun, StageSourceManifestInput,
  SourceRemoval, SourceRemovalItem,
} from "./source-types";

export type RepoMdSyncFaultPoint =
  | "after-pin" | "after-begin" | "after-stage" | "after-store" | "after-engine-written"
  | "after-refresh" | "after-committed" | "after-activation" | "after-publish" | "after-current" | "after-cleanup"
  | "after-remove-current" | "after-remove-item" | "after-remove-snapshots"
  | "before-remove-complete" | "after-remove-complete";

export interface RepoMdSyncOptions {
  lockStaleMs?: number;
  fault?: (point: RepoMdSyncFaultPoint) => void;
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
}

interface RuntimeOptions extends RepoMdSyncOptions {
  sourceStorageDir: string;
  idGen?: () => string;
  materializer?: Partial<RepoMdMaterializerOptions>;
  scan?: typeof scanSourceSnapshot;
}

const naturalKey = (chunk: Pick<SourceChunkRecord, "relativePath" | "headingPath" | "occurrence" | "segmentIndex">): string =>
  JSON.stringify([chunk.relativePath, chunk.headingPath, chunk.occurrence, chunk.segmentIndex]);

function requireRepoLineage(core: SourceSyncCorePort, sourceId: string): KnowledgeSource {
  const source = core.getSource(sourceId, { includeTombstoned: true });
  if (!source || source.type !== "repo-md") {
    throw new Error("syncRepoMdSource requires a registered repo-md source lineage");
  }
  return source;
}

function requireActiveRepoSource(core: SourceSyncCorePort, sourceId: string): KnowledgeSource {
  const source = requireRepoLineage(core, sourceId);
  if (source.lifecycle !== "active") {
    throw new Error("syncRepoMdSource requires an active registered repo-md source");
  }
  return source;
}

function materializerOptions(options: RuntimeOptions): RepoMdMaterializerOptions {
  return {
    sourceStorageDir: options.sourceStorageDir,
    lockStaleMs: options.lockStaleMs,
    ...options.materializer,
  };
}

function planManifest(
  core: SourceSyncCorePort,
  source: KnowledgeSource,
  run: SourceSyncRun,
  scan: SourceScanResult,
  idGen: () => string,
): StageSourceManifestInput {
  const active = source.activeRunId ? core.listSourceChunks(source.activeRunId, true) : [];
  const byIdentity = new Map(active.filter((chunk) => chunk.lifecycle === "active").map((chunk) => [naturalKey(chunk), chunk]));
  const chunks = scan.chunks.map((chunk) => {
    const prior = byIdentity.get(naturalKey(chunk));
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
      core.recordSourceBindingReceipt({ runId: run.id, bindingId: staged.bindingId, writeState: "skipped" });
      continue;
    }
    if (staged.writeState === "intent") {
      const stored = await core.storeSource(staged.content, {
        circle: source.circle,
        sourceRefs: [staged.sourceRef],
        operationId: staged.operationId,
        ...(prior?.conceptId ? { attachTo: prior.conceptId } : { resolution: "forceNew" as const }),
      });
      options.fault?.("after-store");
      staged = core.recordSourceBindingReceipt({
        runId: run.id, bindingId: staged.bindingId, conceptId: stored.conceptId,
        observationId: stored.observationId, predecessorObservationId: prior?.observationId ?? null,
        writeState: "engine-written",
      });
      options.fault?.("after-engine-written");
    }
    if (!staged.conceptId || !staged.observationId) throw new Error("staged source receipt is incomplete");
    if (staged.predecessorObservationId) {
      await core.refreshSourceConcept(staged.conceptId, staged.observationId, staged.predecessorObservationId);
      options.fault?.("after-refresh");
    }
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
      await core.refreshSourceConcept(staged.conceptId, staged.observationId, staged.predecessorObservationId);
      options.fault?.("after-refresh");
    }
    core.recordSourceBindingReceipt({ runId: run.id, bindingId: staged.bindingId, writeState: "committed" });
    options.fault?.("after-committed");
  }
}

async function drainCleanup(core: SourceSyncCorePort, run: SourceSyncRun, options: RuntimeOptions): Promise<void> {
  const stagedByBinding = new Map(core.listSourceChunks(run.id).map((chunk) => [chunk.bindingId, chunk]));
  for (const item of core.listSourceCleanupItems(run.id)) {
    if (item.acknowledgedAt !== null) continue;
    if (item.kind === "quarantine-non-authorizing") {
      core.acknowledgeSourceCleanup(item.id);
    } else if (!item.conceptId || !item.observationId) {
      throw new Error("authorized source cleanup is missing engine evidence IDs");
    } else if (item.kind === "retire-absent" || item.predecessorObservationId === null) {
      core.supersedeObservation(item.observationId, null);
      core.retireConcept(item.conceptId);
      core.acknowledgeSourceCleanup(item.id);
    } else {
      const staged = stagedByBinding.get(item.bindingId);
      if (staged?.writeState === "committed") {
        await core.rollbackSourceRunBinding(run.id, item.bindingId);
      } else {
        core.supersedeObservation(item.observationId, null);
      }
      core.acknowledgeSourceCleanup(item.id);
    }
    options.fault?.("after-cleanup");
  }
}

function isFenceError(error: unknown): boolean {
  return error instanceof Error && /fence is stale/.test(error.message);
}

async function recoverRemovedRepoSource(
  core: SourceSyncCorePort,
  run: SourceSyncRun,
  options: RuntimeOptions,
): Promise<void> {
  if (run.state === "scanning") {
    run = core.abortSourceRun(run.id, "failed", "source lifecycle is no longer active");
  } else if (run.state === "staging") {
    await reconcileExistingStagedBindings(core, run, options);
    run = core.abortSourceRun(run.id, "failed", "source lifecycle is no longer active");
  } else if (run.state === "activating") {
    run = core.abortSourceRun(run.id, "failed", "source lifecycle is no longer active");
  }
  if (run.state === "aborted" || run.state === "cleaning") await drainCleanup(core, run, options);
}

async function removeTombstonedRepoSource(
  core: SourceSyncCorePort,
  source: KnowledgeSource,
  options: RuntimeOptions,
): Promise<RepoMdSyncResult> {
  let removal = core.beginSourceRemoval(source.id);
  if (removal.state !== "complete") {
    revokeRepoMdCurrent(source.id, options.sourceStorageDir);
    options.fault?.("after-remove-current");
    for (const item of core.listSourceRemovalItems(source.id)) {
      if (item.acknowledgedAt !== null) continue;
      core.supersedeObservation(item.observationId, null);
      core.retireConcept(item.conceptId);
      core.acknowledgeSourceRemovalItem(item.id);
      options.fault?.("after-remove-item");
    }
    removeRepoMdMaterializations(source.id, options.sourceStorageDir);
    options.fault?.("after-remove-snapshots");
    removal = core.markSourceRemovalFilesRevoked(source.id);
    options.fault?.("before-remove-complete");
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
  const mat = materializerOptions(options);
  return withRepoMdMaterializerLock(sourceId, mat, async () => {
    let source = requireRepoLineage(core, sourceId);
    let run = core.resumeSourceRun(sourceId);

    if (source.lifecycle !== "active") {
      if (run) await recoverRemovedRepoSource(core, run, options);
      const stillResumable = core.resumeSourceRun(sourceId);
      if (stillResumable) throw new Error("tombstoned source recovery did not converge its resumable run");
      return removeTombstonedRepoSource(core, source, options);
    }

    if (run?.state === "aborted") {
      await drainCleanup(core, run, options);
      run = core.resumeSourceRun(sourceId);
    }
    if (run?.state === "cleaning") {
      source = requireActiveRepoSource(core, sourceId);
      if (source.activeSnapshotId) {
        await materializeRepoMdCommit(source, source.activeSnapshotId, { ...mat, config: run.effectiveConfig });
        pointRepoMdCurrent(source.id, source.activeSnapshotId, computeSourceIngestConfigHash(run.effectiveConfig), mat);
      }
      await drainCleanup(core, run, options);
      return { sourceId, snapshotId: source.activeSnapshotId, runId: run.id, status: "published", diagnostics: [] };
    }

    source = requireActiveRepoSource(core, sourceId);
    if (source.activeSnapshotId) {
      const activeRun = source.activeRunId ? core.getSourceRun(source.activeRunId) : null;
      if (!activeRun) throw new Error("active repo-md source is missing its published run");
      await materializeRepoMdCommit(source, source.activeSnapshotId, { ...mat, config: activeRun.effectiveConfig });
      pointRepoMdCurrent(source.id, source.activeSnapshotId, computeSourceIngestConfigHash(activeRun.effectiveConfig), mat);
    }

    if (!run) {
      const pinned = await materializeRepoMdHead(source, mat);
      options.fault?.("after-pin");
      const begun = core.beginSourceRun({ sourceId, snapshotId: pinned.snapshotId });
      if (begun.kind === "noop") {
        pointRepoMdCurrent(source.id, pinned.snapshotId, pinned.configHash, mat);
        return { sourceId, snapshotId: pinned.snapshotId, runId: null, status: "noop", diagnostics: [] };
      }
      run = begun.run;
      options.fault?.("after-begin");
    }

    const runConfigHash = computeSourceIngestConfigHash(run.effectiveConfig);
    const snapshotPath = repoMdSnapshotPath(source.id, run.snapshotId, runConfigHash, options.sourceStorageDir);
    if (run.state === "scanning") {
      await materializeRepoMdCommit(source, run.snapshotId, { ...mat, config: run.effectiveConfig });
      const scanned = (options.scan ?? scanSourceSnapshot)({ root: snapshotPath, config: run.effectiveConfig });
      if (!scanned.publishable || scanned.status === "partial") {
        core.abortSourceRun(run.id, "partial", JSON.stringify(scanned.diagnostics));
        return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "partial", diagnostics: scanned.diagnostics };
      }
      core.stageSourceManifest(planManifest(core, source, run, scanned, options.idGen ?? randomUUID));
      options.fault?.("after-stage");
      run = core.getSourceRun(run.id)!;
    }

    if (run.state === "staging") {
      await materializeStagedBindings(core, source, run, options);
      try {
        core.beginSourceActivation(run.id);
      } catch (error) {
        if (!isFenceError(error)) throw error;
        // Every intent/engine-written row is converged before abort so cleanup authorization is exact.
        await materializeStagedBindings(core, source, run, options);
        const aborted = core.abortSourceRun(run.id, "failed", "source run fence is stale");
        await drainCleanup(core, aborted, options);
        return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "aborted", diagnostics: [] };
      }
      run = core.getSourceRun(run.id)!;
      options.fault?.("after-activation");
    }

    if (run.state === "activating") {
      try {
        core.publishSourceRun({ runId: run.id, activationToken: run.activationToken! });
      } catch (error) {
        if (!isFenceError(error)) throw error;
        const aborted = core.abortSourceRun(run.id, "failed", "source run fence is stale");
        await drainCleanup(core, aborted, options);
        return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "aborted", diagnostics: [] };
      }
      pointRepoMdCurrent(source.id, run.snapshotId, runConfigHash, mat);
      options.fault?.("after-publish");
      run = core.getSourceRun(run.id)!;
    }
    if (run.state === "cleaning") await drainCleanup(core, run, options);
    pointRepoMdCurrent(source.id, run.snapshotId, runConfigHash, mat);
    options.fault?.("after-current");
    return { sourceId, snapshotId: run.snapshotId, runId: run.id, status: "published", diagnostics: [] };
  });
}
