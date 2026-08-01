import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HashingEmbeddingProvider } from "../embedding";
import { MonetCore } from "../engine";
import { computeSourceContentHash, computeSourceIngestFingerprint, computeSourceOperationId } from "../source-chunker";
import { computeSourceManifestHash } from "../source-scanner";
import type { EmbeddingProvider } from "../embedding";
import type { SourceLedger } from "../source-ledger";
import type { SourceManifestSkippedFileInput, SourceSyncRun, StageSourceManifestInput } from "../source-types";
import type { StoragePort } from "../storage";

const sourceInput = (id: string, localPath: string) => ({
  id,
  type: "repo-md" as const,
  name: id,
  localPath,
  circle: id,
  access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] },
  writeBack: "none" as const,
});

type ManifestOverrides = Partial<StageSourceManifestInput> & { bindingGeneration?: number };

const manifest = (run: SourceSyncRun, overrides: ManifestOverrides = {}): StageSourceManifestInput => {
  const files = overrides.files ?? [{ relativePath: "README.md", type: "file" as const, contentHash: "file-1", byteLength: 12, title: "README" }];
  const content = "Hello world";
  const contentHash = computeSourceContentHash(Buffer.from(content, "utf8"));
  const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
  const ingestFingerprint = computeSourceIngestFingerprint({
    contentHash, headingPath: ["Intro"], metadata, ingestConfigHash: run.ingestConfigHash,
  });
  const bindingGeneration = overrides.bindingGeneration ?? 1;
  const chunks = overrides.chunks ?? [{
    bindingId: "binding-1",
    bindingGeneration,
    operationId: computeSourceOperationId(run.sourceId, "binding-1", ingestFingerprint, run.snapshotId, bindingGeneration),
    relativePath: "README.md",
    headingPath: ["Intro"],
    occurrence: 1,
    segmentIndex: 1,
    documentSequence: 1,
    contentHash,
    ingestFingerprint,
    metadata,
    sourceRef: `source://${run.sourceId}/README.md#intro~1`,
    content,
  }];
  return {
    runId: run.id,
    scanStatus: overrides.scanStatus ?? "complete",
    manifestHash: overrides.manifestHash ?? computeSourceManifestHash(files),
    files,
    chunks,
    ...(overrides.skipped !== undefined ? { skipped: overrides.skipped } : {}),
  };
};

async function materialize(
  core: MonetCore,
  run: SourceSyncRun,
  staged: StageSourceManifestInput,
  writeState: "engine-written" | "committed" = "committed",
) {
  const chunk = staged.chunks[0];
  if (!chunk) throw new Error("materialize requires one chunk");
  const activeRunId = core.getSource(run.sourceId)?.activeRunId;
  const prior = activeRunId
    ? core.listSourceChunks(activeRunId, true).find((candidate) => candidate.bindingId === chunk.bindingId)
    : undefined;
  const stored = await core.storeSource(chunk.content, {
    circle: run.sourceId,
    sourceRefs: [chunk.sourceRef],
    operationId: chunk.operationId,
    ...(prior?.conceptId ? { attachTo: prior.conceptId } : { resolution: "forceNew" as const }),
  });
  if (prior?.observationId && writeState === "committed") {
    await core.supersedeSourceChunkObservation(stored.conceptId, stored.observationId, prior.observationId);
  }
  const receipt = core.recordSourceBindingReceipt({
    runId: run.id,
    bindingId: chunk.bindingId,
    conceptId: stored.conceptId,
    observationId: stored.observationId,
    predecessorObservationId: prior?.observationId ?? null,
    writeState,
  });
  return { stored, receipt, prior };
}

function manifestWithContent(run: SourceSyncRun, bindingGeneration: number, content: string): StageSourceManifestInput {
  const base = manifest(run, { bindingGeneration });
  const chunk = base.chunks[0];
  const contentHash = computeSourceContentHash(Buffer.from(content, "utf8"));
  const ingestFingerprint = computeSourceIngestFingerprint({
    contentHash, headingPath: chunk.headingPath, metadata: chunk.metadata, ingestConfigHash: run.ingestConfigHash,
  });
  return manifest(run, { chunks: [{
    ...chunk, bindingGeneration, content, contentHash, ingestFingerprint,
    operationId: computeSourceOperationId(run.sourceId, chunk.bindingId, ingestFingerprint, run.snapshotId, bindingGeneration),
  }] });
}

describe("source ledger publication kernel", () => {
  it("stages receipts monotonically, publishes atomically, and no-ops an active snapshot", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-a"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-1" });
      expect(begun.kind).toBe("started");
      if (begun.kind !== "started") throw new Error("expected started run");

      const staged = manifest(begun.run);
      expect(core.stageSourceManifest(staged).state).toBe("staging");
      expect(() => core.beginSourceActivation(begun.run.id)).toThrow(/every staged chunk/);
      expect(core.listSourceChunks(begun.run.id)[0].writeState).toBe("intent");
      const written = await materialize(core, begun.run, staged, "engine-written");
      core.recordSourceBindingReceipt({ runId: begun.run.id, bindingId: "binding-1", writeState: "committed" });
      expect(core.recordSourceBindingReceipt({ runId: begun.run.id, bindingId: "binding-1", conceptId: written.stored.conceptId, observationId: written.stored.observationId, predecessorObservationId: null, writeState: "committed" }).writeState).toBe("committed");

      const token = core.beginSourceActivation(begun.run.id);
      const published = core.publishSourceRun({ runId: begun.run.id, activationToken: token, expectedManifestHash: staged.manifestHash });
      expect(published).toMatchObject({ state: "cleaned", result: "success", fileCount: 1, chunkCount: 1 });
      expect(core.publishSourceRun({ runId: begun.run.id, activationToken: token, expectedManifestHash: staged.manifestHash })).toEqual(published);
      await expect(core.rollbackSourceRunBinding(begun.run.id, "binding-1")).rejects.toThrow(/no durable authorized/);
      expect(core.getSource("source-a")).toMatchObject({ activeRunId: begun.run.id, activeSnapshotId: "snap-1", activeIngestConfigHash: begun.run.ingestConfigHash, appliedConfigVersion: 1 });
      expect(core.listSourceChunks(begun.run.id, true)[0]).toMatchObject({ lifecycle: "active", conceptId: written.stored.conceptId, observationId: written.stored.observationId, writeState: "committed" });

      const before = core.listSourceRuns("source-a");
      const beforeDelta = core.exportDelta(0);
      const db = (core as unknown as { db: StoragePort }).db;
      const beforeClock = db.prepare("SELECT last_mutation_at FROM sync_meta WHERE singleton=1").get();
      expect(core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-1" }).kind).toBe("noop");
      expect(core.listSourceRuns("source-a")).toEqual(before);
      expect(core.exportDelta(0)).toEqual(beforeDelta);
      expect(db.prepare("SELECT last_mutation_at FROM sync_meta WHERE singleton=1").get()).toEqual(beforeClock);
    } finally {
      core.close();
    }
  });

  it("resumes an exact run, rejects conflicting staging, fences activation, and permits partial abort only", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-a-ledger-two"));
      const input = { sourceId: "source-a", snapshotId: "snap-1" };
      const first = core.beginSourceRun(input);
      const resumed = core.beginSourceRun(input);
      expect(first.kind).toBe("started"); expect(resumed.kind).toBe("started");
      if (first.kind !== "started" || resumed.kind !== "started") throw new Error("expected started runs");
      expect(resumed.run.id).toBe(first.run.id);
      expect(() => core.beginSourceRun({ ...input, snapshotId: "other" })).toThrow(/conflicting nonterminal/);
      expect(() => core.stageSourceManifest(manifest(first.run, {
        chunks: [{ ...manifest(first.run).chunks[0], occurrence: 0 }],
      }))).toThrow(/occurrence.*>= 1/);

      const partial = manifest(first.run, { scanStatus: "partial" });
      expect(core.stageSourceManifest(partial).state).toBe("staging");
      expect(core.stageSourceManifest(partial).state).toBe("staging");
      const conflicting = manifest(first.run, {
        scanStatus: "partial",
        files: [{ relativePath: "OTHER.md", type: "file", contentHash: "other", byteLength: 1, title: "OTHER" }],
        chunks: [],
      });
      expect(() => core.stageSourceManifest(conflicting)).toThrow(/conflicts/);
      expect(() => core.beginSourceActivation(first.run.id)).toThrow(/partial manifests/);
      expect(core.abortSourceRun(first.run.id, "partial", "scanner incomplete").state).toBe("aborted");
      expect(core.listSourceCleanupItems(first.run.id)).toEqual([]);

      const second = core.beginSourceRun({ ...input, snapshotId: "snap-2" });
      if (second.kind !== "started") throw new Error("expected started run");
      core.stageSourceManifest(manifest(second.run, { chunks: [] }));
      core.updateSource("source-a", { name: "changed" });
      expect(() => core.beginSourceActivation(second.run.id)).toThrow(/fence is stale/);
      expect(core.abortSourceRun(second.run.id, "failed").state).toBe("aborted");
      const refreshed = core.beginSourceRun({ ...input, snapshotId: "snap-3" });
      expect(refreshed.kind).toBe("started");
      if (refreshed.kind === "started") core.abortSourceRun(refreshed.run.id, "failed");

      core.createSource(sourceInput("source-b", "/tmp/source-b-ledger-two"));
      const removed = core.beginSourceRun({ ...input, sourceId: "source-b" });
      if (removed.kind !== "started") throw new Error("expected removed-source run");
      core.stageSourceManifest(manifest(removed.run, { files: [], chunks: [] }));
      core.removeSource("source-b");
      expect(() => core.beginSourceActivation(removed.run.id)).toThrow(/fence is stale/);
      expect(core.abortSourceRun(removed.run.id, "failed").state).toBe("aborted");
    } finally {
      core.close();
    }
  });

  it("revalidates committed engine receipts immediately before publication", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-final-receipt"));
      const first = core.beginSourceRun({ sourceId: "source-a", snapshotId: "first" });
      if (first.kind !== "started") throw new Error("expected first run");
      const firstManifest = manifestWithContent(first.run, 1, "stable predecessor");
      core.stageSourceManifest(firstManifest);
      const prior = await materialize(core, first.run, firstManifest);
      core.publishSourceRun({ runId: first.run.id, activationToken: core.beginSourceActivation(first.run.id) });

      const second = core.beginSourceRun({ sourceId: "source-a", snapshotId: "second" });
      if (second.kind !== "started") throw new Error("expected second run");
      const secondManifest = manifestWithContent(second.run, 2, "successor changed after receipt");
      core.stageSourceManifest(secondManifest);
      const successor = await materialize(core, second.run, secondManifest, "committed");
      const token = core.beginSourceActivation(second.run.id);
      core.supersedeObservation(successor.stored.observationId, null);

      expect(() => core.publishSourceRun({ runId: second.run.id, activationToken: token })).toThrow(/stale|active observation/);
      expect(core.getSource("source-a")).toMatchObject({ activeRunId: first.run.id, activeSnapshotId: "first" });
      expect(core.listSourceChunks(first.run.id, true)[0]).toMatchObject({
        lifecycle: "active", conceptId: prior.stored.conceptId, observationId: prior.stored.observationId,
      });
      expect(core.listSourceChunks(second.run.id, true)).toEqual([]);
      expect(core.getSourceRun(second.run.id)?.state).toBe("activating");
    } finally {
      core.close();
    }
  });

  it("creates cleanup only for exact bindings absent from a complete replacement", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-a-ledger-three"));
      const one = core.beginSourceRun({ sourceId: "source-a", snapshotId: "a" });
      if (one.kind !== "started") throw new Error("expected run");
      const stagedOne = manifest(one.run);
      core.stageSourceManifest(stagedOne);
      const firstReceipt = await materialize(core, one.run, stagedOne);
      core.publishSourceRun({ runId: one.run.id, activationToken: core.beginSourceActivation(one.run.id) });

      const two = core.beginSourceRun({ sourceId: "source-a", snapshotId: "b" });
      if (two.kind !== "started") throw new Error("expected run");
      core.stageSourceManifest(manifest(two.run, { files: [], chunks: [] }));
      const cleaning = core.publishSourceRun({ runId: two.run.id, activationToken: core.beginSourceActivation(two.run.id) });
      expect(cleaning.state).toBe("cleaning");
      const items = core.listSourceCleanupItems(two.run.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ bindingId: "binding-1", conceptId: firstReceipt.stored.conceptId, observationId: firstReceipt.stored.observationId, acknowledgedAt: null });
      expect(() => core.acknowledgeSourceCleanup(items[0].id)).toThrow(/terminally superseded/);
      expect(core.getSourceRun(two.run.id)?.state).toBe("cleaning");
      core.supersedeObservation(firstReceipt.stored.observationId, null);
      core.retireConcept(firstReceipt.stored.conceptId);
      core.acknowledgeSourceCleanup(items[0].id);
      expect(core.getSourceRun(two.run.id)?.state).toBe("cleaned");
      const acknowledged = core.acknowledgeSourceCleanup(items[0].id);
      expect(acknowledged.acknowledgedAt).not.toBeNull();
      expect(core.getSourceRun(two.run.id)?.state).toBe("cleaned");
    } finally {
      core.close();
    }
  });

  it("supports A-to-B-to-A and same-revision new-config publications without snapshot key collisions", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-aba"));
      let generation = 0;
      const publish = async (snapshotId: string, content: string) => {
        const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId });
        if (begun.kind !== "started") throw new Error("expected run");
        generation++;
        const staged = manifestWithContent(begun.run, generation, content);
        const operationId = staged.chunks[0].operationId;
        core.stageSourceManifest(staged);
        await materialize(core, begun.run, staged);
        core.publishSourceRun({ runId: begun.run.id, activationToken: core.beginSourceActivation(begun.run.id) });
        return { runId: begun.run.id, operationId };
      };

      const firstA = await publish("a", "Version A");
      await publish("b", "Version B");
      const secondA = await publish("a", "Version A");
      expect(secondA.runId).not.toBe(firstA.runId);
      expect(secondA.operationId).not.toBe(firstA.operationId);
      expect(core.listSourceChunks(secondA.runId, true)[0].bindingGeneration).toBe(3);
      expect(core.nextSourceBindingGeneration("source-a", "binding-1")).toBe(4);

      const updated = core.updateSource("source-a", { include: ["AGENTS.md"] });
      const sameRevision = await publish("a", "Version A");
      expect(sameRevision.runId).not.toBe(secondA.runId);
      expect(core.getSource("source-a")).toMatchObject({
        activeSnapshotId: "a",
        activeIngestConfigHash: core.getSourceRun(sameRevision.runId)?.ingestConfigHash,
        appliedConfigVersion: 2,
      });
      const db = (core as unknown as { db: StoragePort }).db;
      expect((db.prepare("SELECT COUNT(*) AS count FROM source_snapshots WHERE source_id='source-a' AND snapshot_id='a'").get() as { count: number }).count).toBe(3);
    } finally {
      core.close();
    }
  });

  it("keeps a prior publication active when a partial replacement aborts", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-partial"));
      const first = core.beginSourceRun({ sourceId: "source-a", snapshotId: "a" });
      if (first.kind !== "started") throw new Error("expected run");
      const staged = manifest(first.run);
      core.stageSourceManifest(staged);
      await materialize(core, first.run, staged);
      core.publishSourceRun({ runId: first.run.id, activationToken: core.beginSourceActivation(first.run.id) });

      const partial = core.beginSourceRun({ sourceId: "source-a", snapshotId: "b" });
      if (partial.kind !== "started") throw new Error("expected run");
      core.stageSourceManifest(manifest(partial.run, { scanStatus: "partial", files: [], chunks: [] }));
      core.abortSourceRun(partial.run.id, "partial", "budget");
      expect(core.getSource("source-a")).toMatchObject({ activeRunId: first.run.id, activeSnapshotId: "a", appliedConfigVersion: 1 });
      expect(core.listSourceCleanupItems(partial.run.id)).toEqual([]);
    } finally {
      core.close();
    }
  });

  it("rolls publication back atomically on an injected SQLite fault and retries the activation token", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-fault"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "a" });
      if (begun.kind !== "started") throw new Error("expected run");
      const staged = manifest(begun.run);
      core.stageSourceManifest(staged);
      await materialize(core, begun.run, staged);
      const token = core.beginSourceActivation(begun.run.id);
      const db = (core as unknown as { db: StoragePort }).db;
      db.exec(`CREATE TRIGGER fail_source_publish BEFORE UPDATE OF active_run_id ON knowledge_sources
        BEGIN SELECT RAISE(ABORT, 'injected publication fault'); END`);
      expect(() => core.publishSourceRun({ runId: begun.run.id, activationToken: token })).toThrow(/injected publication fault/);
      expect(core.getSourceRun(begun.run.id)?.state).toBe("activating");
      expect(core.listSourceFiles(begun.run.id, true)).toEqual([]);
      expect(core.listSourceChunks(begun.run.id, true)).toEqual([]);
      expect(core.getSource("source-a")?.activeRunId).toBeNull();
      db.exec("DROP TRIGGER fail_source_publish");
      expect(core.publishSourceRun({ runId: begun.run.id, activationToken: token }).state).toBe("cleaned");
    } finally {
      core.close();
    }
  });

  it("reopens and resumes scanning, staging, activating, and cleaning states", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-ledger-resume-"));
    const path = join(dir, "monet.db");
    try {
      const first = new MonetCore(path);
      first.createSource(sourceInput("source-a", join(dir, "repo")));
      const begun = first.beginSourceRun({ sourceId: "source-a", snapshotId: "a" });
      if (begun.kind !== "started") throw new Error("expected run");
      const runId = begun.run.id;
      first.close();

      const scanning = new MonetCore(path);
      expect(scanning.resumeSourceRun("source-a")).toMatchObject({ id: runId, state: "scanning", scanConfigVersion: begun.run.scanConfigVersion });
      const staged = manifest(begun.run);
      scanning.stageSourceManifest(staged);
      scanning.close();

      const staging = new MonetCore(path);
      expect(staging.resumeSourceRun("source-a")).toMatchObject({ id: runId, state: "staging" });
      const original = await materialize(staging, begun.run, staged);
      const token = staging.beginSourceActivation(runId);
      staging.close();

      const activating = new MonetCore(path);
      expect(activating.resumeSourceRun("source-a")).toMatchObject({ id: runId, state: "activating", activationToken: token });
      expect(activating.beginSourceActivation(runId)).toBe(token);
      activating.publishSourceRun({ runId, activationToken: token });
      const replacement = activating.beginSourceRun({ sourceId: "source-a", snapshotId: "b" });
      if (replacement.kind !== "started") throw new Error("expected replacement");
      activating.stageSourceManifest(manifest(replacement.run, { files: [], chunks: [] }));
      expect(activating.publishSourceRun({
        runId: replacement.run.id,
        activationToken: activating.beginSourceActivation(replacement.run.id),
      }).state).toBe("cleaning");
      activating.close();

      const cleaning = new MonetCore(path);
      expect(cleaning.resumeSourceRun("source-a")).toMatchObject({ id: replacement.run.id, state: "cleaning", result: "success" });
      const [item] = cleaning.listSourceCleanupItems(replacement.run.id);
      cleaning.supersedeObservation(original.stored.observationId, null);
      cleaning.retireConcept(original.stored.conceptId);
      cleaning.acknowledgeSourceCleanup(item.id);
      expect(cleaning.resumeSourceRun("source-a")).toBeNull();
      expect(cleaning.getSourceRun(replacement.run.id)?.state).toBe("cleaned");
      cleaning.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps source runs isolated and excludes ledger rows from generic sync", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-a"));
      core.createSource(sourceInput("source-b", "/tmp/source-ledger-b"));
      const before = core.exportDelta(0);
      const run = core.beginSourceRun({ sourceId: "source-a", snapshotId: "a" });
      if (run.kind !== "started") throw new Error("expected run");
      core.stageSourceManifest(manifest(run.run, { files: [], chunks: [] }));
      core.publishSourceRun({ runId: run.run.id, activationToken: core.beginSourceActivation(run.run.id) });
      expect(core.listSourceRuns("source-b")).toEqual([]);
      const delta = core.exportDelta(0);
      expect(delta).toEqual(before);
      expect(JSON.stringify(delta)).not.toContain("source_sync_runs");
      expect(JSON.stringify(delta)).not.toContain("snap-1");
    } finally {
      core.close();
    }
  });

  it("allows skip only for an unchanged active binding and carries its full receipt without deletion", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-skip"));
      const first = core.beginSourceRun({ sourceId: "source-a", snapshotId: "a" });
      if (first.kind !== "started") throw new Error("expected first run");
      const firstManifest = manifest(first.run);
      core.stageSourceManifest(firstManifest);
      expect(() => core.recordSourceBindingReceipt({ runId: first.run.id, bindingId: "binding-1", writeState: "skipped" })).toThrow(/prior active binding/);
      expect(() => core.recordSourceBindingReceipt({ runId: first.run.id, bindingId: "binding-1", conceptId: "c", writeState: "committed" })).toThrow(/observationId/);
      const firstReceipt = await materialize(core, first.run, firstManifest);
      core.publishSourceRun({ runId: first.run.id, activationToken: core.beginSourceActivation(first.run.id) });

      const second = core.beginSourceRun({ sourceId: "source-a", snapshotId: "b" });
      if (second.kind !== "started") throw new Error("expected replacement run");
      core.stageSourceManifest(manifest(second.run, { bindingGeneration: 2 }));
      const carried = core.recordSourceBindingReceipt({ runId: second.run.id, bindingId: "binding-1", writeState: "skipped" });
      expect(carried).toMatchObject({ conceptId: firstReceipt.stored.conceptId, observationId: firstReceipt.stored.observationId, predecessorObservationId: null, writeState: "skipped" });
      const replacement = core.publishSourceRun({ runId: second.run.id, activationToken: core.beginSourceActivation(second.run.id) });
      expect(replacement.state).toBe("cleaned");
      expect(core.listSourceCleanupItems(second.run.id)).toEqual([]);
      expect(core.listSourceChunks(second.run.id, true)[0]).toMatchObject({ lifecycle: "active", conceptId: firstReceipt.stored.conceptId, observationId: firstReceipt.stored.observationId });
      expect(core.listSourceChunks(first.run.id, true)[0].lifecycle).toBe("superseded");

      const changed = core.beginSourceRun({ sourceId: "source-a", snapshotId: "c" });
      if (changed.kind !== "started") throw new Error("expected changed run");
      const changedContent = "changed content";
      const changedContentHash = computeSourceContentHash(Buffer.from(changedContent, "utf8"));
      const changedBase = manifest(changed.run, { bindingGeneration: 3 }).chunks[0];
      const changedFingerprint = computeSourceIngestFingerprint({
        contentHash: changedContentHash, headingPath: changedBase.headingPath,
        metadata: changedBase.metadata, ingestConfigHash: changed.run.ingestConfigHash,
      });
      core.stageSourceManifest(manifest(changed.run, { chunks: [{
        ...changedBase, content: changedContent, contentHash: changedContentHash,
        ingestFingerprint: changedFingerprint,
        bindingGeneration: 3,
        operationId: computeSourceOperationId("source-a", "binding-1", changedFingerprint, "c", 3),
      }] }));
      expect(() => core.recordSourceBindingReceipt({
        runId: changed.run.id, bindingId: "binding-1", writeState: "skipped",
      })).toThrow(/unchanged prior active binding/);
    } finally {
      core.close();
    }
  });

  it("persists orphan reconciliation on abort, gates new runs, and resumes cleanup after reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-ledger-orphan-"));
    const path = join(dir, "monet.db");
    try {
      const core = new MonetCore(path);
      core.createSource(sourceInput("source-a", join(dir, "repo")));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "a" });
      if (begun.kind !== "started") throw new Error("expected run");
      const staged = manifest(begun.run);
      core.stageSourceManifest(staged);
      const orphan = await materialize(core, begun.run, staged, "engine-written");
      expect(core.abortSourceRun(begun.run.id, "failed", "materializer stopped").state).toBe("aborted");
      expect(core.abortSourceRun(begun.run.id, "failed", "materializer stopped").state).toBe("aborted");
      expect(core.listSourceCleanupItems(begun.run.id)).toHaveLength(1);
      core.close();

      const reopened = new MonetCore(path);
      expect(reopened.resumeSourceRun("source-a")).toMatchObject({ id: begun.run.id, state: "aborted" });
      expect(() => reopened.beginSourceRun({ sourceId: "source-a", snapshotId: "b" })).toThrow(/pending orphan reconciliation/);
      const [item] = reopened.listSourceCleanupItems(begun.run.id);
      expect(item).toMatchObject({ kind: "reconcile-orphan", conceptId: orphan.stored.conceptId, observationId: orphan.stored.observationId, acknowledgedAt: null });
      expect(() => reopened.acknowledgeSourceCleanup(item.id)).toThrow(/terminally superseded/);
      expect(reopened.listSourceCleanupItems(begun.run.id)[0].acknowledgedAt).toBeNull();
      reopened.supersedeObservation(orphan.stored.observationId, null);
      reopened.retireConcept(orphan.stored.conceptId);
      reopened.acknowledgeSourceCleanup(item.id);
      expect(reopened.resumeSourceRun("source-a")).toBeNull();
      expect(reopened.beginSourceRun({ sourceId: "source-a", snapshotId: "b" }).kind).toBe("started");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers a durable engine write from an intent row and reserves a new generation after cleanup", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-intent-crash"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "same-snapshot" });
      if (begun.kind !== "started") throw new Error("expected run");
      const staged = manifest(begun.run, { bindingGeneration: 1 });
      core.stageSourceManifest(staged);
      expect(core.stageSourceManifest(staged).state).toBe("staging");
      const firstOperationId = staged.chunks[0].operationId;
      const written = await core.storeSource(staged.chunks[0].content, {
        circle: "source-a", sourceRefs: [staged.chunks[0].sourceRef], operationId: firstOperationId, resolution: "forceNew",
      });
      expect(core.listSourceChunks(begun.run.id)[0]).toMatchObject({ writeState: "intent", conceptId: null, observationId: null });

      expect(core.abortSourceRun(begun.run.id, "failed", "lost response before ledger receipt").state).toBe("aborted");
      expect(core.abortSourceRun(begun.run.id, "failed", "lost response before ledger receipt").state).toBe("aborted");
      const [cleanup] = core.listSourceCleanupItems(begun.run.id);
      expect(cleanup).toMatchObject({
        kind: "reconcile-orphan", bindingId: "binding-1",
        conceptId: written.conceptId, observationId: written.observationId, predecessorObservationId: null,
      });
      expect(() => core.beginSourceRun({ sourceId: "source-a", snapshotId: "same-snapshot" })).toThrow(/pending orphan reconciliation/);

      core.supersedeObservation(written.observationId, null);
      core.retireConcept(written.conceptId);
      expect(core.abortSourceRun(begun.run.id, "failed", "lost response before ledger receipt").state).toBe("aborted");
      core.acknowledgeSourceCleanup(cleanup.id);

      expect(core.nextSourceBindingGeneration("source-a", "binding-1")).toBe(2);
      const retry = core.beginSourceRun({ sourceId: "source-a", snapshotId: "same-snapshot" });
      if (retry.kind !== "started") throw new Error("expected retry run");
      const retryManifest = manifest(retry.run, { bindingGeneration: 2 });
      expect(retryManifest.chunks[0].operationId).not.toBe(firstOperationId);
      core.stageSourceManifest(retryManifest);
      await materialize(core, retry.run, retryManifest);
      const published = core.publishSourceRun({
        runId: retry.run.id, activationToken: core.beginSourceActivation(retry.run.id),
      });
      expect(published.state).toBe("cleaned");
      expect(core.listSourceChunks(retry.run.id, true)[0]).toMatchObject({ bindingGeneration: 2, lifecycle: "active" });
    } finally {
      core.close();
    }
  });

  it("acknowledges an update orphan only after terminal cleanup preserves its active predecessor", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-update-orphan"));
      const first = core.beginSourceRun({ sourceId: "source-a", snapshotId: "first" });
      if (first.kind !== "started") throw new Error("expected first run");
      const firstManifest = manifestWithContent(first.run, 1, "published source body");
      core.stageSourceManifest(firstManifest);
      const published = await materialize(core, first.run, firstManifest);
      core.publishSourceRun({ runId: first.run.id, activationToken: core.beginSourceActivation(first.run.id) });

      const second = core.beginSourceRun({ sourceId: "source-a", snapshotId: "second" });
      if (second.kind !== "started") throw new Error("expected second run");
      const secondManifest = manifestWithContent(second.run, 2, "unpublished replacement body");
      core.stageSourceManifest(secondManifest);
      const orphan = await materialize(core, second.run, secondManifest, "engine-written");
      core.abortSourceRun(second.run.id, "failed", "update materializer stopped");
      const [cleanup] = core.listSourceCleanupItems(second.run.id);
      expect(cleanup).toMatchObject({
        kind: "reconcile-orphan", conceptId: published.stored.conceptId,
        observationId: orphan.stored.observationId, predecessorObservationId: published.stored.observationId,
      });
      expect(() => core.acknowledgeSourceCleanup(cleanup.id)).toThrow(/terminally superseded/);
      core.supersedeObservation(orphan.stored.observationId, null);
      expect(core.acknowledgeSourceCleanup(cleanup.id).acknowledgedAt).not.toBeNull();
      expect(core.listSourceChunks(first.run.id, true)[0]).toMatchObject({
        conceptId: published.stored.conceptId, observationId: published.stored.observationId, lifecycle: "active",
      });
    } finally {
      core.close();
    }
  });

  it("rolls back a committed refresh after fence drift before acknowledging orphan cleanup", async () => {
    const core = new MonetCore(":memory:");
    const db = (core as unknown as { db: StoragePort }).db;
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-refresh-rollback"));
      const target = await core.store("Rollback graph target.", { circle: "source-a", resolution: "forceNew" });
      const first = core.beginSourceRun({ sourceId: "source-a", snapshotId: "first" });
      if (first.kind !== "started") throw new Error("expected first run");
      const firstManifest = manifestWithContent(first.run, 1, `Published source supports: #${target.concept.slug}.`);
      core.stageSourceManifest(firstManifest);
      const published = await materialize(core, first.run, firstManifest);
      core.publishSourceRun({ runId: first.run.id, activationToken: core.beginSourceActivation(first.run.id) });
      expect(db.prepare(`SELECT 1 FROM memory_edge WHERE src_id=? AND dst_id=? AND type='supports'`).get(
        published.stored.conceptId, target.conceptId,
      )).toBeUndefined();

      const second = core.beginSourceRun({ sourceId: "source-a", snapshotId: "second" });
      if (second.kind !== "started") throw new Error("expected second run");
      const secondManifest = manifestWithContent(second.run, 2, "Unpublished successor without the assertion.");
      core.stageSourceManifest(secondManifest);
      const successor = await materialize(core, second.run, secondManifest, "committed");
      expect(db.prepare(`SELECT 1 FROM memory_edge WHERE src_id=? AND dst_id=? AND type='supports'`).get(
        published.stored.conceptId, target.conceptId,
      )).toBeUndefined();

      core.updateSource("source-a", { name: "drift after materialization" });
      expect(() => core.beginSourceActivation(second.run.id)).toThrow(/fence is stale/);
      expect(core.abortSourceRun(second.run.id, "failed", "config drift after committed refresh").state).toBe("aborted");
      const [cleanup] = core.listSourceCleanupItems(second.run.id);
      expect(cleanup).toMatchObject({
        kind: "reconcile-orphan", conceptId: published.stored.conceptId,
        observationId: successor.stored.observationId, predecessorObservationId: published.stored.observationId,
      });
      expect(() => core.acknowledgeSourceCleanup(cleanup.id)).toThrow(/terminally superseded/);
      await expect(core.rollbackSourceRunBinding("wrong-run", "binding-1")).rejects.toThrow(/no durable authorized/);

      // File=concept (Phase 1): rollback is observation-pair-only now (see
      // rollbackSourceRunBinding's own docstring) — it never touches the concept row's own
      // title/body/embedding/active_observation_id/source_refs any more (recomputeSourceConceptBody,
      // strictly post-publish, is what keeps those fresh; this run never published). Capture the
      // concept row's snapshot BEFORE rollback to prove it is byte-for-byte untouched, and verify
      // the real compensation — the observation pair's own superseded_by/at state — directly.
      const beforeRollback = db.prepare(`SELECT active_observation_id,source_identity,source_refs,body,embedding FROM concepts WHERE id=?`)
        .get(published.stored.conceptId);
      const rolledBack = await core.rollbackSourceRunBinding(second.run.id, "binding-1");
      expect(rolledBack.replayed).toBe(false);
      expect(rolledBack.concept).toMatchObject({ id: published.stored.conceptId, circle: "source-a", kind: "source" });
      const projection = db.prepare(
        `SELECT active_observation_id,source_identity,source_refs,body,embedding FROM concepts WHERE id=?`,
      ).get(published.stored.conceptId) as {
        active_observation_id: string; source_identity: string; source_refs: string; body: string; embedding: string;
      };
      expect(projection).toEqual(beforeRollback);
      const predecessor = db.prepare(`SELECT source_refs,embedding,superseded_by,superseded_at FROM observations WHERE id=?`).get(
        published.stored.observationId,
      ) as { source_refs: string; embedding: string; superseded_by: string | null; superseded_at: number | null };
      const successorRow = db.prepare(`SELECT superseded_by,superseded_at FROM observations WHERE id=?`).get(
        successor.stored.observationId,
      ) as { superseded_by: string | null; superseded_at: number | null };
      expect(predecessor).toMatchObject({ superseded_by: null, superseded_at: null });
      expect(successorRow.superseded_by).toBeNull();
      expect(successorRow.superseded_at).not.toBeNull();
      expect(db.prepare(`SELECT 1 FROM memory_edge WHERE src_id=? AND dst_id=? AND type='supports'`).get(
        published.stored.conceptId, target.conceptId,
      )).toBeUndefined();
      expect(db.prepare(`SELECT 1 FROM concept_entities WHERE concept_id=? LIMIT 1`).get(published.stored.conceptId)).toBeUndefined();

      const replay = await core.rollbackSourceRunBinding(second.run.id, "binding-1");
      expect(replay).toMatchObject({ replayed: true, concept: { id: published.stored.conceptId } });
      expect(core.acknowledgeSourceCleanup(cleanup.id).acknowledgedAt).not.toBeNull();
      const retry = core.beginSourceRun({ sourceId: "source-a", snapshotId: "second" });
      expect(retry.kind).toBe("started");
      if (retry.kind === "started") {
        const retryManifest = manifestWithContent(retry.run, 3, "later stable publication");
        core.stageSourceManifest(retryManifest);
        await materialize(core, retry.run, retryManifest, "committed");
        core.publishSourceRun({ runId: retry.run.id, activationToken: core.beginSourceActivation(retry.run.id) });
        await expect(core.rollbackSourceRunBinding(second.run.id, "binding-1")).rejects.toThrow(/durable authorized|stale/);
      }
    } finally {
      core.close();
    }
  });

  it("authorizes exact orphan compensation for a tombstoned lineage while preserving the removed fence", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-removed-rollback"));
      const first = core.beginSourceRun({ sourceId: "source-a", snapshotId: "first" });
      if (first.kind !== "started") throw new Error("expected first run");
      const firstManifest = manifestWithContent(first.run, 1, "Published predecessor.");
      core.stageSourceManifest(firstManifest);
      const published = await materialize(core, first.run, firstManifest);
      core.publishSourceRun({ runId: first.run.id, activationToken: core.beginSourceActivation(first.run.id) });

      const second = core.beginSourceRun({ sourceId: "source-a", snapshotId: "second" });
      if (second.kind !== "started") throw new Error("expected second run");
      const secondManifest = manifestWithContent(second.run, 2, "Removed successor.");
      core.stageSourceManifest(secondManifest);
      const successor = await materialize(core, second.run, secondManifest, "committed");
      const removed = core.removeSource("source-a")!;
      expect(removed.lifecycle).toBe("tombstoned");
      expect(removed.leaseFence).toBe(second.run.leaseFence + 1);
      expect(() => core.beginSourceActivation(second.run.id)).toThrow(/fence is stale/);
      expect(core.abortSourceRun(second.run.id, "failed", "removed during refresh").state).toBe("aborted");
      const [cleanup] = core.listSourceCleanupItems(second.run.id);
      expect(cleanup).toMatchObject({
        kind: "reconcile-orphan", conceptId: published.stored.conceptId,
        observationId: successor.stored.observationId, predecessorObservationId: published.stored.observationId,
      });
      expect(() => core.acknowledgeSourceCleanup(cleanup.id)).toThrow(/terminally superseded/);
      await expect(core.rollbackSourceRunBinding(first.run.id, "binding-1")).rejects.toThrow(/no durable authorized/);
      // File=concept (Phase 1): rollback is observation-pair-only now — see
      // rollbackSourceRunBinding's own docstring — so the returned concept row's body is whatever
      // it already was (this run never published, so recomputeSourceConceptBody never ran); the
      // real compensation is the observation pair superseded_by/at state, covered elsewhere.
      expect(await core.rollbackSourceRunBinding(second.run.id, "binding-1")).toMatchObject({
        replayed: false, concept: { id: published.stored.conceptId },
      });
      expect(core.acknowledgeSourceCleanup(cleanup.id).acknowledgedAt).not.toBeNull();
      expect(core.getSource("source-a", { includeTombstoned: true })).toMatchObject({
        lifecycle: "tombstoned", leaseFence: removed.leaseFence, activeRunId: first.run.id,
      });
    } finally {
      core.close();
    }
  });

  it("rejects malformed durable source operations, then quarantines them on abort", async () => {
    for (const mismatch of ["content", "circle", "extra-ref", "duplicate-ref"] as const) {
      const core = new MonetCore(":memory:");
      try {
        core.createSource(sourceInput("source-a", `/tmp/source-ledger-receipt-${mismatch}`));
        const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: mismatch });
        if (begun.kind !== "started") throw new Error("expected run");
        const staged = manifest(begun.run);
        core.stageSourceManifest(staged);
        const sourceRefs = mismatch === "extra-ref"
          ? [staged.chunks[0].sourceRef, "source://source-a/OTHER.md#other~1"]
          : mismatch === "duplicate-ref"
            ? [staged.chunks[0].sourceRef, staged.chunks[0].sourceRef]
            : [staged.chunks[0].sourceRef];
        const stored = await core.storeSource(
          mismatch === "content" ? "wrong bytes" : staged.chunks[0].content,
          {
            circle: mismatch === "circle" ? "wrong-circle" : "source-a",
            sourceRefs,
            operationId: staged.chunks[0].operationId,
            resolution: "forceNew",
          },
        );
        expect(() => core.recordSourceBindingReceipt({
          runId: begun.run.id, bindingId: "binding-1", conceptId: stored.conceptId,
          observationId: stored.observationId, predecessorObservationId: null, writeState: "engine-written",
        })).toThrow(mismatch === "content" ? /content/ : mismatch === "circle" ? /circle/ : /provenance/);
        expect(core.listSourceChunks(begun.run.id)[0]).toMatchObject({
          writeState: "intent", conceptId: null, observationId: null, predecessorObservationId: null,
        });
        expect(core.abortSourceRun(begun.run.id, "failed", `quarantine ${mismatch}`).state).toBe("aborted");
        expect(core.abortSourceRun(begun.run.id, "failed", `quarantine ${mismatch}`).state).toBe("aborted");
        const [cleanup] = core.listSourceCleanupItems(begun.run.id);
        expect(cleanup).toMatchObject({
          kind: "reconcile-orphan", operationId: staged.chunks[0].operationId,
          conceptId: stored.conceptId, observationId: stored.observationId,
        });
        expect(() => core.beginSourceRun({ sourceId: "source-a", snapshotId: `retry-${mismatch}` })).toThrow(/pending orphan reconciliation/);
        core.supersedeObservation(stored.observationId, null);
        core.retireConcept(stored.conceptId);
        core.acknowledgeSourceCleanup(cleanup.id);
        const retry = core.beginSourceRun({ sourceId: "source-a", snapshotId: `retry-${mismatch}` });
        expect(retry.kind).toBe("started");
        if (retry.kind === "started") core.abortSourceRun(retry.run.id, "failed");
      } finally {
        core.close();
      }
    }
  });

  it("never treats a native-domain operation as a source orphan", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-native-op"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "native-op" });
      if (begun.kind !== "started") throw new Error("expected run");
      const staged = manifest(begun.run);
      core.stageSourceManifest(staged);
      const native = await core.store(staged.chunks[0].content, {
        circle: "source-a", operationId: staged.chunks[0].operationId, resolution: "forceNew",
      });
      expect(() => core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-1", conceptId: native.conceptId,
        observationId: native.observationId, predecessorObservationId: null, writeState: "engine-written",
      })).toThrow(/source-domain/);
      expect(() => core.abortSourceRun(begun.run.id, "failed", "native collision")).toThrow(/source-domain/);
      expect(core.getSourceRun(begun.run.id)?.state).toBe("staging");
      expect(core.listSourceCleanupItems(begun.run.id)).toEqual([]);
    } finally {
      core.close();
    }
  });

  it("quarantines a foreign-source operation without authorizing mutation of its active evidence", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("foreign", "/tmp/source-ledger-foreign-owner"));
      const foreignRun = core.beginSourceRun({ sourceId: "foreign", snapshotId: "foreign-snapshot" });
      if (foreignRun.kind !== "started") throw new Error("expected foreign run");
      const foreignManifest = manifest(foreignRun.run);
      core.stageSourceManifest(foreignManifest);
      const foreignReceipt = await materialize(core, foreignRun.run, foreignManifest);
      core.publishSourceRun({ runId: foreignRun.run.id, activationToken: core.beginSourceActivation(foreignRun.run.id) });

      core.createSource(sourceInput("source-a", "/tmp/source-ledger-foreign-attempt"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "attempt" });
      if (begun.kind !== "started") throw new Error("expected run");
      const staged = manifest(begun.run);
      core.stageSourceManifest(staged);
      const foreignWrite = await core.storeSource(staged.chunks[0].content, {
        circle: "foreign", sourceRefs: [foreignManifest.chunks[0].sourceRef],
        operationId: staged.chunks[0].operationId, attachTo: foreignReceipt.stored.conceptId,
      });
      expect(() => core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-1", conceptId: foreignWrite.conceptId,
        observationId: foreignWrite.observationId, predecessorObservationId: null, writeState: "engine-written",
      })).toThrow(/ownership/);
      expect(core.abortSourceRun(begun.run.id, "failed", "foreign ownership").state).toBe("aborted");
      const [quarantine] = core.listSourceCleanupItems(begun.run.id);
      expect(quarantine).toMatchObject({
        kind: "quarantine-non-authorizing", operationId: staged.chunks[0].operationId,
        conceptId: foreignWrite.conceptId, observationId: foreignWrite.observationId,
      });
      expect(core.listSourceChunks(foreignRun.run.id, true)[0].lifecycle).toBe("active");
      expect(() => core.beginSourceRun({ sourceId: "source-a", snapshotId: "retry" })).toThrow(/pending orphan reconciliation/);
      core.acknowledgeSourceCleanup(quarantine.id);
      expect(core.listSourceChunks(foreignRun.run.id, true)[0].lifecycle).toBe("active");
      expect(await core.getConcept(foreignReceipt.stored.conceptId)).toBeNull();
      expect(core.nextSourceBindingGeneration("source-a", "binding-1")).toBe(2);
      const retry = core.beginSourceRun({ sourceId: "source-a", snapshotId: "retry" });
      expect(retry.kind).toBe("started");
      if (retry.kind === "started") core.abortSourceRun(retry.run.id, "failed");
    } finally {
      core.close();
    }
  });

  // File=concept (Phase 1): a second binding attaching to an existing concept is no longer itself
  // a violation — every chunk of ONE file legitimately shares its file concept now. The genuine
  // violation this test protects against is a DIFFERENT file's chunk claiming another file's
  // concept (relativePath "OTHER.md" vs. the target's "README.md"), which proves no binding_id OR
  // relative_path lineage to it (classifyOperationOwnership's provenLineage check).
  it("quarantines a cross-FILE takeover while a normal same-binding successor still publishes", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-cross-binding"));
      const first = core.beginSourceRun({ sourceId: "source-a", snapshotId: "first" });
      if (first.kind !== "started") throw new Error("expected first run");
      const firstManifest = manifest(first.run);
      core.stageSourceManifest(firstManifest);
      const firstReceipt = await materialize(core, first.run, firstManifest);
      core.publishSourceRun({ runId: first.run.id, activationToken: core.beginSourceActivation(first.run.id) });

      const takeover = core.beginSourceRun({ sourceId: "source-a", snapshotId: "takeover" });
      if (takeover.kind !== "started") throw new Error("expected takeover run");
      const base = manifest(takeover.run).chunks[0];
      const headingPath = ["Other"];
      const ingestFingerprint = computeSourceIngestFingerprint({
        contentHash: base.contentHash, headingPath, metadata: base.metadata, ingestConfigHash: takeover.run.ingestConfigHash,
      });
      const hijack = {
        ...base, bindingId: "binding-2", relativePath: "OTHER.md", headingPath, sourceRef: "source://source-a/OTHER.md#other~1", ingestFingerprint,
        operationId: computeSourceOperationId("source-a", "binding-2", ingestFingerprint, "takeover", 1),
      };
      const takeoverManifest = manifest(takeover.run, {
        chunks: [hijack],
        files: [{ relativePath: "OTHER.md", type: "file", contentHash: hijack.contentHash, byteLength: hijack.content.length, title: "OTHER" }],
      });
      core.stageSourceManifest(takeoverManifest);
      const hijackWrite = await core.storeSource(hijack.content, {
        circle: "source-a", sourceRefs: [hijack.sourceRef], operationId: hijack.operationId,
        attachTo: firstReceipt.stored.conceptId,
      });
      expect(() => core.recordSourceBindingReceipt({
        runId: takeover.run.id, bindingId: "binding-2", conceptId: hijackWrite.conceptId,
        observationId: hijackWrite.observationId, predecessorObservationId: null, writeState: "engine-written",
      })).toThrow(/ownership/);
      core.abortSourceRun(takeover.run.id, "failed", "cross-binding takeover");
      const [quarantine] = core.listSourceCleanupItems(takeover.run.id);
      expect(quarantine.kind).toBe("quarantine-non-authorizing");
      expect(core.listSourceChunks(first.run.id, true)[0]).toMatchObject({ bindingId: "binding-1", lifecycle: "active" });
      core.acknowledgeSourceCleanup(quarantine.id);
      expect(core.listSourceChunks(first.run.id, true)[0].lifecycle).toBe("active");

      const successor = core.beginSourceRun({ sourceId: "source-a", snapshotId: "successor" });
      if (successor.kind !== "started") throw new Error("expected successor run");
      const successorManifest = manifestWithContent(successor.run, 2, "normal successor");
      core.stageSourceManifest(successorManifest);
      await materialize(core, successor.run, successorManifest);
      expect(core.publishSourceRun({
        runId: successor.run.id, activationToken: core.beginSourceActivation(successor.run.id),
      }).state).toBe("cleaned");
      expect(core.listSourceChunks(successor.run.id, true)[0]).toMatchObject({ bindingId: "binding-1", lifecycle: "active" });
    } finally {
      core.close();
    }
  });

  it("requires typed proof to carry a binding across a changed natural identity", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-rename"));
      const first = core.beginSourceRun({ sourceId: "source-a", snapshotId: "a" });
      if (first.kind !== "started") throw new Error("expected first run");
      const firstManifest = manifest(first.run);
      core.stageSourceManifest(firstManifest);
      await materialize(core, first.run, firstManifest);
      core.publishSourceRun({ runId: first.run.id, activationToken: core.beginSourceActivation(first.run.id) });

      const moved = core.beginSourceRun({ sourceId: "source-a", snapshotId: "b" });
      if (moved.kind !== "started") throw new Error("expected moved run");
      const file = { relativePath: "MOVED.md", type: "file" as const, contentHash: "moved-file", byteLength: 10, title: "MOVED" };
      const baseChunk = manifest(moved.run, { bindingGeneration: 2 }).chunks[0];
      const fingerprint = baseChunk.ingestFingerprint;
      const chunk = {
        ...baseChunk, relativePath: "MOVED.md", ingestFingerprint: fingerprint,
        sourceRef: "source://source-a/MOVED.md#intro~1",
        bindingGeneration: 2,
        operationId: computeSourceOperationId("source-a", "binding-1", fingerprint, "b", 2),
      };
      expect(() => core.stageSourceManifest(manifest(moved.run, { files: [file], chunks: [chunk] }))).toThrow(/bindingIdHint/);
      expect(() => core.stageSourceManifest(manifest(moved.run, { files: [file], chunks: [{ ...chunk, bindingIdHint: { bindingId: "binding-1", priorRunId: "wrong" } }] }))).toThrow(/bindingIdHint/);
      const proved = manifest(moved.run, { files: [file], chunks: [{ ...chunk, bindingIdHint: { bindingId: "binding-1", priorRunId: first.run.id } }] });
      expect(core.stageSourceManifest(proved).state).toBe("staging");
      expect(core.stageSourceManifest(proved).state).toBe("staging");
      expect(() => core.recordSourceBindingReceipt({
        runId: moved.run.id, bindingId: "binding-1", writeState: "skipped",
      })).toThrow(/unchanged prior active binding/);
    } finally {
      core.close();
    }
  });

  it("rejects forged operation IDs, cross-snapshot IDs, and chunks without a manifest file", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-validation"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "a" });
      if (begun.kind !== "started") throw new Error("expected run");
      expect(() => core.stageSourceManifest(manifest(begun.run, {
        chunks: [{ ...manifest(begun.run).chunks[0], operationId: "forged" }],
      }))).toThrow(/operationId/);
      expect(() => core.stageSourceManifest(manifest(begun.run, {
        chunks: [{ ...manifest(begun.run).chunks[0], operationId: computeSourceOperationId("source-a", "binding-1", "ingest-1", "other-snapshot", 1) }],
      }))).toThrow(/operationId/);
      expect(() => core.stageSourceManifest(manifest(begun.run, {
        chunks: [{ ...manifest(begun.run).chunks[0], relativePath: "ORPHAN.md" }],
      }))).toThrow(/staged file/);
    } finally {
      core.close();
    }
  });

  it("binds durable source refs to the run authority, encoded path, and heading slug", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-refs"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "refs" });
      if (begun.kind !== "started") throw new Error("expected run");
      const base = manifest(begun.run);
      for (const sourceRef of [
        "source://source-b/README.md#intro~1",
        "source://source-a/OTHER.md#intro~1",
        "source://source-a/README.md#other~1",
        "source://source-a/README.md#intro~0",
        "source://source-a/README.md#intro~2",
        "README.md#intro~1",
      ]) {
        expect(() => core.stageSourceManifest({
          ...base, chunks: [{ ...base.chunks[0], sourceRef }],
        })).toThrow(/sourceRef/);
      }
      expect(core.stageSourceManifest(base).state).toBe("staging");
    } finally {
      core.close();
    }
  });

  it("binds sourceRef occurrences to canonical heading identities independent of manifest order", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-ref-occurrences"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "refs" });
      if (begun.kind !== "started") throw new Error("expected run");
      const base = manifest(begun.run);
      const make = (bindingId: string, heading: string, sourceRef: string) => {
        const headingPath = [heading];
        const ingestFingerprint = computeSourceIngestFingerprint({
          contentHash: base.chunks[0].contentHash,
          headingPath,
          metadata: base.chunks[0].metadata,
          ingestConfigHash: begun.run.ingestConfigHash,
        });
        return {
          ...base.chunks[0], bindingId, bindingGeneration: 1, headingPath, sourceRef, ingestFingerprint,
          operationId: computeSourceOperationId("source-a", bindingId, ingestFingerprint, "refs", 1),
        };
      };
      const first = make("binding-a", "A!", "source://source-a/README.md#a~1");
      const second = make("binding-b", "a?", "source://source-a/README.md#a~2");
      expect(() => core.stageSourceManifest(manifest(begun.run, { chunks: [second, { ...first, sourceRef: second.sourceRef },] }))).toThrow();
      expect(() => core.stageSourceManifest(manifest(begun.run, {
        chunks: [{ ...second, sourceRef: first.sourceRef }, { ...first, sourceRef: second.sourceRef }],
      }))).toThrow(/canonical heading identity/);
      expect(core.stageSourceManifest(manifest(begun.run, { chunks: [second, first] })).state).toBe("staging");
    } finally {
      core.close();
    }
  });

  it("re-enforces persisted scanner budgets at the durable staging boundary", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-budgets"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "budget" });
      if (begun.kind !== "started") throw new Error("expected run");
      const db = (core as unknown as { db: StoragePort }).db;
      const effective = { ...begun.run.effectiveConfig, limits: {
        ...begun.run.effectiveConfig.limits, maxFiles: 1, maxFileBytes: 12, maxTotalBytes: 12, maxChunkBytes: 11, maxChunks: 1,
      } };
      db.prepare("UPDATE source_sync_runs SET effective_config_json=? WHERE id=?").run(JSON.stringify(effective), begun.run.id);
      const run = core.getSourceRun(begun.run.id)!;
      const base = manifest(run);
      expect(() => core.stageSourceManifest({ ...base, files: [...base.files, { ...base.files[0], relativePath: "two.md" }] })).toThrow(/maxFiles/);
      expect(() => core.stageSourceManifest({ ...base, files: [{ ...base.files[0], byteLength: 13 }] })).toThrow(/maxFileBytes/);
      expect(() => core.stageSourceManifest({ ...base, chunks: [{ ...base.chunks[0], content: "Hello world!" }] })).toThrow(/maxChunkBytes|contentHash/);
      expect(() => core.stageSourceManifest({ ...base, chunks: [...base.chunks, { ...base.chunks[0], bindingId: "two" }] })).toThrow(/maxChunks/);
    } finally {
      core.close();
    }
  });

  // File=concept (Phase 1): a sibling binding attaching to an existing concept is no longer
  // itself a violation when it's the SAME file (every chunk of one file legitimately shares its
  // concept now) — so "second" here is a chunk of a DIFFERENT file ("OTHER.md") to keep this a
  // genuine cross-FILE concept-reuse violation, which classifyOperationOwnership's provenLineage
  // check still rejects (no binding_id or relative_path lineage to the target concept).
  it("requires engine-proven receipts and rejects concept reuse across a different file's binding", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-receipts"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "receipts" });
      if (begun.kind !== "started") throw new Error("expected run");
      const base = manifest(begun.run);
      const secondFingerprint = computeSourceIngestFingerprint({
        contentHash: base.chunks[0].contentHash, headingPath: ["Other"], metadata: base.chunks[0].metadata,
        ingestConfigHash: begun.run.ingestConfigHash,
      });
      const second = {
        ...base.chunks[0], bindingId: "binding-2", bindingGeneration: 1, relativePath: "OTHER.md", headingPath: ["Other"],
        sourceRef: "source://source-a/OTHER.md#other~1",
        ingestFingerprint: secondFingerprint,
        operationId: computeSourceOperationId("source-a", "binding-2", secondFingerprint, "receipts", 1),
      };
      const staged = manifest(begun.run, {
        chunks: [base.chunks[0], second],
        files: [
          ...base.files,
          { relativePath: "OTHER.md", type: "file", contentHash: second.contentHash, byteLength: second.content.length, title: "OTHER" },
        ],
      });
      core.stageSourceManifest(staged);
      expect(() => core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-1", conceptId: "forged", observationId: "forged", writeState: "engine-written",
      })).toThrow(/durable engine operation/);

      const first = await core.storeSource(base.chunks[0].content, {
        circle: "source-a", sourceRefs: [base.chunks[0].sourceRef], operationId: base.chunks[0].operationId, resolution: "forceNew",
      });
      core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-1", conceptId: first.conceptId, observationId: first.observationId,
        predecessorObservationId: null, writeState: "committed",
      });
      const sibling = await core.storeSource(second.content, {
        circle: "source-a", sourceRefs: [second.sourceRef], operationId: second.operationId, attachTo: first.conceptId,
      });
      // File=concept (Phase 1): caught earlier and more fundamentally now, by
      // classifyOperationOwnership's provenLineage check (source-ledger.ts) — "OTHER.md"'s binding
      // has no binding_id or relative_path lineage to "README.md"'s concept — rather than falling
      // through to recordBindingReceipt's own same-run collision check.
      expect(() => core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-2", conceptId: sibling.conceptId, observationId: sibling.observationId,
        predecessorObservationId: null, writeState: "engine-written",
      })).toThrow(/ownership|collides|new binding/);
    } finally {
      core.close();
    }
  });

  it("verifies chunk content and its full scanner fingerprint before staging", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-integrity"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "integrity" });
      if (begun.kind !== "started") throw new Error("expected run");
      const base = manifest(begun.run);
      expect(() => core.stageSourceManifest({
        ...base, chunks: [{ ...base.chunks[0], contentHash: computeSourceContentHash(Buffer.from("different")) }],
      })).toThrow(/contentHash/);

      const changedContent = "different";
      const changedHash = computeSourceContentHash(Buffer.from(changedContent));
      expect(() => core.stageSourceManifest({
        ...base,
        chunks: [{
          ...base.chunks[0], content: changedContent, contentHash: changedHash,
          operationId: computeSourceOperationId("source-a", "binding-1", base.chunks[0].ingestFingerprint, "integrity", 1),
        }],
      })).toThrow(/ingestFingerprint/);
    } finally {
      core.close();
    }
  });

  it("rejects non-canonical durable paths before staging any manifest rows", () => {
    const invalidPaths = ["", "../escape.md", "/abs", "C:\\x", "\\\\server\\share", "a\\b", "a/./b", "a/../b", "a//b", "a/", "a\u0000b", "a\u001fb"];
    for (const [index, relativePath] of invalidPaths.entries()) {
      for (const boundary of ["file", "chunk"] as const) {
        const core = new MonetCore(":memory:");
        try {
          core.createSource(sourceInput("source-a", `/tmp/source-ledger-path-${boundary}-${index}`));
          const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: `snap-${boundary}-${index}` });
          if (begun.kind !== "started") throw new Error("expected run");
          const db = (core as unknown as { db: StoragePort }).db;
          const before = db.prepare("SELECT total_changes() AS count").get() as { count: number };
          const base = manifest(begun.run);
          expect(() => core.stageSourceManifest({
            ...base,
            files: boundary === "file" ? [{ ...base.files[0], relativePath }] : base.files,
            chunks: boundary === "chunk" ? [{ ...base.chunks[0], relativePath }] : base.chunks,
          })).toThrow(/canonical POSIX source-relative path/);
          const after = db.prepare("SELECT total_changes() AS count").get() as { count: number };
          expect(after.count).toBe(before.count);
          expect(db.prepare("SELECT COUNT(*) AS count FROM source_staged_files WHERE run_id=?").get(begun.run.id)).toEqual({ count: 0 });
          expect(db.prepare("SELECT COUNT(*) AS count FROM source_staged_chunks WHERE run_id=?").get(begun.run.id)).toEqual({ count: 0 });
          expect(core.getSourceRun(begun.run.id)?.state).toBe("scanning");
        } finally {
          core.close();
        }
      }
    }
  });

  it("preserves valid dot-directory and Unicode source paths byte-for-byte", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-valid-paths"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "valid-paths" });
      if (begun.kind !== "started") throw new Error("expected run");
      const base = manifest(begun.run);
      const paths = [".cursor/rules/x.md", "知识/说明-é.md"];
      const files = paths.map((relativePath, index) => ({ ...base.files[0], relativePath, contentHash: `file-${index}` }));
      const chunks = paths.map((relativePath, index) => {
        const bindingId = `binding-${index}`;
        const ingestFingerprint = base.chunks[0].ingestFingerprint;
        return {
          ...base.chunks[0], bindingId, bindingGeneration: 1, relativePath, ingestFingerprint,
          operationId: computeSourceOperationId("source-a", bindingId, ingestFingerprint, "valid-paths", 1),
          sourceRef: `source://source-a/${relativePath.split("/").map(encodeURIComponent).join("/")}#intro~1`,
        };
      });
      expect(core.stageSourceManifest(manifest(begun.run, { files, chunks })).state).toBe("staging");
      expect(core.listSourceFiles(begun.run.id).map((file) => file.relativePath)).toEqual(paths);
      expect(core.listSourceChunks(begun.run.id).map((chunk) => chunk.relativePath)).toEqual(paths);
    } finally {
      core.close();
    }
  });

  it("does not suppress an orphan-cleanup primary-key collision", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-cleanup-collision"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "collision" });
      if (begun.kind !== "started") throw new Error("expected run");
      const staged = manifest(begun.run);
      core.stageSourceManifest(staged);
      await materialize(core, begun.run, staged, "engine-written");
      const ids = ["cleanup-collision", "cleanup-ok"];
      const ledger = (core as unknown as { sourceLedger: { idGen: () => string } }).sourceLedger;
      ledger.idGen = () => ids.shift() ?? "unexpected-id";
      const db = (core as unknown as { db: StoragePort }).db;
      db.prepare(`INSERT INTO source_cleanup_items
        (id,source_id,run_id,target_run_id,kind,binding_id,created_at)
        VALUES ('cleanup-collision','other-source','other-run','other-run','reconcile-orphan','other-binding',0)`).run();

      expect(() => core.abortSourceRun(begun.run.id, "failed", "collision")).toThrow(/UNIQUE/);
      expect(core.getSourceRun(begun.run.id)?.state).toBe("staging");
      expect(core.listSourceCleanupItems(begun.run.id)).toEqual([]);
      expect(core.abortSourceRun(begun.run.id, "failed", "collision").state).toBe("aborted");
      expect(core.listSourceCleanupItems(begun.run.id)).toEqual([
        expect.objectContaining({ id: "cleanup-ok", bindingId: "binding-1" }),
      ]);
    } finally {
      core.close();
    }
  });

  it("does not return a stale no-op after source config changes", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-config"));
      const first = core.beginSourceRun({ sourceId: "source-a", snapshotId: "a" });
      if (first.kind !== "started") throw new Error("expected run");
      core.stageSourceManifest(manifest(first.run, { files: [], chunks: [] }));
      core.publishSourceRun({ runId: first.run.id, activationToken: core.beginSourceActivation(first.run.id) });
      expect(core.beginSourceRun({ sourceId: "source-a", snapshotId: "a" }).kind).toBe("noop");
      core.updateSource("source-a", { include: ["AGENTS.md"] });
      const replacement = core.beginSourceRun({ sourceId: "source-a", snapshotId: "a" });
      expect(replacement.kind).toBe("started");
      if (replacement.kind === "started") {
        expect(replacement.run.configVersion).toBe(2);
        expect(replacement.run.ingestConfigHash).not.toBe(first.run.ingestConfigHash);
      }
    } finally {
      core.close();
    }
  });

  it("stages, persists, and republishes skip-and-diagnose evidence with an idempotent replay and independently-recomputed counts", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-skip"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-1" });
      if (begun.kind !== "started") throw new Error("expected started run");
      const skipped: SourceManifestSkippedFileInput[] = [
        { relativePath: "bad.txt", code: "not-markdown", message: "included path is not a recognized Markdown source" },
        { relativePath: "huge.md", code: "file-too-large", message: "file exceeds the inclusive 1024-byte limit" },
      ];
      const staged = manifest(begun.run, { skipped });
      const run = core.stageSourceManifest(staged);
      expect(run.filesSkipped).toBe(2);

      // Idempotent replay: re-staging the exact same manifest (including skipped) while still in
      // staging state returns the existing run rather than re-inserting or throwing.
      expect(core.stageSourceManifest(staged)).toEqual(run);
      // A manifest that replays everything but the skipped list is a genuine conflict, proving
      // skipped entries are part of the staged-manifest identity, not incidental metadata.
      expect(() => core.stageSourceManifest({ ...staged, skipped: [skipped[0]] })).toThrow(/conflicts with existing run contents/);

      const rows = core.listSourceSkippedFiles(begun.run.id);
      expect(rows.map(({ relativePath, code, message }) => ({ relativePath, code, message }))).toEqual(skipped);
      expect(rows.every((row) => row.sourceId === "source-a" && row.runId === begun.run.id && row.byteLength === 0 && row.createdAt > 0)).toBe(true);

      const written = await materialize(core, begun.run, staged, "engine-written");
      core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-1", conceptId: written.stored.conceptId,
        observationId: written.stored.observationId, predecessorObservationId: null, writeState: "committed",
      });
      const token = core.beginSourceActivation(begun.run.id);
      core.publishSourceRun({ runId: begun.run.id, activationToken: token, expectedManifestHash: staged.manifestHash });

      expect(core.getSourceRun(begun.run.id)!.filesSkipped).toBe(2);
      // activePublication is ledger-internal (no MonetCore wrapper); independently recomputed
      // via COUNT queries against the published tables, unlike the cached run.filesSkipped above.
      const ledger = (core as unknown as { sourceLedger: SourceLedger }).sourceLedger;
      const publication = ledger.activePublication("source-a", begun.run.id, "snap-1", begun.run.ingestConfigHash);
      expect(publication).toMatchObject({ filesIndexed: 1, chunksIndexed: 1, filesSkipped: 2 });
    } finally {
      core.close();
    }
  });

  it("persists multiple diagnostics for the same path rather than collapsing to the last one seen (minor a)", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-multi-skip", "/tmp/source-multi-skip"));
      const begun = core.beginSourceRun({ sourceId: "source-multi-skip", snapshotId: "snap-1" });
      if (begun.kind !== "started") throw new Error("expected started run");
      const skipped: SourceManifestSkippedFileInput[] = [
        { relativePath: "flaky.md", code: "invalid-frontmatter", message: "first diagnostic for this path" },
        { relativePath: "flaky.md", code: "chunk-budget-exceeded", message: "second diagnostic for the same path" },
      ];
      const staged = manifest(begun.run, { skipped });
      const run = core.stageSourceManifest(staged);
      expect(run.filesSkipped).toBe(2);
      const rows = core.listSourceSkippedFiles(begun.run.id);
      expect(rows.map(({ relativePath, code, message }) => ({ relativePath, code, message }))).toEqual(skipped);
    } finally {
      core.close();
    }
  });

  it("persists a supplied byteLength for a skipped file's audit record (minor b)", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-skip-bytes", "/tmp/source-skip-bytes"));
      const begun = core.beginSourceRun({ sourceId: "source-skip-bytes", snapshotId: "snap-1" });
      if (begun.kind !== "started") throw new Error("expected started run");
      const skipped: SourceManifestSkippedFileInput[] = [
        { relativePath: "big.md", code: "file-too-large", message: "file exceeds the inclusive limit", byteLength: 4096 },
        { relativePath: "unknown.md", code: "not-markdown", message: "included path is not a recognized Markdown source" },
      ];
      core.stageSourceManifest(manifest(begun.run, { skipped }));
      const rows = core.listSourceSkippedFiles(begun.run.id);
      expect(rows.find((row) => row.relativePath === "big.md")).toMatchObject({ byteLength: 4096 });
      // No byteLength supplied (a path never previously published has no known size): persists as
      // the column default rather than throwing or omitting the row.
      expect(rows.find((row) => row.relativePath === "unknown.md")).toMatchObject({ byteLength: 0 });
    } finally {
      core.close();
    }
  });
});

describe("source ledger schema migration", () => {
  it("adds source_sync_runs.files_skipped and the source_skipped_files table idempotently, defaulting existing rows to 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-skipped-migration-"));
    const path = join(dir, "monet.db");
    try {
      const first = new MonetCore(path);
      first.createSource(sourceInput("source-a", "/tmp/source-a"));
      const begun = first.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-1" });
      if (begun.kind !== "started") throw new Error("expected started run");
      first.stageSourceManifest(manifest(begun.run));
      const db = (first as unknown as { db: StoragePort }).db;
      // Simulate a pre-migration database: drop the column and table an older release predates.
      db.exec(`ALTER TABLE source_sync_runs DROP COLUMN files_skipped`);
      db.exec(`DROP TABLE source_skipped_files`);
      first.close();

      const reopened = new MonetCore(path);
      const run = reopened.getSourceRun(begun.run.id)!;
      expect(run.filesSkipped).toBe(0);
      const reopenedDb = (reopened as unknown as { db: StoragePort }).db;
      const runColumns = reopenedDb.prepare(`PRAGMA table_info(source_sync_runs)`).all() as Array<{ name: string }>;
      expect(runColumns.filter((column) => column.name === "files_skipped")).toHaveLength(1);
      expect(reopenedDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_skipped_files'`).get()).toBeTruthy();
      // NIT: idx_source_skipped_files_source_created was dropped as unused — no query filters by
      // (source_id, created_at) on this table; listSkippedFiles filters by run_id and orders by
      // sequence, and the run-scoped COUNT query filters by (source_id, run_id). A fresh table
      // must not recreate it.
      expect(reopenedDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_source_skipped_files_source_created'`).get()).toBeUndefined();
      expect(reopened.listSourceSkippedFiles(begun.run.id)).toEqual([]);
      reopened.close();

      // Idempotent: schema is already current, so a second reopen must not throw or duplicate anything.
      const twice = new MonetCore(path);
      expect(twice.getSourceRun(begun.run.id)!.filesSkipped).toBe(0);
      const columnsAgain = (twice as unknown as { db: StoragePort }).db.prepare(`PRAGMA table_info(source_sync_runs)`).all() as Array<{ name: string }>;
      expect(columnsAgain.filter((column) => column.name === "files_skipped")).toHaveLength(1);
      twice.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it("backfills verification by observed run count despite backward and equal clocks", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-attempt-causal-migrate-"));
    const path = join(dir, "monet.db");
    try {
      const first = new MonetCore(path);
      first.createSource(sourceInput("source-a", join(dir, "repo")));
      const publishEmpty = (snapshotId: string): SourceSyncRun => {
        const begun = first.beginSourceRun({ sourceId: "source-a", snapshotId });
        if (begun.kind !== "started") throw new Error("expected run");
        first.stageSourceManifest(manifest(begun.run, { files: [], chunks: [] }));
        return first.publishSourceRun({ runId: begun.run.id, activationToken: first.beginSourceActivation(begun.run.id) });
      };
      const run1 = publishEmpty("snap-1");
      first.updateSource("source-a", { include: ["README.md"] });
      const run2 = publishEmpty("snap-2");
      const active = first.getSource("source-a")!;
      first.recordSourceVerification({
        sourceId: active.id, runId: run2.id, snapshotId: run2.snapshotId, ingestConfigHash: run2.ingestConfigHash,
        configVersion: active.configVersion, leaseFence: active.leaseFence,
      });
      first.updateSource("source-a", { include: ["AGENTS.md"] });
      const begun3 = first.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-3" });
      if (begun3.kind !== "started") throw new Error("expected third run");
      const run3 = first.abortSourceRun(begun3.run.id, "failed", "newest durable run failed");
      const current = first.getSource("source-a")!;
      first.recordSourcePrePinFailure({
        sourceId: current.id, reason: "legacy pre-pin", configVersion: current.configVersion, leaseFence: current.leaseFence,
      });

      const db = (first as unknown as { db: StoragePort }).db;
      db.prepare(`UPDATE source_sync_runs SET created_at=CASE id WHEN ? THEN 300 WHEN ? THEN 300 ELSE 100 END
        WHERE source_id='source-a'`).run(run1.id, run2.id);
      db.prepare(`UPDATE source_verification_checks SET checked_at=50 WHERE source_id='source-a'`).run();
      db.prepare(`UPDATE source_pre_pin_attempts SET attempted_at=75 WHERE source_id='source-a'`).run();
      db.prepare(`DELETE FROM source_attempt_events WHERE source_id='source-a'`).run();
      first.close();

      for (let reopen = 0; reopen < 2; reopen += 1) {
        const core = new MonetCore(path);
        const reopened = (core as unknown as { db: StoragePort }).db;
        expect(reopened.prepare(`SELECT kind,run_id,attempted_at FROM source_attempt_events
          WHERE source_id='source-a' ORDER BY sequence`).all()).toEqual([
          { kind: "pre-pin-failure", run_id: null, attempted_at: 75 },
          { kind: "run", run_id: run1.id, attempted_at: 300 },
          { kind: "run", run_id: run2.id, attempted_at: 300 },
          { kind: "verification", run_id: run2.id, attempted_at: 50 },
          { kind: "run", run_id: run3.id, attempted_at: 100 },
        ]);
        expect(core.sourceStatus("source-a", { callerId: "caller", projectId: "project" })).toMatchObject({
          indexedRevision: "snap-2", lastSyncResult: "failed", lastError: "newest durable run failed",
        });
        core.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hydrates only the newest same-millisecond legacy pre-pin failure event", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-attempt-payload-migrate-"));
    const path = join(dir, "monet.db");
    try {
      const first = new MonetCore(path);
      first.createSource(sourceInput("source-a", join(dir, "repo")));
      const db = (first as unknown as { db: StoragePort }).db;
      db.exec(`
        INSERT INTO source_attempt_events(source_id,sequence,kind,ref_id,attempted_at,failure_reason)
          VALUES ('source-a',1,'pre-pin-failure','legacy-1',1234,NULL),
                 ('source-a',2,'pre-pin-failure','legacy-2',1234,NULL);
        INSERT INTO source_pre_pin_attempts(source_id,attempted_at,reason,config_version,lease_fence)
          VALUES ('source-a',1234,'newest durable reason',1,1);
        ALTER TABLE source_attempt_events DROP COLUMN failure_reason;
      `);
      first.close();

      for (let reopen = 0; reopen < 2; reopen += 1) {
        const core = new MonetCore(path);
        const reopened = (core as unknown as { db: StoragePort }).db;
        expect(reopened.prepare(`
          SELECT sequence,failure_reason FROM source_attempt_events
          WHERE source_id='source-a' ORDER BY sequence
        `).all()).toEqual([
          { sequence: 1, failure_reason: null },
          { sequence: 2, failure_reason: "newest durable reason" },
        ]);
        core.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates every v10 receipt/cleanup index on fresh and current-schema reopen", () => {
    // File=concept (Phase 1): uq_source_staged_chunks_concept and uq_source_chunks_active_concept
    // were dropped/replaced (source-ledger.ts's ensureSchema) — many chunks now legitimately
    // share one concept_id, so "at most one [staged|active] chunk per concept" is no longer a
    // valid index. uq_source_chunks_active_concept_slot is the replacement: per-(concept,
    // natural-key-slot) uniqueness.
    const expected = [
      "idx_source_cleanup_run",
      "uq_source_staged_chunks_observation",
      "uq_source_chunks_active_concept_slot",
      "uq_source_chunks_active_observation",
    ];
    const indexNames = (db: StoragePort) => (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name IN (${expected.map(() => "?").join(",")}) ORDER BY name`,
    ).all(...expected) as Array<{ name: string }>).map((row) => row.name);

    const fresh = new MonetCore(":memory:");
    expect(indexNames((fresh as unknown as { db: StoragePort }).db)).toEqual([...expected].sort());
    fresh.close();

    const dir = mkdtempSync(join(tmpdir(), "monet-source-index-repair-"));
    const path = join(dir, "monet.db");
    try {
      const first = new MonetCore(path);
      const db = (first as unknown as { db: StoragePort }).db;
      db.exec(`DROP INDEX idx_source_cleanup_run`);
      first.close();
      const reopened = new MonetCore(path);
      expect(indexNames((reopened as unknown as { db: StoragePort }).db)).toEqual([...expected].sort());
      reopened.close();

      const dropAll = new MonetCore(path);
      const dropAllDb = (dropAll as unknown as { db: StoragePort }).db;
      for (const name of expected) dropAllDb.exec(`DROP INDEX ${name}`);
      dropAll.close();
      const repairedAll = new MonetCore(path);
      expect(indexNames((repairedAll as unknown as { db: StoragePort }).db)).toEqual([...expected].sort());
      repairedAll.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("physically enforces uq_source_chunks_active_concept_slot: relaxed across slots, still exclusive within one (item 3b)", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-a-slot-index"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-1" });
      if (begun.kind !== "started") throw new Error("expected started run");

      const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
      const buildChunk = (bindingId: string, headingPath: string[], documentSequence: number, content: string) => {
        const contentHash = computeSourceContentHash(Buffer.from(content, "utf8"));
        const ingestFingerprint = computeSourceIngestFingerprint({
          contentHash, headingPath, metadata, ingestConfigHash: begun.run.ingestConfigHash,
        });
        return {
          bindingId, bindingGeneration: 1,
          operationId: computeSourceOperationId(begun.run.sourceId, bindingId, ingestFingerprint, begun.run.snapshotId, 1),
          relativePath: "README.md", headingPath, occurrence: 1, segmentIndex: 1, documentSequence,
          contentHash, ingestFingerprint, metadata,
          sourceRef: `source://source-a/README.md#${headingPath[0].toLowerCase()}~1`, content,
        };
      };
      const staged = manifest(begun.run, {
        chunks: [
          buildChunk("binding-1", ["Intro"], 1, "Intro body"),
          buildChunk("binding-2", ["Details"], 2, "Details body"),
        ],
      });
      core.stageSourceManifest(staged);

      // Two DIFFERENT slots (different heading) of the SAME file legitimately share one concept —
      // the relaxed half of file=concept's invariant, proven through the real write path.
      const first = await core.storeSource(staged.chunks[0].content, {
        circle: "source-a", sourceRefs: [staged.chunks[0].sourceRef], operationId: staged.chunks[0].operationId,
        resolution: "forceNew",
      });
      core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-1", conceptId: first.conceptId, observationId: first.observationId,
        predecessorObservationId: null, writeState: "committed",
      });
      const second = await core.storeSource(staged.chunks[1].content, {
        circle: "source-a", sourceRefs: [staged.chunks[1].sourceRef], operationId: staged.chunks[1].operationId,
        attachTo: first.conceptId,
      });
      core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-2", conceptId: second.conceptId, observationId: second.observationId,
        predecessorObservationId: null, writeState: "committed",
      });
      core.publishSourceRun({ runId: begun.run.id, activationToken: core.beginSourceActivation(begun.run.id) });

      const db = (core as unknown as { db: StoragePort }).db;
      const activeRows = db.prepare(
        `SELECT * FROM source_chunks WHERE lifecycle='active' ORDER BY heading_path_json`,
      ).all() as Array<Record<string, unknown>>;
      expect(activeRows).toHaveLength(2);
      expect(activeRows[0].concept_id).toBe(first.conceptId);
      expect(activeRows[1].concept_id).toBe(first.conceptId);

      // The retained half: physically cloning one active row's full slot identity (same
      // concept_id/relative_path/heading_path_json/occurrence/segment_index), changing only the
      // run/binding primary key, must be rejected by uq_source_chunks_active_concept_slot — a real
      // physical backstop, not merely an application-layer check.
      const template = activeRows[0];
      const insertClone = (runId: string, bindingId: string) => db.prepare(`
        INSERT INTO source_chunks (
          source_id, run_id, snapshot_id, config_version, binding_id, binding_generation, operation_id,
          relative_path, heading_path_json, occurrence, segment_index, document_sequence,
          content_hash, ingest_fingerprint, metadata_json, source_ref, content,
          concept_id, observation_id, predecessor_observation_id, write_state, lifecycle
        ) VALUES (
          @source_id, @run_id, @snapshot_id, @config_version, @binding_id, @binding_generation, @operation_id,
          @relative_path, @heading_path_json, @occurrence, @segment_index, @document_sequence,
          @content_hash, @ingest_fingerprint, @metadata_json, @source_ref, @content,
          @concept_id, @observation_id, @predecessor_observation_id, @write_state, @lifecycle
        )
      `).run({ ...template, run_id: runId, binding_id: bindingId, observation_id: null, write_state: "committed" });

      expect(() => insertClone("clone-run", "clone-binding")).toThrow(/UNIQUE constraint failed/);

      // Lifecycle-scoping: the partial index only covers lifecycle='active'. Superseding the
      // original row at that exact slot frees it, so a NEW active row at the SAME slot (still a
      // distinct run_id/binding_id) is accepted — exactly what real supersession relies on.
      db.prepare(`UPDATE source_chunks SET lifecycle='superseded' WHERE run_id=@run_id AND binding_id=@binding_id`)
        .run({ run_id: template.run_id as string, binding_id: template.binding_id as string });
      expect(() => insertClone("clone-run-2", "clone-binding-2")).not.toThrow();
      const stillActive = db.prepare(
        `SELECT relative_path, heading_path_json FROM source_chunks WHERE lifecycle='active' AND concept_id=?`,
      ).all(first.conceptId);
      expect(stillActive).toHaveLength(2); // the untouched Details row + the freshly-inserted clone
    } finally {
      core.close();
    }
  });

  it("serially repairs partial v9 registry and ledger columns across two open connections, landing on current schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-v9-partial-race-"));
    const path = join(dir, "monet.db");
    try {
      const first = new MonetCore(path);
      const db = (first as unknown as { db: StoragePort }).db;
      for (const column of ["active_run_id", "active_snapshot_id", "active_ingest_config_hash"]) {
        db.exec(`ALTER TABLE knowledge_sources DROP COLUMN ${column}`);
      }
      for (const table of ["source_staged_chunks", "source_chunks"]) {
        db.exec(`ALTER TABLE ${table} DROP COLUMN metadata_json`);
        db.exec(`ALTER TABLE ${table} DROP COLUMN binding_generation`);
      }
      first.close();

      const left = new MonetCore(path);
      const right = new MonetCore(path);
      for (const core of [left, right]) {
        const openDb = (core as unknown as { db: StoragePort }).db;
        const registryColumns = (openDb.prepare(`PRAGMA table_info(knowledge_sources)`).all() as Array<{ name: string }>).map((column) => column.name);
        expect(registryColumns).toEqual(expect.arrayContaining([
          "active_run_id", "active_snapshot_id", "active_ingest_config_hash",
        ]));
        for (const table of ["source_staged_chunks", "source_chunks"]) {
          const columns = (openDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
          expect(columns).toEqual(expect.arrayContaining(["metadata_json", "binding_generation"]));
        }
      }
      right.close();
      left.close();

      const again = new MonetCore(path);
      expect(((again as unknown as { db: StoragePort }).db.pragma("user_version", { simple: true }))).toBe(11);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not backfill attempt events for a completely removed source on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-removed-attempts-"));
    const path = join(dir, "monet.db");
    const auth = { callerId: "caller", projectId: "project" };
    try {
      const first = new MonetCore(path);
      first.createSource(sourceInput("removed-source", join(dir, "repo")));
      const begun = first.beginSourceRun({ sourceId: "removed-source", snapshotId: "retained-snapshot" });
      if (begun.kind !== "started") throw new Error("expected started run");
      first.abortSourceRun(begun.run.id, "failed", "retained failed run");
      first.removeSource("removed-source");
      first.beginSourceRemoval("removed-source");
      first.markSourceRemovalFilesRevoked("removed-source");
      expect(first.recordSourceRunInvocation({
        sourceId: "removed-source", runId: begun.run.id, result: "failed", reason: "failure before removal completion",
        configVersion: begun.run.configVersion, leaseFence: begun.run.leaseFence,
      })).toEqual(expect.any(Number));
      first.completeSourceRemoval("removed-source");
      const firstDb = (first as unknown as { db: StoragePort }).db;
      expect(firstDb.prepare(`SELECT COUNT(*) AS count FROM source_sync_runs WHERE source_id=?`).get("removed-source")).toEqual({ count: 1 });
      expect(firstDb.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events WHERE source_id=?`).get("removed-source")).toEqual({ count: 0 });
      expect(() => first.recordSourceRunInvocation({
        sourceId: "removed-source", runId: begun.run.id, result: "failed", reason: "late retained-run receipt",
        configVersion: begun.run.configVersion, leaseFence: begun.run.leaseFence,
      })).toThrow("source run invocation is closed by completed removal");
      for (const table of ["source_attempt_events", "source_pre_pin_attempts", "source_verification_checks"]) {
        expect(firstDb.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_id=?`).get("removed-source")).toEqual({ count: 0 });
      }
      first.close();

      for (let reopen = 0; reopen < 2; reopen += 1) {
        const core = new MonetCore(path);
        const db = (core as unknown as { db: StoragePort }).db;
        for (const table of ["source_attempt_events", "source_pre_pin_attempts", "source_verification_checks"]) {
          expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_id=?`).get("removed-source")).toEqual({ count: 0 });
        }
        expect(core.completeSourceRemoval("removed-source").state).toBe("complete");
        expect(core.getSource("removed-source")).toBeNull();
        expect(core.getSource("removed-source", { includeTombstoned: true })).toMatchObject({ lifecycle: "tombstoned" });
        expect(() => core.sourceStatus("removed-source", auth)).toThrow("source is unavailable");
        core.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bumps v8 stores to current schema idempotently while graph-disabled fresh stores remain v0", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-ledger-migrate-"));
    const path = join(dir, "monet.db");
    try {
      const first = new MonetCore(path);
      const db = (first as unknown as { db: StoragePort }).db;
      // Simulate a real v8 store: the registry exists, but none of the v9 ledger tables do.
      for (const table of ["source_removal_items", "source_removals", "source_cleanup_items", "source_chunks", "source_staged_chunks", "source_files", "source_staged_files", "source_snapshots", "source_sync_runs"]) {
        db.exec(`DROP TABLE ${table}`);
      }
      db.pragma("user_version = 8");
      first.close();

      const migrated = new MonetCore(path);
      const migratedDb = (migrated as unknown as { db: StoragePort }).db;
      expect(migratedDb.pragma("user_version", { simple: true })).toBe(11);
      for (const table of ["source_sync_runs", "source_snapshots", "source_staged_files", "source_files", "source_staged_chunks", "source_chunks", "source_cleanup_items", "source_removals", "source_removal_items"]) {
        expect(migratedDb.prepare(`PRAGMA table_info(${table})`).all()).not.toEqual([]);
      }
      for (const table of ["source_staged_chunks", "source_chunks"]) {
        expect((migratedDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((column) => column.name === "binding_generation")).toBe(true);
      }
      expect((migratedDb.prepare(`PRAGMA table_info(source_cleanup_items)`).all() as Array<{ name: string }>).some((column) => column.name === "operation_id")).toBe(true);
      expect((migratedDb.prepare(`SELECT sql FROM sqlite_master WHERE name='source_cleanup_items'`).get() as { sql: string }).sql).toContain("quarantine-non-authorizing");
      migrated.close();
      const reopened = new MonetCore(path);
      expect(((reopened as unknown as { db: StoragePort }).db.pragma("user_version", { simple: true }))).toBe(11);
      reopened.close();
      const disabled = new MonetCore(":memory:", { graphEnabled: false });
      expect(((disabled as unknown as { db: StoragePort }).db.pragma("user_version", { simple: true }))).toBe(0);
      disabled.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades the pre-quarantine cleanup table without losing pending items", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-cleanup-migrate-"));
    const path = join(dir, "monet.db");
    try {
      const first = new MonetCore(path);
      const db = (first as unknown as { db: StoragePort }).db;
      db.exec(`
        DROP TABLE source_cleanup_items;
        CREATE TABLE source_cleanup_items (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL, run_id TEXT NOT NULL, target_run_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('retire-absent','reconcile-orphan')), binding_id TEXT NOT NULL,
          concept_id TEXT, observation_id TEXT, predecessor_observation_id TEXT, created_at INTEGER NOT NULL,
          acknowledged_at INTEGER, UNIQUE (run_id,binding_id)
        );
        CREATE INDEX idx_source_cleanup_run ON source_cleanup_items(run_id,acknowledged_at,id);
        INSERT INTO source_cleanup_items
          (id,source_id,run_id,target_run_id,kind,binding_id,concept_id,observation_id,created_at)
          VALUES ('legacy-item','source-a','legacy-run','legacy-run','reconcile-orphan','binding-1','concept-1','observation-1',1);
      `);
      first.close();

      const reopened = new MonetCore(path);
      const reopenedDb = (reopened as unknown as { db: StoragePort }).db;
      expect((reopenedDb.prepare(`SELECT sql FROM sqlite_master WHERE name='source_cleanup_items'`).get() as { sql: string }).sql).toContain("quarantine-non-authorizing");
      expect(reopened.listSourceCleanupItems("legacy-run")).toEqual([
        expect.objectContaining({ id: "legacy-item", kind: "reconcile-orphan", operationId: null, acknowledgedAt: null }),
      ]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["legacy-only", "both-with-current", "both-exact-duplicate"] as const)("recovers cleanup migration crash state: %s", (state) => {
    const dir = mkdtempSync(join(tmpdir(), `monet-source-cleanup-${state}-`));
    const path = join(dir, "monet.db");
    try {
      const first = new MonetCore(path);
      const db = (first as unknown as { db: StoragePort }).db;
      db.exec(`
        DROP INDEX idx_source_cleanup_run;
        ALTER TABLE source_cleanup_items RENAME TO source_cleanup_items_legacy;
        INSERT INTO source_cleanup_items_legacy
          (id,source_id,run_id,target_run_id,kind,binding_id,operation_id,concept_id,observation_id,created_at)
          VALUES ('legacy-item','source-a','legacy-run','legacy-run','reconcile-orphan','binding-legacy','legacy-op','concept-legacy','observation-legacy',1);
      `);
      if (state !== "legacy-only") {
        db.exec(`
          CREATE TABLE source_cleanup_items (
            id TEXT PRIMARY KEY, source_id TEXT NOT NULL, run_id TEXT NOT NULL, target_run_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('retire-absent','reconcile-orphan','quarantine-non-authorizing')),
            binding_id TEXT NOT NULL, operation_id TEXT, concept_id TEXT, observation_id TEXT,
            predecessor_observation_id TEXT, created_at INTEGER NOT NULL, acknowledged_at INTEGER,
            UNIQUE (run_id,binding_id)
          );
        `);
        if (state === "both-with-current") {
          db.exec(`INSERT INTO source_cleanup_items
            (id,source_id,run_id,target_run_id,kind,binding_id,operation_id,concept_id,observation_id,created_at)
            VALUES ('current-item','source-a','current-run','current-run','reconcile-orphan','binding-current','current-op','concept-current','observation-current',2)`);
        } else {
          db.exec(`INSERT INTO source_cleanup_items
            (id,source_id,run_id,target_run_id,kind,binding_id,operation_id,concept_id,observation_id,created_at)
            VALUES ('legacy-item','source-a','legacy-run','legacy-run','reconcile-orphan','binding-legacy','legacy-op','concept-legacy','observation-legacy',1)`);
        }
      }
      first.close();

      const reopened = new MonetCore(path);
      expect(reopened.listSourceCleanupItems("legacy-run")).toEqual([
        expect.objectContaining({ id: "legacy-item", operationId: "legacy-op", acknowledgedAt: null }),
      ]);
      if (state === "both-with-current") {
        expect(reopened.listSourceCleanupItems("current-run")).toEqual([
          expect.objectContaining({ id: "current-item", operationId: "current-op", acknowledgedAt: null }),
        ]);
      }
      const reopenedDb = (reopened as unknown as { db: StoragePort }).db;
      expect(reopenedDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_cleanup_items_legacy'`).get()).toBeUndefined();
      reopened.close();

      const again = new MonetCore(path);
      expect(again.listSourceCleanupItems("legacy-run")).toHaveLength(1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects cleanup reconstruction collisions atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-cleanup-collision-migrate-"));
    const path = join(dir, "monet.db");
    try {
      const first = new MonetCore(path);
      const db = (first as unknown as { db: StoragePort }).db;
      db.exec(`
        DROP INDEX idx_source_cleanup_run;
        ALTER TABLE source_cleanup_items RENAME TO source_cleanup_items_legacy;
        INSERT INTO source_cleanup_items_legacy
          (id,source_id,run_id,target_run_id,kind,binding_id,operation_id,created_at)
          VALUES ('collision','source-a','run-a','run-a','reconcile-orphan','binding-a','op-a',1);
        CREATE TABLE source_cleanup_items (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL, run_id TEXT NOT NULL, target_run_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('retire-absent','reconcile-orphan','quarantine-non-authorizing')),
          binding_id TEXT NOT NULL, operation_id TEXT, concept_id TEXT, observation_id TEXT,
          predecessor_observation_id TEXT, created_at INTEGER NOT NULL, acknowledged_at INTEGER,
          UNIQUE (run_id,binding_id)
        );
        INSERT INTO source_cleanup_items
          (id,source_id,run_id,target_run_id,kind,binding_id,operation_id,created_at)
          VALUES ('collision','source-a','run-b','run-b','reconcile-orphan','binding-b','op-b',2);
      `);
      first.close();

      expect(() => new MonetCore(path)).toThrow(/cleanup migration collision/);
      const raw = new Database(path, { readonly: true });
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM source_cleanup_items`).get()).toEqual({ n: 1 });
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM source_cleanup_items_legacy`).get()).toEqual({ n: 1 });
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fences staged and aborted source evidence from every generic read projection", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-ledger-read-fence"));
      const native = await core.store("native sentinel knowledge", { circle: "source-a", resolution: "forceNew" });
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "read-fence" });
      if (begun.kind !== "started") throw new Error("expected run");
      const staged = manifestWithContent(begun.run, 1, "source sentinel knowledge");
      core.stageSourceManifest(staged);
      const source = await materialize(core, begun.run, staged, "engine-written");

      const assertFence = async () => {
        expect((await core.search("source sentinel knowledge", { circle: "source-a", limit: 20 })).map((card) => card.id)).not.toContain(source.stored.conceptId);
        expect(await core.getConcept(source.stored.conceptId)).toBeNull();
        expect((await core.gather("source sentinel knowledge", { circle: "source-a", limit: 20 })).ranked.map((card) => card.id)).not.toContain(source.stored.conceptId);
        expect(core.listMemories("source-a").map((card) => card.id)).toEqual([native.conceptId]);
        expect(core.prewarm("source-a").topConcepts.map((card) => card.id)).toEqual([native.conceptId]);
        expect(core.conceptCount("source-a")).toBe(1);
        expect(core.observationCount()).toBe(1);
        expect(core.stats("source-a")).toMatchObject({ concepts: 1, observations: 1, dirty: 1 });
        expect(core.listCircles().find((circle) => circle.circle === "source-a")?.concepts).toBe(1);
        expect(core.circleOf(source.stored.conceptId)).toBeNull();
        expect(core.conceptEntities(source.stored.conceptId)).toEqual([]);
      };

      await assertFence();
      core.abortSourceRun(begun.run.id, "failed", "exercise aborted fence");
      await assertFence();
      expect((await core.getConcept(native.conceptId))?.body).toContain("native sentinel knowledge");
    } finally {
      core.close();
    }
  });
});

describe("chunk-level vs whole-file embedding (item 6; revised by chunk-granular source retrieval)", () => {
  it("embeds each chunk write with its own raw content once, and recomputeSourceConceptBody separately embeds the whole reconstructed file exactly once per recompute", async () => {
    const real = new HashingEmbeddingProvider();
    const calls: string[] = [];
    const spy: EmbeddingProvider = {
      dim: real.dim,
      modelId: real.modelId,
      embed: (text) => {
        calls.push(text);
        return real.embed(text);
      },
    };
    const core = new MonetCore(":memory:", { embedder: spy });
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-a-file-embed"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-1" });
      if (begun.kind !== "started") throw new Error("expected started run");

      const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
      const buildChunk = (bindingId: string, headingPath: string[], documentSequence: number, content: string) => {
        const contentHash = computeSourceContentHash(Buffer.from(content, "utf8"));
        const ingestFingerprint = computeSourceIngestFingerprint({
          contentHash, headingPath, metadata, ingestConfigHash: begun.run.ingestConfigHash,
        });
        return {
          bindingId, bindingGeneration: 1,
          operationId: computeSourceOperationId(begun.run.sourceId, bindingId, ingestFingerprint, begun.run.snapshotId, 1),
          relativePath: "README.md", headingPath, occurrence: 1, segmentIndex: 1, documentSequence,
          contentHash, ingestFingerprint, metadata,
          sourceRef: `source://source-a/README.md#${headingPath[0].toLowerCase()}~1`, content,
        };
      };
      const staged = manifest(begun.run, {
        chunks: [
          buildChunk("binding-1", ["Intro"], 1, "Intro body text"),
          buildChunk("binding-2", ["Details"], 2, "Details body text"),
        ],
      });
      core.stageSourceManifest(staged);

      const first = await core.storeSource(staged.chunks[0].content, {
        circle: "source-a", sourceRefs: [staged.chunks[0].sourceRef], operationId: staged.chunks[0].operationId,
        resolution: "forceNew",
      });
      core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-1", conceptId: first.conceptId, observationId: first.observationId,
        predecessorObservationId: null, writeState: "committed",
      });
      const second = await core.storeSource(staged.chunks[1].content, {
        circle: "source-a", sourceRefs: [staged.chunks[1].sourceRef], operationId: staged.chunks[1].operationId,
        attachTo: first.conceptId,
      });
      core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-2", conceptId: second.conceptId, observationId: second.observationId,
        predecessorObservationId: null, writeState: "committed",
      });
      // Chunk-granular source retrieval (ratified): each chunk write now embeds its OWN raw
      // content once — the per-chunk retrieval vector search()/gather() rank a source concept's
      // best chunk by (scoreSourceConcepts) — never the whole file at this point, since
      // recomputeSourceConceptBody hasn't run yet. The concept's own placeholder embedding
      // (concepts.embedding at create time) is unaffected and still uses no real embed() call.
      expect(calls).toEqual(["Intro body text", "Details body text"]);

      core.publishSourceRun({ runId: begun.run.id, activationToken: core.beginSourceActivation(begun.run.id) });
      expect(calls).toHaveLength(2); // publish alone still doesn't recompute/embed

      await core.recomputeSourceConceptBody(first.conceptId);
      expect(calls).toHaveLength(3);
      // The THIRD call — recompute's own — embeds the FILE's reconstructed body (both chunks,
      // position-ordered), not either chunk's own text in isolation. Unchanged by this revision:
      // recomputeSourceConceptBody still derives a source concept's OWN embedding straight from
      // its body text, never from the per-chunk observations.embedding values above.
      expect(calls[2]).toContain("Intro body text");
      expect(calls[2]).toContain("Details body text");
      expect(calls[2]).not.toBe("Intro body text");
      expect(calls[2]).not.toBe("Details body text");

      // A second recompute (e.g. a later sync cycle) embeds again exactly once more — linear in
      // recompute count, never per chunk and never accumulating extra calls per chunk touched.
      await core.recomputeSourceConceptBody(first.conceptId);
      expect(calls).toHaveLength(4);
    } finally {
      core.close();
    }
  });
});

describe("recomputeSourceConceptBody CAS against a concurrent chunk-set mutation (review fix, IMPORTANT)", () => {
  it("retries against the current chunk set instead of persisting a body gathered before a concurrent chunk landed", async () => {
    // embed() is async and runs OUTSIDE any transaction (SQLite transactions are synchronous), so
    // the active chunk set can legitimately change between the gather (body/title/refs built from
    // a SELECT) and the write transaction that persists them — a race the write transaction used
    // to be blind to (it re-checked only concept status, never the chunk set it read from). This
    // simulates exactly that: a chunk lands mid-embed, via the embedder itself as the interleave
    // point, standing in for a concurrent writer.
    //
    // Chunk-granular source retrieval (ratified) added its OWN embed() calls earlier in this same
    // test — one per chunk write (storeSourceChunk), well before recomputeSourceConceptBody ever
    // runs. The race under test is specifically recomputeSourceConceptBody's own gather-then-write
    // window, so the injection is armed explicitly right before that call rather than firing on
    // whichever embed() call happens to be globally first — the two chunk-write embeds above have
    // no SELECT-then-write CAS of their own for a concurrent row to race.
    const real = new HashingEmbeddingProvider();
    const db = { current: null as unknown as StoragePort };
    const calls: string[] = [];
    let armed = false;
    let landedConcurrentChunk = false;
    const spy: EmbeddingProvider = {
      dim: real.dim,
      modelId: real.modelId,
      embed: (text) => {
        calls.push(text);
        if (armed && !landedConcurrentChunk) {
          landedConcurrentChunk = true;
          // Clone an existing active row's full shape, only changing what must be unique — the
          // ledger's own realistic row shape, not a hand-rolled partial one.
          const template = db.current
            .prepare(`SELECT * FROM source_chunks WHERE lifecycle='active' LIMIT 1`)
            .get() as Record<string, unknown>;
          db.current.prepare(`
            INSERT INTO source_chunks (
              source_id, run_id, snapshot_id, config_version, binding_id, binding_generation, operation_id,
              relative_path, heading_path_json, occurrence, segment_index, document_sequence,
              content_hash, ingest_fingerprint, metadata_json, source_ref, content,
              concept_id, observation_id, predecessor_observation_id, write_state, lifecycle
            ) VALUES (
              @source_id, @run_id, @snapshot_id, @config_version, @binding_id, @binding_generation, @operation_id,
              @relative_path, @heading_path_json, @occurrence, @segment_index, @document_sequence,
              @content_hash, @ingest_fingerprint, @metadata_json, @source_ref, @content,
              @concept_id, @observation_id, @predecessor_observation_id, @write_state, @lifecycle
            )
          `).run({
            ...template, run_id: "concurrent-run", binding_id: "concurrent-binding",
            heading_path_json: JSON.stringify(["Concurrent"]), document_sequence: 99,
            content: "concurrently landed content", observation_id: null, write_state: "committed",
          });
        }
        return real.embed(text);
      },
    };
    const core = new MonetCore(":memory:", { embedder: spy });
    db.current = (core as unknown as { db: StoragePort }).db;
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-a-recompute-cas"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-1" });
      if (begun.kind !== "started") throw new Error("expected started run");

      const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
      const buildChunk = (bindingId: string, headingPath: string[], documentSequence: number, content: string) => {
        const contentHash = computeSourceContentHash(Buffer.from(content, "utf8"));
        const ingestFingerprint = computeSourceIngestFingerprint({
          contentHash, headingPath, metadata, ingestConfigHash: begun.run.ingestConfigHash,
        });
        return {
          bindingId, bindingGeneration: 1,
          operationId: computeSourceOperationId(begun.run.sourceId, bindingId, ingestFingerprint, begun.run.snapshotId, 1),
          relativePath: "README.md", headingPath, occurrence: 1, segmentIndex: 1, documentSequence,
          contentHash, ingestFingerprint, metadata,
          sourceRef: `source://source-a/README.md#${headingPath[0].toLowerCase()}~1`, content,
        };
      };
      const staged = manifest(begun.run, {
        chunks: [
          buildChunk("binding-1", ["Intro"], 1, "Intro body text"),
          buildChunk("binding-2", ["Details"], 2, "Details body text"),
        ],
      });
      core.stageSourceManifest(staged);
      const first = await core.storeSource(staged.chunks[0].content, {
        circle: "source-a", sourceRefs: [staged.chunks[0].sourceRef], operationId: staged.chunks[0].operationId,
        resolution: "forceNew",
      });
      core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-1", conceptId: first.conceptId, observationId: first.observationId,
        predecessorObservationId: null, writeState: "committed",
      });
      const second = await core.storeSource(staged.chunks[1].content, {
        circle: "source-a", sourceRefs: [staged.chunks[1].sourceRef], operationId: staged.chunks[1].operationId,
        attachTo: first.conceptId,
      });
      core.recordSourceBindingReceipt({
        runId: begun.run.id, bindingId: "binding-2", conceptId: second.conceptId, observationId: second.observationId,
        predecessorObservationId: null, writeState: "committed",
      });
      core.publishSourceRun({ runId: begun.run.id, activationToken: core.beginSourceActivation(begun.run.id) });

      // Arm the injection HERE, not at construction: the two chunk writes above already made
      // their own embed() calls (chunk-granular source retrieval) with no gather-then-write CAS of
      // their own — only recomputeSourceConceptBody's window below is under test.
      const callsBeforeRecompute = calls.length;
      armed = true;
      // Does not throw, does not silently persist a stale two-chunk body — retries and picks up
      // the concurrently landed third chunk.
      await core.recomputeSourceConceptBody(first.conceptId);

      expect(calls.length - callsBeforeRecompute).toBeGreaterThan(1); // at least one stale attempt, then a successful retry
      const db2 = db.current;
      const persisted = db2.prepare(`SELECT body FROM concepts WHERE id=?`).get(first.conceptId) as { body: string };
      expect(persisted.body).toContain("Intro body text");
      expect(persisted.body).toContain("Details body text");
      expect(persisted.body).toContain("concurrently landed content");
      // The LAST embed call (the one that actually got persisted) covers all three chunks — the
      // first, stale call (two chunks only) never won.
      expect(calls[calls.length - 1]).toContain("concurrently landed content");
    } finally {
      core.close();
    }
  });
});

describe("recomputeSourceConceptBody body reconstruction (round 4, Codex thread 9)", () => {
  it("joins split segments of ONE oversized section with a single newline, never an artificial blank paragraph", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-a-split-segments"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-1" });
      if (begun.kind !== "started") throw new Error("expected started run");
      const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
      const buildChunk = (
        bindingId: string, headingPath: string[], occurrence: number, segmentIndex: number, documentSequence: number, content: string,
      ) => {
        const contentHash = computeSourceContentHash(Buffer.from(content, "utf8"));
        const ingestFingerprint = computeSourceIngestFingerprint({
          contentHash, headingPath, metadata, ingestConfigHash: begun.run.ingestConfigHash,
        });
        return {
          bindingId, bindingGeneration: 1,
          operationId: computeSourceOperationId(begun.run.sourceId, bindingId, ingestFingerprint, begun.run.snapshotId, 1),
          relativePath: "README.md", headingPath, occurrence, segmentIndex, documentSequence,
          contentHash, ingestFingerprint, metadata,
          sourceRef: `source://source-a/README.md#${headingPath[0]!.toLowerCase()}~${occurrence}`, content,
        };
      };
      // ONE section ("Big") split into two chunker segments — segmentSection (source-chunker.ts)
      // strips each segment's OWN trailing newline before storing it, so the join between segment 1
      // and segment 2 is NOT a section break and must not gain an artificial blank line. A second,
      // genuinely separate section ("Small") follows, where a real "\n\n" break IS expected.
      const staged = manifest(begun.run, {
        chunks: [
          buildChunk("binding-1", ["Big"], 1, 1, 1, "big section line one\nbig section line two"),
          buildChunk("binding-2", ["Big"], 1, 2, 2, "big section line three\nbig section line four"),
          buildChunk("binding-3", ["Small"], 1, 1, 3, "small section body"),
        ],
      });
      core.stageSourceManifest(staged);
      let conceptId: string | undefined;
      for (const chunk of staged.chunks) {
        const stored = await core.storeSource(chunk.content, {
          circle: "source-a", sourceRefs: [chunk.sourceRef], operationId: chunk.operationId,
          ...(conceptId ? { attachTo: conceptId } : { resolution: "forceNew" as const }),
        });
        conceptId = stored.conceptId;
        core.recordSourceBindingReceipt({
          runId: begun.run.id, bindingId: chunk.bindingId, conceptId: stored.conceptId, observationId: stored.observationId,
          predecessorObservationId: null, writeState: "committed",
        });
      }
      core.publishSourceRun({ runId: begun.run.id, activationToken: core.beginSourceActivation(begun.run.id) });
      await core.recomputeSourceConceptBody(conceptId!);

      const persisted = (core as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db
        .prepare(`SELECT body FROM concepts WHERE id=?`).get(conceptId) as { body: string };
      // Same-section split segments: exactly ONE newline at the join, never a blank line.
      expect(persisted.body).toContain("big section line two\nbig section line three");
      expect(persisted.body).not.toContain("big section line two\n\nbig section line three");
      // Genuine section boundary: the real "\n\n" break is preserved.
      expect(persisted.body).toContain("big section line four\n\nsmall section body");
      expect(persisted.body).not.toContain("big section line four\nsmall section body");
    } finally {
      core.close();
    }
  });
});

describe("recomputeSourceConceptBody support_count normalization (round 4, Codex thread 7)", () => {
  it("resets support_count to the CURRENT active chunk count, undoing per-write inflation from prior edits", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(sourceInput("source-a", "/tmp/source-a-support-count"));
      const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-1" });
      if (begun.kind !== "started") throw new Error("expected started run");
      const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
      const buildChunk = (bindingId: string, headingPath: string[], documentSequence: number, content: string) => {
        const contentHash = computeSourceContentHash(Buffer.from(content, "utf8"));
        const ingestFingerprint = computeSourceIngestFingerprint({
          contentHash, headingPath, metadata, ingestConfigHash: begun.run.ingestConfigHash,
        });
        return {
          bindingId, bindingGeneration: 1,
          operationId: computeSourceOperationId(begun.run.sourceId, bindingId, ingestFingerprint, begun.run.snapshotId, 1),
          relativePath: "README.md", headingPath, occurrence: 1, segmentIndex: 1, documentSequence,
          contentHash, ingestFingerprint, metadata,
          sourceRef: `source://source-a/README.md#${headingPath[0]!.toLowerCase()}~1`, content,
        };
      };
      const staged = manifest(begun.run, {
        chunks: [
          buildChunk("binding-1", ["A"], 1, "section a body"),
          buildChunk("binding-2", ["B"], 2, "section b body"),
          buildChunk("binding-3", ["C"], 3, "section c body"),
        ],
      });
      core.stageSourceManifest(staged);
      let conceptId: string | undefined;
      for (const chunk of staged.chunks) {
        const stored = await core.storeSource(chunk.content, {
          circle: "source-a", sourceRefs: [chunk.sourceRef], operationId: chunk.operationId,
          ...(conceptId ? { attachTo: conceptId } : { resolution: "forceNew" as const }),
        });
        conceptId = stored.conceptId;
        core.recordSourceBindingReceipt({
          runId: begun.run.id, bindingId: chunk.bindingId, conceptId: stored.conceptId, observationId: stored.observationId,
          predecessorObservationId: null, writeState: "committed",
        });
      }
      core.publishSourceRun({ runId: begun.run.id, activationToken: core.beginSourceActivation(begun.run.id) });

      // storeSourceChunk's attach branch increments support_count on every write — before ANY
      // recompute has ever run, the raw row already sits at 3 (1 from creation + 2 attaches).
      // Simulate several MORE attaches (exactly what a repeatedly re-synced/edited file produces)
      // without recomputing in between, so support_count keeps climbing well past the file's
      // actual, current section count.
      for (let i = 0; i < 5; i++) {
        await core.storeSource(`irrelevant repeated attach ${i}`, {
          circle: "source-a", sourceRefs: [staged.chunks[0]!.sourceRef], attachTo: conceptId!,
        });
      }
      const db = (core as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db;
      const inflated = db.prepare(`SELECT support_count FROM concepts WHERE id=?`).get(conceptId) as { support_count: number };
      expect(inflated.support_count).toBe(8); // 1 create + 2 attaches + 5 more attaches

      await core.recomputeSourceConceptBody(conceptId!);
      const normalized = db.prepare(`SELECT support_count FROM concepts WHERE id=?`).get(conceptId) as { support_count: number };
      // Only 3 chunks are ACTIVE (the 5 "irrelevant repeated attach" calls created plain
      // observations, never source_chunks rows) — support_count must reflect that, not the 8
      // storeSourceChunk-side increments.
      expect(normalized.support_count).toBe(3);
    } finally {
      core.close();
    }
  });
});
