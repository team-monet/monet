import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MalformedEmbeddingStoreError, MonetCore } from "../engine";
import type { EmbeddingProvider } from "../embedding";
import { registerMonetCoreTools } from "../mcp-server";
import { computeSourceContentHash, computeSourceIngestFingerprint, computeSourceOperationId, sourceHeadingAnchor } from "../source-chunker";
import { computeSourceManifestHash } from "../source-scanner";
import type { SourceSyncRun, StageSourceManifestInput } from "../source-types";
import type { StoragePort } from "../storage";

const auth = Object.freeze({ callerId: "caller", projectId: "project" });
const wrongCaller = Object.freeze({ callerId: "other", projectId: "project" });
const wrongProject = Object.freeze({ callerId: "caller", projectId: "other" });
const circle = "project-circle";
const content = "Published source retrieval evidence about cobalt walruses.";

function sourceInput(
  id = "source-a",
  access = { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] },
  sourceCircle = circle,
) {
  return {
    id, type: "repo-md" as const, name: id, localPath: `/tmp/${id}`, circle: sourceCircle,
    access, writeBack: "none" as const,
  };
}

function oneChunkManifest(run: SourceSyncRun, text = content, bindingGeneration = 1): StageSourceManifestInput {
  const contentHash = computeSourceContentHash(Buffer.from(text, "utf8"));
  const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
  const ingestFingerprint = computeSourceIngestFingerprint({
    contentHash, headingPath: ["Retrieval"], metadata, ingestConfigHash: run.ingestConfigHash,
  });
  const files = [{ relativePath: "README.md", type: "file" as const, contentHash: "file-hash", byteLength: Buffer.byteLength(text), title: "README" }];
  return {
    runId: run.id,
    scanStatus: "complete",
    manifestHash: computeSourceManifestHash(files),
    files,
    chunks: [{
      bindingId: "binding-1", bindingGeneration,
      operationId: computeSourceOperationId(run.sourceId, "binding-1", ingestFingerprint, run.snapshotId, bindingGeneration),
      relativePath: "README.md", headingPath: ["Retrieval"], occurrence: 1, segmentIndex: 1, documentSequence: 1,
      contentHash, ingestFingerprint, metadata,
      sourceRef: `source://${run.sourceId}/README.md#retrieval~1`, content: text,
    }],
  };
}

async function publish(core: MonetCore, sourceId = "source-a", text = content, sourceCircle = circle) {
  const begun = core.beginSourceRun({ sourceId, snapshotId: `snapshot-${sourceId}` });
  if (begun.kind !== "started") throw new Error("expected a new run");
  const manifest = oneChunkManifest(begun.run, text);
  core.stageSourceManifest(manifest);
  const chunk = manifest.chunks[0];
  const stored = await core.storeSource(chunk.content, {
    circle: sourceCircle, sourceRefs: [chunk.sourceRef], operationId: chunk.operationId, resolution: "forceNew",
  });
  core.recordSourceBindingReceipt({
    runId: begun.run.id, bindingId: chunk.bindingId, conceptId: stored.conceptId,
    observationId: stored.observationId, predecessorObservationId: null, writeState: "committed",
  });
  core.publishSourceRun({
    runId: begun.run.id,
    activationToken: core.beginSourceActivation(begun.run.id),
    expectedManifestHash: manifest.manifestHash,
  });
  // File=concept (Phase 1): title/body/embedding are placeholders until this — recomputeSourceConceptBody
  // is the connector's own post-publish step (source-sync.ts's recomputeTouchedSourceConcepts), required
  // here too since this helper drives the ledger by hand instead of through syncSource.
  await core.recomputeSourceConceptBody(stored.conceptId);
  return { run: begun.run, chunk, stored };
}

type RawDb = Pick<StoragePort, "prepare">;
const rawDb = (core: MonetCore): RawDb => (core as unknown as { db: RawDb }).db;

const cores: MonetCore[] = [];
const makeCore = (): MonetCore => {
  const core = new MonetCore(":memory:", { defaultCircle: circle });
  cores.push(core);
  return core;
};
afterEach(() => { while (cores.length) cores.pop()!.close(); });

describe("authorized source-backed generic retrieval", () => {
  it("projects an exact publication across search/list/fetch/gather/prewarm/overview and hides it without exact identity", async () => {
    const core = makeCore();
    core.createSource(sourceInput());
    const { stored, chunk } = await publish(core);

    expect((await core.search("cobalt walruses", { circle, sourceAuthorizationContext: auth })).map((row) => row.id)).toContain(stored.conceptId);
    expect(core.listMemories(circle, { sourceAuthorizationContext: auth })).toContainEqual(expect.objectContaining({ id: stored.conceptId, kind: "source", supportCount: 1 }));
    expect(core.conceptCount(circle, auth)).toBe(1);
    // File=concept (Phase 1), Ruling 9: a source concept's getConcept returns structure (outline)
    // by default, not observations — body is opt-in via includeBody.
    await expect(core.getConcept(stored.conceptId, { synthesize: false, includeBody: true, sourceAuthorizationContext: auth })).resolves.toMatchObject({
      id: stored.conceptId, body: content, outline: [{ observationId: stored.observationId }],
      totalObservations: 1, supportCount: 1, dirty: false, needsSynthesis: false, synthesizedNow: false,
    });
    const gathered = await core.gather("cobalt walruses", { circle, sourceAuthorizationContext: auth });
    expect(gathered.seed).toContainEqual(expect.objectContaining({ id: stored.conceptId, kind: "source" }));
    expect(gathered.ranked).toContainEqual(expect.objectContaining({
      id: stored.conceptId, viaSeed: true, sourceRefsCount: 1,
    }));
    expect(core.overview(circle, { sourceAuthorizationContext: auth }).livingModel).toContainEqual(expect.objectContaining({ id: stored.conceptId }));
    expect(core.overview(circle, { sourceAuthorizationContext: auth })).toMatchObject({
      counts: { concepts: 1, observations: 1 }, livingModel: [expect.objectContaining({ id: stored.conceptId })],
    });

    for (const sourceAuthorizationContext of [undefined, wrongCaller, wrongProject]) {
      expect(await core.search("cobalt walruses", { circle, sourceAuthorizationContext })).toEqual([]);
      expect(core.listMemories(circle, { sourceAuthorizationContext })).toEqual([]);
      expect(core.conceptCount(circle, sourceAuthorizationContext)).toBe(0);
      expect(core.circleOf(stored.conceptId, sourceAuthorizationContext)).toBeNull();
      expect(await core.getConcept(stored.conceptId, { sourceAuthorizationContext })).toBeNull();
      expect(await core.gather("cobalt walruses", { circle, sourceAuthorizationContext })).toEqual({ seed: [], ranked: [], stopReason: "exhausted", reachableByType: {} });
      expect(core.overview(circle, { sourceAuthorizationContext }).livingModel).toEqual([]);
      expect(core.overview(circle, { sourceAuthorizationContext }).counts).toMatchObject({ concepts: 0, observations: 0 });
    }
    expect(await core.getConcept("nonexistent", { sourceAuthorizationContext: auth })).toBeNull();
  });

  it("uses current ACL immediately and keeps the prior active tuple visible during pending replacement", async () => {
    const core = makeCore();
    core.createSource(sourceInput());
    const { stored } = await publish(core);
    expect(await core.getConcept(stored.conceptId, { sourceAuthorizationContext: auth })).not.toBeNull();

    core.updateSource("source-a", { access: { allowedCallerIds: ["other"], allowedProjectIds: ["project"] } });
    expect(await core.getConcept(stored.conceptId, { sourceAuthorizationContext: auth })).toBeNull();
    expect(await core.getConcept(stored.conceptId, { sourceAuthorizationContext: wrongCaller })).not.toBeNull();

    core.updateSource("source-a", { access: { allowedCallerIds: ["caller", "other"], allowedProjectIds: ["project"] } });
    expect(await core.getConcept(stored.conceptId, { sourceAuthorizationContext: auth })).not.toBeNull();
    core.updateSource("source-a", { include: ["*.md"], exclude: ["drafts/**"] });
    expect(core.getSource("source-a")?.status).toBe("pending-replacement");
    expect(await core.getConcept(stored.conceptId, { includeBody: true, sourceAuthorizationContext: auth })).toMatchObject({ body: content });
  });

  it("fails closed for uncommitted, aborted, tombstoned, stale-pointer, foreign-binding and corrupt-observation states", async () => {
    const core = makeCore();
    core.createSource(sourceInput());
    const staged = await core.storeSource("Unpublished staging evidence.", {
      circle, sourceRefs: ["source://source-a/README.md#staged~1"], resolution: "forceNew",
    });
    expect(await core.getConcept(staged.conceptId, { sourceAuthorizationContext: auth })).toBeNull();
    const aborted = core.beginSourceRun({ sourceId: "source-a", snapshotId: "aborted" });
    if (aborted.kind !== "started") throw new Error("expected aborted run");
    core.abortSourceRun(aborted.run.id, "failed", "test abort");
    expect(await core.getConcept(staged.conceptId, { sourceAuthorizationContext: auth })).toBeNull();

    const core2 = makeCore();
    core2.createSource(sourceInput("source-b"));
    const { run, stored } = await publish(core2, "source-b");
    const db = rawDb(core2);
    const visible = async () => (await core2.search("cobalt", { circle, sourceAuthorizationContext: auth })).some((row) => row.id === stored.conceptId);
    expect(await visible()).toBe(true);

    db.prepare(`UPDATE knowledge_sources SET active_snapshot_id='wrong' WHERE id='source-b'`).run();
    expect(await visible()).toBe(false);
    db.prepare(`UPDATE knowledge_sources SET active_snapshot_id=? WHERE id='source-b'`).run(run.snapshotId);
    db.prepare(`UPDATE source_chunks SET source_id='foreign' WHERE run_id=?`).run(run.id);
    expect(await visible()).toBe(false);
    db.prepare(`UPDATE source_chunks SET source_id='source-b' WHERE run_id=?`).run(run.id);
    db.prepare(`UPDATE observations SET source_refs='not-json' WHERE id=?`).run(stored.observationId);
    expect(await visible()).toBe(false);
    db.prepare(`UPDATE observations SET source_refs=? WHERE id=?`).run(JSON.stringify(["source://source-b/README.md#retrieval~1"]), stored.observationId);
    db.prepare(`UPDATE observations SET superseded_by='other',superseded_at=1 WHERE id=?`).run(stored.observationId);
    expect(await visible()).toBe(false);
    db.prepare(`UPDATE observations SET superseded_by=NULL,superseded_at=NULL WHERE id=?`).run(stored.observationId);
    core2.removeSource("source-b");
    expect(await visible()).toBe(false);
  });

  it("hides an authorized publication while its recompute is durably pending, across every read surface (round 4, Codex thread 1, P1)", async () => {
    // The exact crash window Codex found: a publish lands durably (knowledge_sources.active_run_id
    // already advanced) but the process dies (or an admission-skipped scheduled pass, see thread
    // 12) before recomputeSourceConceptBody runs — the concept row still holds its placeholder
    // (first-ever publish) or the PRIOR recompute's now-stale body (a re-publish). Simulated here
    // directly via source_recompute_pending, the SAME durable marker recomputeSourceConceptBody
    // itself clears on success (engine.ts) — reusing it to GATE reads closes the window instead of
    // only ever healing it eventually.
    const core = makeCore();
    core.createSource(sourceInput());
    const { run, stored } = await publish(core);
    expect(await core.getConcept(stored.conceptId, { sourceAuthorizationContext: auth })).not.toBeNull();
    expect((await core.search("cobalt walruses", { circle, sourceAuthorizationContext: auth })).map((row) => row.id)).toContain(stored.conceptId);

    const db = rawDb(core);
    db.prepare(`INSERT INTO source_recompute_pending (concept_id, source_id, run_id, created_at) VALUES (?,?,?,?)`)
      .run(stored.conceptId, "source-a", run.id, Date.now());

    expect(await core.getConcept(stored.conceptId, { sourceAuthorizationContext: auth })).toBeNull();
    expect(await core.search("cobalt walruses", { circle, sourceAuthorizationContext: auth })).toEqual([]);
    expect(core.listMemories(circle, { sourceAuthorizationContext: auth })).toEqual([]);
    const gathered = await core.gather("cobalt walruses", { circle, sourceAuthorizationContext: auth });
    expect(gathered.seed.map((c) => c.id)).not.toContain(stored.conceptId);
    expect(gathered.ranked.map((c) => c.id)).not.toContain(stored.conceptId);

    // No false negatives: once recompute clears the pending row (the normal, non-crashed case —
    // and exactly what the sweep does for a stranded one), the concept is visible again.
    await core.recomputeSourceConceptBody(stored.conceptId);
    expect(await core.getConcept(stored.conceptId, { sourceAuthorizationContext: auth })).not.toBeNull();
    expect((await core.search("cobalt walruses", { circle, sourceAuthorizationContext: auth })).map((row) => row.id)).toContain(stored.conceptId);
  });

  it("fetches only the active observation without synthesis/usefulness writes and sources cannot influence native graph results", async () => {
    const core = makeCore();
    const nativeA = await core.store("Native cobalt walrus anchor.", { circle, resolution: "forceNew" });
    const nativeB = await core.store("supports: #native-cobalt-walrus-anchor distant native detail.", { circle, resolution: "forceNew" });
    core.createSource(sourceInput());
    const { stored } = await publish(core, "source-a", "Cobalt walruses supports: #native-cobalt-walrus-anchor");
    const before = rawDb(core).prepare(`SELECT usefulness_score,dirty FROM concepts WHERE id=?`).get(stored.conceptId);
    const withoutContext = await core.gather("cobalt walrus", { circle });
    const withContext = await core.gather("cobalt walrus", { circle, sourceAuthorizationContext: auth });
    expect(withContext.ranked.filter((row) => row.kind !== "source")).toEqual(withoutContext.ranked);
    expect(withContext.reachableByType).toEqual(withoutContext.reachableByType);
    expect(withContext.ranked.map((row) => row.id)).toEqual(expect.arrayContaining([nativeA.conceptId, nativeB.conceptId, stored.conceptId]));

    // File=concept (Phase 1), Ruling 9: structure (outline), not observations, by default.
    const fetched = await core.getConcept(stored.conceptId, { sourceAuthorizationContext: auth });
    expect(fetched?.outline).toEqual([expect.objectContaining({ observationId: stored.observationId })]);
    expect(rawDb(core).prepare(`SELECT usefulness_score,dirty FROM concepts WHERE id=?`).get(stored.conceptId)).toEqual(before);
    await expect(core.store("forged", { circle, sourceRefs: ["source://source-a/README.md#retrieval~1"] })).rejects.toThrow(/reserved/);
    await expect(core.store("attach", { circle, attachTo: stored.conceptId })).rejects.toThrow(/source concept/);
  });

  it("resolves asserted slugs to a later native row when an earlier connector row has the same slug", async () => {
    const core = makeCore();
    const connector = await core.storeSource("Shared asserted target.", {
      circle, sourceRefs: ["source://shadow/README.md#shared~1"], resolution: "forceNew",
    });
    rawDb(core).prepare(`UPDATE concepts SET kind='fact' WHERE id=?`).run(connector.conceptId);
    const native = await core.store("Shared asserted target.", { circle, resolution: "forceNew" });
    const referrer = await core.store(`Reference note supports: #${native.concept.slug}`, { circle, resolution: "forceNew" });
    const supports = core.edges({ circle, type: "supports" });
    expect(supports).toContainEqual(expect.objectContaining({ srcId: referrer.conceptId, dstId: native.conceptId }));
    expect(supports.some((edge) => edge.dstId === connector.conceptId)).toBe(false);
  });

  it("keeps source ingest out of generic graph/entity state and repairs legacy contamination on reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "monet-source-graph-repair-"));
    const dbPath = join(root, "monet.db");
    let core = new MonetCore(dbPath, { defaultCircle: circle });
    const fixedNow = Date.now();
    try {
      const nativeA = await core.store("Native shared module alpha.", { circle, sourceRefs: ["/repo/shared.ts"], resolution: "forceNew" });
      const nativeB = await core.store("Native shared module beta.", { circle, sourceRefs: ["/repo/shared.ts"], resolution: "forceNew" });
      const snapshot = async () => {
        const realNow = Date.now;
        try {
          Date.now = () => fixedNow;
          return {
            gather: await core.gather("Native shared module", { circle, limit: 20 }),
            edges: core.edges({ circle }),
            entitiesA: core.conceptEntities(nativeA.conceptId),
            entitiesB: core.conceptEntities(nativeB.conceptId),
            hubs: core.topEntityHubs(circle, { limit: 20 }),
            entityCount: core.overview(circle).counts.entities,
          };
        } finally { Date.now = realNow; }
      };
      const before = await snapshot();
      core.createSource(sourceInput(
        "denied-graph-source",
        { allowedCallerIds: ["other"], allowedProjectIds: ["project"] },
      ));
      const { stored } = await publish(core, "denied-graph-source", "Native shared module supports: #native-shared-module-alpha");
      expect(await snapshot()).toEqual(before);
      let db = rawDb(core);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM concept_entities WHERE concept_id=?`).get(stored.conceptId)).toEqual({ n: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_edge WHERE src_id=? OR dst_id=?`).get(stored.conceptId, stored.conceptId)).toEqual({ n: 0 });

      const entityKey = "ref:/repo/shared.ts";
      db.prepare(`INSERT INTO concept_entities (concept_id,entity_key,scope) VALUES (?,?,?)`).run(stored.conceptId, entityKey, circle);
      db.prepare(`UPDATE entities SET df=df+1 WHERE key=? AND scope=?`).run(entityKey, circle);
      db.prepare(`INSERT INTO memory_edge (id,src_id,dst_id,type,weight,origin,count,scope,legacy_count)
        VALUES ('legacy-source-edge',?,?, 'supports',1,'asserted',1,?,0)`).run(stored.conceptId, nativeA.conceptId, circle);
      db.prepare(`INSERT INTO memory_edge_components
        (src_id,dst_id,type,scope,writer_id,count,weight,origin,created_at,last_reinforced_at,revision,updated_at)
        VALUES (?,?, 'supports',?,'legacy',1,1,'asserted',1,1,1,1)`).run(stored.conceptId, nativeA.conceptId, circle);
      core.close();
      core = new MonetCore(dbPath, { defaultCircle: circle });
      db = rawDb(core);
      expect(await snapshot()).toEqual(before);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM concept_entities WHERE concept_id=?`).get(stored.conceptId)).toEqual({ n: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM memory_edge WHERE src_id=? OR dst_id=?`).get(stored.conceptId, stored.conceptId)).toEqual({ n: 0 });
      expect(db.prepare(`SELECT df FROM entities WHERE key=? AND scope=?`).get(entityKey, circle)).toEqual({ df: 2 });
    } finally {
      try { core.close(); } catch { /* already closed */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores native about edges suppressed by legacy source-inflated entity df on reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "monet-source-about-repair-"));
    const dbPath = join(root, "monet.db");
    let core = new MonetCore(dbPath, { defaultCircle: circle });
    try {
      const first = await core.store("Quartz alpha record.", { circle, sourceRefs: ["/repo/repair.ts"], resolution: "forceNew" });
      const connector = await core.storeSource("Legacy connector membership.", {
        circle, sourceRefs: ["source://legacy/README.md#repair~1"], resolution: "forceNew",
      });
      let db = rawDb(core);
      const entityKey = "ref:/repo/repair.ts";
      db.prepare(`INSERT INTO concept_entities (concept_id,entity_key,scope) VALUES (?,?,?)`).run(connector.conceptId, entityKey, circle);
      db.prepare(`UPDATE entities SET df=100 WHERE key=? AND scope=?`).run(entityKey, circle);
      const second = await core.store("Zephyr beta record.", { circle, sourceRefs: ["/repo/repair.ts"], resolution: "forceNew" });
      expect(core.edges({ circle, type: "about" }).some((edge) =>
        (edge.srcId === first.conceptId && edge.dstId === second.conceptId)
        || (edge.srcId === second.conceptId && edge.dstId === first.conceptId))).toBe(false);

      core.close();
      core = new MonetCore(dbPath, { defaultCircle: circle });
      db = rawDb(core);
      expect(core.edges({ circle, type: "about" })).toEqual(expect.arrayContaining([
        expect.objectContaining({ srcId: first.conceptId, dstId: second.conceptId }),
        expect.objectContaining({ srcId: second.conceptId, dstId: first.conceptId }),
      ]));
      expect(db.prepare(`SELECT df FROM entities WHERE key=? AND scope=?`).get(entityKey, circle)).toEqual({ df: 2 });
      const repairedCounts = core.edges({ circle, type: "about" }).map((edge) => ({ srcId: edge.srcId, dstId: edge.dstId, count: edge.count }));
      core.close();
      core = new MonetCore(dbPath, { defaultCircle: circle });
      expect(core.edges({ circle, type: "about" }).map((edge) => ({ srcId: edge.srcId, dstId: edge.dstId, count: edge.count }))).toEqual(repairedCounts);
    } finally {
      try { core.close(); } catch { /* already closed */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FILE=CONCEPT (Phase 1): under the old single-observation model, "predecessor visible" was a
  // CAS/disjunction proof (Case A/B in queryAuthorizedSourcePublications) because the concept's
  // body WAS updated pre-publish and something had to keep serving the old one until publication
  // caught up. That entire class of leak is gone by construction now: recomputeSourceConceptBody
  // (item 4) is the ONLY thing that ever touches a source concept's title/body/embedding, and it
  // runs strictly post-publish — so an engine-written-and-activated-but-not-yet-published
  // successor observation simply never reaches the concept row, crash or no crash. This test now
  // documents that simpler guarantee directly, plus the still-real reconcile-orphan cleanup an
  // abort produces for the orphaned observation pair.
  it("never lets a pre-publish successor reach the concept row, crash or no crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "monet-source-retrieval-refresh-"));
    const dbPath = join(root, "monet.db");
    let core = new MonetCore(dbPath, { defaultCircle: circle });
    try {
      core.createSource(sourceInput());
      const initial = await publish(core);
      const replacement = core.beginSourceRun({ sourceId: "source-a", snapshotId: "replacement" });
      if (replacement.kind !== "started") throw new Error("expected replacement run");
      const staged = oneChunkManifest(replacement.run, "STAGED successor must remain invisible.", 2);
      core.stageSourceManifest(staged);
      const successor = await core.storeSource(staged.chunks[0].content, {
        circle, sourceRefs: [staged.chunks[0].sourceRef], operationId: staged.chunks[0].operationId,
        attachTo: initial.stored.conceptId,
      });
      core.recordSourceBindingReceipt({
        runId: replacement.run.id, bindingId: "binding-1", conceptId: successor.conceptId,
        observationId: successor.observationId, predecessorObservationId: initial.stored.observationId,
        writeState: "engine-written",
      });
      await core.supersedeSourceChunkObservation(successor.conceptId, successor.observationId, initial.stored.observationId);

      const assertPublishedPredecessor = async (candidate: MonetCore) => {
        const fetched = await candidate.getConcept(initial.stored.conceptId, { sourceAuthorizationContext: auth, includeBody: true });
        // File=concept (Phase 1), item 1: title is frontmatter title else filename-basename now
        // (deriveSourceFileTitle) — never firstLine(chunk content), which was the old
        // single-observation model's only option. oneChunkManifest's file entry has no
        // frontmatter title, so it falls back to "README" (README.md minus extension).
        expect(fetched).toMatchObject({
          body: content, title: "README", slug: "readme",
          outline: [{ observationId: initial.stored.observationId }],
        });
        expect(JSON.stringify(await candidate.search("STAGED successor", { circle, sourceAuthorizationContext: auth }))).not.toContain("STAGED");
        expect((await candidate.gather("cobalt walruses", { circle, sourceAuthorizationContext: auth })).ranked)
          .toContainEqual(expect.objectContaining({ id: initial.stored.conceptId, sourceRefsCount: 1 }));
      };
      await assertPublishedPredecessor(core);
      expect(core.abortSourceRun(replacement.run.id, "failed", "test crash before rollback").state).toBe("aborted");
      expect(core.listSourceCleanupItems(replacement.run.id)).toContainEqual(expect.objectContaining({
        kind: "reconcile-orphan", conceptId: initial.stored.conceptId,
        observationId: successor.observationId, predecessorObservationId: initial.stored.observationId,
        acknowledgedAt: null,
      }));
      await assertPublishedPredecessor(core);
      core.close();
      core = new MonetCore(dbPath, { defaultCircle: circle });
      await assertPublishedPredecessor(core);
    } finally {
      try { core.close(); } catch { /* already closed */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats every connector ownership marker as source-owned and fail-closed", async () => {
    const core = makeCore();
    const byIdentity = await core.store("corrupt identity marker", { circle, resolution: "forceNew" });
    const byPointer = await core.store("corrupt active pointer marker", { circle, resolution: "forceNew" });
    const byKind = await core.store("corrupt source kind marker", { circle, resolution: "forceNew" });
    const db = rawDb(core);
    db.prepare(`UPDATE concepts SET source_identity='source://ghost' WHERE id=?`).run(byIdentity.conceptId);
    db.prepare(`UPDATE concepts SET active_observation_id=? WHERE id=?`).run(byPointer.observationId, byPointer.conceptId);
    db.prepare(`UPDATE concepts SET kind='source' WHERE id=?`).run(byKind.conceptId);
    const hidden = [byIdentity.conceptId, byPointer.conceptId, byKind.conceptId];
    for (const sourceAuthorizationContext of [undefined, auth, wrongCaller]) {
      const surfacedIds = [
        ...(await core.search("corrupt", { circle, sourceAuthorizationContext })).map((row) => row.id),
        ...core.listMemories(circle, { sourceAuthorizationContext }).map((row) => row.id),
        ...(await core.gather("corrupt", { circle, sourceAuthorizationContext })).ranked.map((row) => row.id),
        ...core.overview(circle, { sourceAuthorizationContext }).livingModel.map((row) => row.id),
      ];
      for (const id of hidden) expect(surfacedIds).not.toContain(id);
      expect(core.conceptCount(circle, sourceAuthorizationContext)).toBe(0);
      expect(core.listCircles(undefined, { sourceAuthorizationContext })).toEqual([]);
      expect(core.overview(circle, { sourceAuthorizationContext }).counts).toMatchObject({ concepts: 0, observations: 0 });
      for (const id of hidden) {
        expect(core.circleOf(id, sourceAuthorizationContext)).toBeNull();
        expect(await core.getConcept(id, { sourceAuthorizationContext })).toBeNull();
      }
    }
    await expect(core.store("native attach", { circle, attachTo: byIdentity.conceptId })).rejects.toThrow(/source concept/);
    await expect(core.store("native attach", { circle, attachTo: byPointer.conceptId })).rejects.toThrow(/source concept/);
  });

  it("keeps a connector-marked workstream invisible and refuses to overwrite it", async () => {
    const core = makeCore();
    const workstream = await core.saveWorkstream({ status: "active", nextSteps: ["secret connector task"] }, { circle });
    const db = rawDb(core);
    db.prepare(`UPDATE concepts SET source_identity='source://ghost' WHERE id=?`).run(workstream.id);
    const before = db.prepare(`SELECT body,version FROM concepts WHERE id=?`).get(workstream.id);

    expect(core.getActiveWorkstreams(circle)).toEqual([]);
    expect(core.stats(circle).workstreams).toBe(0);
    expect(core.stats().workstreams).toBe(0);
    expect(core.overview(circle).counts.workstreams).toBe(0);
    await expect(core.saveWorkstream({ status: "active", nextSteps: ["overwrite attempt"] }, { circle }))
      .rejects.toThrow(/connector-owned workstream/);
    expect(db.prepare(`SELECT body,version FROM concepts WHERE id=?`).get(workstream.id)).toEqual(before);

    const server = new McpServer({ name: "workstream-marker-test", version: "1" });
    registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "workstream-marker-client", version: "1" });
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const list = await client.callTool({ name: "memory_workstreams", arguments: { circle } }) as { content: Array<{ type: string; text: string }> };
      expect(JSON.parse(list.content[0].text)).toEqual({ workstreams: [] });
      expect(list.content.map((item) => item.text).join("\n")).not.toContain("secret connector task");
    } finally {
      await client.close(); await server.close();
    }
  });

  it("excludes sessions owned by every connector marker combination from store-wide stats", async () => {
    const core = makeCore();
    const db = rawDb(core);
    const byIdentity = await core.store("identity session", { circle, resolution: "forceNew" });
    core.endSessionForEval();
    db.prepare(`UPDATE concepts SET source_identity='source://ghost' WHERE id=?`).run(byIdentity.conceptId);
    const byPointer = await core.store("pointer session", { circle, resolution: "forceNew" });
    core.endSessionForEval();
    db.prepare(`UPDATE concepts SET active_observation_id=? WHERE id=?`).run(byPointer.observationId, byPointer.conceptId);
    const byKind = await core.store("kind session", { circle, resolution: "forceNew" });
    core.endSessionForEval();
    db.prepare(`UPDATE concepts SET kind='source' WHERE id=?`).run(byKind.conceptId);
    expect(core.stats().sessions).toBe(0);
  });

  it("fails closed on malformed live source vectors while diagnostics and structural filtering remain available", async () => {
    const core = makeCore();
    const native = await core.store("native retrieval remains available", { circle, resolution: "forceNew" });
    core.createSource(sourceInput());
    const { stored } = await publish(core);
    const db = rawDb(core);
    const originalObservationEmbedding = (db.prepare(`SELECT embedding FROM observations WHERE id=?`).get(stored.observationId) as { embedding: string }).embedding;
    db.prepare(`UPDATE observations SET embedding=? WHERE id=?`).run("not-json", stored.observationId);
    expect(await core.getConcept(stored.conceptId, { sourceAuthorizationContext: auth })).not.toBeNull();
    expect(core.inspectEmbeddingWidths().malformed.sourceObservations).toMatchObject({ count: 1 });
    await expect(core.search("native retrieval", { circle, sourceAuthorizationContext: auth })).rejects.toBeInstanceOf(MalformedEmbeddingStoreError);
    db.prepare(`UPDATE observations SET embedding=? WHERE id=?`).run(originalObservationEmbedding, stored.observationId);

    const original = (db.prepare(`SELECT embedding FROM concepts WHERE id=?`).get(stored.conceptId) as { embedding: string }).embedding;
    const invalid = [
      "not-json",
      JSON.stringify([0]),
      JSON.stringify(Array.from({ length: 256 }, () => "x")),
      `[1e999,${Array.from({ length: 255 }, () => "0").join(",")}]`,
    ];
    for (const embedding of invalid) {
      db.prepare(`UPDATE concepts SET embedding=? WHERE id=?`).run(embedding, stored.conceptId);
      const isZeroPlaceholder = embedding === JSON.stringify([0]);
      if (isZeroPlaceholder) {
        expect((await core.search("native retrieval", { circle, sourceAuthorizationContext: auth })).map((row) => row.id)).toContain(native.conceptId);
      } else {
        await expect(core.search("native retrieval", { circle, sourceAuthorizationContext: auth })).rejects.toBeInstanceOf(MalformedEmbeddingStoreError);
      }
      expect(await core.getConcept(stored.conceptId, { sourceAuthorizationContext: auth })).toBeNull();
      expect(core.listMemories(circle, { sourceAuthorizationContext: auth }).map((row) => row.id)).not.toContain(stored.conceptId);
      if (isZeroPlaceholder) {
        expect((await core.gather("cobalt", { circle, sourceAuthorizationContext: auth })).ranked.map((row) => row.id)).not.toContain(stored.conceptId);
      } else {
        await expect(core.gather("cobalt", { circle, sourceAuthorizationContext: auth })).rejects.toBeInstanceOf(MalformedEmbeddingStoreError);
      }
      expect(core.overview(circle, { sourceAuthorizationContext: auth }).livingModel.map((row) => row.id)).not.toContain(stored.conceptId);
      expect(core.conceptCount(circle, auth)).toBe(1);
      expect(core.listCircles(undefined, { sourceAuthorizationContext: auth })).toContainEqual(expect.objectContaining({ circle, concepts: 1 }));
    }
    db.prepare(`UPDATE concepts SET embedding=? WHERE id=?`).run(original, stored.conceptId);
    expect(await core.getConcept(stored.conceptId, { sourceAuthorizationContext: auth })).not.toBeNull();
    expect((await core.search("native retrieval", { circle, sourceAuthorizationContext: auth })).map((row) => row.id)).toContain(native.conceptId);
  });

  it("keeps native gather scores/order stable while a stronger source displaces the weak tail", async () => {
    const calibratedEmbedder: EmbeddingProvider = {
      dim: 2,
      modelId: "gather-merge:2",
      embed: (text) => {
        if (text === "priority needle" || text.includes("published exact source")) return new Float32Array([1, 0]);
        if (text.includes("native head")) return new Float32Array([0.9, 0.1]);
        return new Float32Array([0.2, 1]);
      },
    };
    const core = new MonetCore(":memory:", { defaultCircle: circle, embedder: calibratedEmbedder });
    cores.push(core);
    await core.store("priority needle native head", { circle, resolution: "forceNew" });
    core.endSessionForEval();
    for (let index = 0; index < 4; index++) {
      await core.store(`priority needle weak native tail ${index}`, { circle, resolution: "forceNew" });
      core.endSessionForEval();
    }
    core.createSource(sourceInput());
    const { stored } = await publish(core, "source-a", "priority needle published exact source");
    const realNow = Date.now;
    const fixedNow = realNow();
    let nativeLimited; let authorizedLimited; let nativeWide; let authorizedWide;
    try {
      Date.now = () => fixedNow;
      nativeLimited = await core.gather("priority needle", { circle, limit: 3 });
      authorizedLimited = await core.gather("priority needle", { circle, limit: 3, sourceAuthorizationContext: auth });
      nativeWide = await core.gather("priority needle", { circle, limit: 20 });
      authorizedWide = await core.gather("priority needle", { circle, limit: 20, sourceAuthorizationContext: auth });
    } finally { Date.now = realNow; }
    expect(authorizedWide.ranked.filter((row) => row.kind !== "source")).toEqual(nativeWide.ranked);
    expect(authorizedLimited.ranked.map((row) => row.id)).toContain(stored.conceptId);
    expect(authorizedLimited.ranked.filter((row) => row.kind !== "source")).toEqual(nativeLimited.ranked.slice(0, 2));
    const sourceCard = authorizedWide.ranked.find((row) => row.id === stored.conceptId);
    expect(sourceCard).toMatchObject({ viaSeed: true, score: 1 });
  });

  it("returns exact top-20 mixed circle aggregates when source activity promotes a native tail circle", async () => {
    const core = makeCore();
    const db = rawDb(core);
    const mixedCircles = Array.from({ length: 21 }, (_, index) => `mixed-${String(index).padStart(2, "0")}`);
    for (let index = 0; index < mixedCircles.length; index++) {
      const stored = await core.store(`native circle ${index}`, { circle: mixedCircles[index], resolution: "forceNew" });
      db.prepare(`UPDATE concepts SET updated_at=?,last_confirmed_at=? WHERE id=?`).run(index + 1, index + 1, stored.conceptId);
    }
    core.createSource(sourceInput("mixed-source", { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] }, mixedCircles[0]));
    const sourcePublication = await publish(core, "mixed-source", "recent authorized source publication", mixedCircles[0]);
    const promotedAt = Date.now() + 100_000;
    db.prepare(`UPDATE source_sync_runs SET published_at=? WHERE id=?`).run(promotedAt, sourcePublication.run.id);
    db.prepare(`UPDATE source_snapshots SET published_at=? WHERE run_id=?`).run(promotedAt, sourcePublication.run.id);

    const nativeOnly = core.listCircles();
    expect(nativeOnly).toHaveLength(20);
    expect(nativeOnly.map((entry) => entry.circle)).not.toContain(mixedCircles[0]);
    const authorized = core.listCircles(undefined, { sourceAuthorizationContext: auth });
    expect(authorized).toHaveLength(20);
    expect(authorized[0]).toMatchObject({ circle: mixedCircles[0], concepts: 2 });
  });

  // FILE=CONCEPT (Phase 1): the old mechanism this test named — read-time ordering sourced from
  // run.published_at, overriding the concept's own (frozen-at-creation) updated_at — no longer
  // exists. authorizedSourceProjections now projects the concept row directly (item 3c), and
  // recomputeSourceConceptBody (item 4) is what stamps updated_at/last_confirmed_at, exactly
  // once, strictly post-publish. The property worth protecting is the SAME one this test always
  // protected, just via the new mechanism: a pre-publish write (staged, engine-written, even
  // supersedeSourceChunkObservation-activated) must never move a source concept's read-visible
  // timestamp or listMemories position — only a completed recompute may.
  it("orders and ages source projections by their own recompute time, never a pending pre-publish write", async () => {
    // A store-wide sync-revision trigger (engine.ts's `sync_${table}_update`, pre-existing and
    // unrelated to file=concept) stamps updated_at from a monotonic mutation clock on every local
    // UPDATE to `concepts` — a raw backdating UPDATE gets silently overwritten right back by it.
    // So instead of forcing arbitrary timestamps, this drives ordering from real write sequence
    // (native first, source second — later writes get later clock stamps) and asserts monotonic
    // advancement by comparing actual returned values across steps, never a forced absolute one.
    const core = new MonetCore(":memory:", { defaultCircle: circle, staleAfterMs: -1 });
    cores.push(core);
    const native = await core.store("native ordering sentinel", { circle, resolution: "forceNew" });
    core.createSource(sourceInput());
    const initial = await publish(core);

    const initialList = core.listMemories(circle, { sourceAuthorizationContext: auth });
    // Written after native, so it recomputed (and was stamped) later — sorts first.
    expect(initialList.map((entry) => entry.id).slice(0, 2)).toEqual([initial.stored.conceptId, native.conceptId]);
    const initialEntry = initialList.find((entry) => entry.id === initial.stored.conceptId)!;
    const initialUpdatedAt = initialEntry.updatedAt;
    const initialLastConfirmedAt = initialEntry.lastConfirmedAt!;
    expect(initialLastConfirmedAt).toBeGreaterThan(0);

    const replacement = core.beginSourceRun({ sourceId: "source-a", snapshotId: "timestamp-replacement" });
    if (replacement.kind !== "started") throw new Error("expected replacement run");
    const manifest = oneChunkManifest(replacement.run, "newly published timestamp body", 2);
    core.stageSourceManifest(manifest);
    const successor = await core.storeSource(manifest.chunks[0].content, {
      circle, sourceRefs: [manifest.chunks[0].sourceRef], operationId: manifest.chunks[0].operationId,
      attachTo: initial.stored.conceptId,
    });
    const receipt = {
      runId: replacement.run.id, bindingId: "binding-1", conceptId: successor.conceptId,
      observationId: successor.observationId, predecessorObservationId: initial.stored.observationId,
    };
    core.recordSourceBindingReceipt({ ...receipt, writeState: "engine-written" });
    await core.supersedeSourceChunkObservation(successor.conceptId, successor.observationId, initial.stored.observationId);
    // Pre-publish: the observation pair flipped, but the concept row's CONTENT (title/body/
    // embedding) is untouched until recomputeSourceConceptBody, which only runs post-publish — the
    // one thing this asserts is still the newly-staged content NOT reaching a reader early. (Its
    // updated_at may tick forward slightly from storeSourceChunk's own support_count bump on
    // attach — a benign "something is being synced" freshness signal, not a content leak — so
    // this deliberately does not also assert updatedAt is byte-for-byte unchanged.)
    const pendingList = core.listMemories(circle, { sourceAuthorizationContext: auth });
    expect(pendingList.map((entry) => entry.id).slice(0, 2)).toEqual([initial.stored.conceptId, native.conceptId]);
    expect(pendingList.find((entry) => entry.id === initial.stored.conceptId)?.updatedAt).toBeGreaterThanOrEqual(initialUpdatedAt);
    await expect(core.getConcept(initial.stored.conceptId, { sourceAuthorizationContext: auth, includeBody: true }))
      .resolves.toMatchObject({ body: content });

    core.recordSourceBindingReceipt({ ...receipt, writeState: "committed" });
    core.publishSourceRun({
      runId: replacement.run.id, activationToken: core.beginSourceActivation(replacement.run.id),
      expectedManifestHash: manifest.manifestHash,
    });
    await core.recomputeSourceConceptBody(successor.conceptId);
    const publishedList = core.listMemories(circle, { sourceAuthorizationContext: auth });
    expect(publishedList[0].id).toBe(initial.stored.conceptId);
    // Recompute is a real mutation: the sync clock strictly advances past its own pre-publish
    // value. updatedAt (store-wide sync-revision trigger, engine.ts) and lastConfirmedAt
    // (recomputeSourceConceptBody's own explicit wall-clock stamp) are deliberately two different
    // monotonic clocks that can interleave within the same wall-clock millisecond under a tight
    // in-memory test — so each is only compared against an earlier reading of ITSELF, never
    // cross-clock against the other.
    expect(publishedList[0].updatedAt).toBeGreaterThan(initialUpdatedAt);
    const refetched = await core.getConcept(initial.stored.conceptId, { sourceAuthorizationContext: auth, includeBody: true });
    expect(refetched).toMatchObject({ body: manifest.chunks[0].content });
    expect(refetched!.lastConfirmedAt).toBeGreaterThan(initialLastConfirmedAt);
    // Source projections are authorized read views; overview's exact stale count remains the owner
    // of their stale classification after resident prewarm stopped carrying stale cards.
    expect(core.overview(circle, { sourceAuthorizationContext: auth }).counts.stale).toBe(2);
  });

  it("counts observations only for the retained stale-source page", async () => {
    const core = makeCore();
    const sourceCount = 205;
    for (let index = 0; index < sourceCount; index++) {
      const sourceId = `stale-source-${index}`;
      core.createSource(sourceInput(sourceId));
      await publish(core, sourceId, `stale source content ${index}`);
    }
    rawDb(core).prepare(`UPDATE concepts SET last_confirmed_at=1 WHERE circle=?`).run(circle);

    let countCalls = 0;
    const cards = core.listStale(circle, 20, auth, (conceptId) => {
      countCalls++;
      return core.countObservationsForConcept(conceptId);
    });
    expect(cards).toHaveLength(20);
    expect(cards.map((card) => card.id)).toEqual([...cards.map((card) => card.id)].sort());
    expect(countCalls).toBeLessThanOrEqual(20);
  }, 30_000);

  it("reports exact stale counts and paginates mixed native/source rows", async () => {
    const core = makeCore();
    for (let index = 0; index < 25; index++) {
      await core.store(`stale native ${index}`, { circle, resolution: "forceNew" });
    }
    core.createSource(sourceInput());
    await publish(core);
    // File=concept (Phase 1): last_confirmed_at is the concept row's own, directly-stamped value
    // now (recomputeSourceConceptBody sets it at recompute time — no more read-time override
    // sourced from run.published_at), so this raw UPDATE affects the published source concept
    // too, same as any native one — 26 stale (25 native + the 1 source), not 25.
    rawDb(core).prepare(`UPDATE concepts SET last_confirmed_at=1 WHERE circle=?`).run(circle);
    expect(core.overview(circle, { sourceAuthorizationContext: auth }).livingModel).toHaveLength(0);
    expect(core.overview(circle, { sourceAuthorizationContext: auth }).counts.stale).toBe(26);

    const seen = new Set<string>();
    let cursor: { updatedAt: number; id: string } | undefined;
    do {
      const page = core.listMemories(circle, { sourceAuthorizationContext: auth, limit: 1, cursor });
      if (page.length === 0) break;
      expect(seen.has(page[0].id)).toBe(false);
      seen.add(page[0].id);
      cursor = { updatedAt: page[0].updatedAt, id: page[0].id };
    } while (true);
    expect(seen.size).toBe(26);
    expect(core.conceptCount(circle, auth)).toBe(26);
  });

  it("threads only the registration-bound identity through MCP reads while orientation stays source-independent", async () => {
    const core = makeCore();
    core.createSource(sourceInput());
    const { stored } = await publish(core);
    const server = new McpServer({ name: "source-retrieval-test", version: "1" });
    registerMonetCoreTools(server, core, { sourceAuthorizationContext: auth, autoPrewarm: true, checkpointNudge: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "source-retrieval-test-client", version: "1" });
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const search = await client.callTool({ name: "memory_search", arguments: { query: "cobalt", circle } }) as { content: Array<{ type: string; text: string }> };
      expect(JSON.parse(search.content[0].text)).toMatchObject({ results: [expect.objectContaining({ id: stored.conceptId })] });
      // File=concept (Phase 1), item 1: title is frontmatter title else filename-basename now
      // (never firstLine(chunk content)) — oneChunkManifest's file entry has no frontmatter
      // title, so README.md falls back to "README".
      expect(search.content.slice(1).map((item) => item.text).join("\n")).not.toContain("README");
      const listed = await client.callTool({ name: "memory_list", arguments: { circle } }) as { content: Array<{ type: string; text: string }> };
      expect(JSON.parse(listed.content[0].text)).toMatchObject({ total: 1, memories: [expect.objectContaining({ id: stored.conceptId })] });
      // Ruling 9: source concepts return structure (outline), not observations, by default.
      const fetched = await client.callTool({ name: "memory_fetch", arguments: { id: stored.conceptId, circle } }) as { content: Array<{ type: string; text: string }> };
      expect(JSON.parse(fetched.content[0].text)).toMatchObject({
        id: stored.conceptId, title: "README", outline: [expect.objectContaining({ observationId: stored.observationId })],
        totalObservations: 1, supportCount: 1, confidence: expect.any(Number), version: expect.any(Number),
        bodyOmitted: true,
      });
      expect(JSON.parse(fetched.content[0].text)).not.toHaveProperty("needsSynthesis");
      const gathered = await client.callTool({ name: "memory_gather", arguments: { intent: "cobalt", circle } }) as { content: Array<{ type: string; text: string }> };
      expect(JSON.parse(gathered.content[0].text).ranked).toContainEqual(expect.objectContaining({ id: stored.conceptId }));
      const instrumented = core as unknown as { authorizedSourceProjections: (...args: unknown[]) => unknown[] };
      const originalProjection = instrumented.authorizedSourceProjections.bind(core);
      let projectionScans = 0;
      instrumented.authorizedSourceProjections = (...args: unknown[]) => {
        projectionScans++;
        return originalProjection(...args);
      };
      const context = await client.callTool({ name: "agent_context", arguments: { circle } }) as { content: Array<{ type: string; text: string }> };
      expect(JSON.parse(context.content[0].text)).toEqual({ circle });
      expect(projectionScans).toBe(0);
    } finally {
      await client.close(); await server.close();
    }
  });

  it("uses only registration-bound authorization for MCP circle listing", async () => {
    const core = makeCore();
    core.createSource(sourceInput());
    await publish(core);
    for (const [registrationContext, visible] of [[auth, true], [wrongCaller, false], [undefined, false]] as const) {
      const server = new McpServer({ name: `circle-list-${String(visible)}`, version: "1" });
      registerMonetCoreTools(server, core, {
        autoPrewarm: false, checkpointNudge: false,
        ...(registrationContext ? { sourceAuthorizationContext: registrationContext } : {}),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "circle-list-client", version: "1" });
      await server.connect(serverTransport); await client.connect(clientTransport);
      try {
        const response = await client.callTool({ name: "memory_circle_manage", arguments: { action: "list" } }) as { content: Array<{ type: string; text: string }> };
        const circles = (JSON.parse(response.content[0].text) as { circles: Array<{ circle: string; concepts: number }> }).circles;
        if (visible) expect(circles).toContainEqual(expect.objectContaining({ circle, concepts: 1 }));
        else expect(circles.map((entry) => entry.circle)).not.toContain(circle);
      } finally {
        await client.close(); await server.close();
      }
    }
  });

  it("fits a large outline under the tool-result ceiling by serialized size, never just a raw entry count (review fix, MINOR)", async () => {
    // headingPath is document content with no length ceiling — a count cap alone
    // (FETCH_OUTLINE_MAX_ENTRIES, mcp-server.ts) is not provably safe against a file with many
    // moderately-long headings: 250 sections here, each with a realistic ~90-char heading, whose
    // full outline would serialize to comfortably over the 40 000-char RESULT_MAX_CHARS ceiling.
    const core = makeCore();
    core.createSource(sourceInput());
    const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-outline-fit" });
    if (begun.kind !== "started") throw new Error("expected started run");
    const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
    const sectionCount = 250;
    const chunks = Array.from({ length: sectionCount }, (_, i) => {
      const heading = `Section number ${i} with realistic padding text to make this heading a plausible real-world length`;
      const text = `body text for section ${i}`;
      const contentHash = computeSourceContentHash(Buffer.from(text, "utf8"));
      const ingestFingerprint = computeSourceIngestFingerprint({
        contentHash, headingPath: [heading], metadata, ingestConfigHash: begun.run.ingestConfigHash,
      });
      return {
        bindingId: `binding-${i}`, bindingGeneration: 1,
        operationId: computeSourceOperationId(begun.run.sourceId, `binding-${i}`, ingestFingerprint, begun.run.snapshotId, 1),
        relativePath: "BIG.md", headingPath: [heading], occurrence: 1, segmentIndex: 1, documentSequence: i + 1,
        contentHash, ingestFingerprint, metadata,
        sourceRef: `source://source-a/BIG.md#${encodeURIComponent(heading.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}~1`,
        content: text,
      };
    });
    const files = [{ relativePath: "BIG.md", type: "file" as const, contentHash: "big-file-hash", byteLength: 10_000, title: "BIG" }];
    core.stageSourceManifest({
      runId: begun.run.id, scanStatus: "complete", manifestHash: computeSourceManifestHash(files), files, chunks,
    });
    let conceptId: string | undefined;
    for (const chunk of chunks) {
      const stored = await core.storeSource(chunk.content, {
        circle, sourceRefs: [chunk.sourceRef], operationId: chunk.operationId,
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

    const server = new McpServer({ name: "outline-fit-test", version: "1" });
    registerMonetCoreTools(server, core, { sourceAuthorizationContext: auth, autoPrewarm: false, checkpointNudge: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "outline-fit-test-client", version: "1" });
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const fetched = await client.callTool({ name: "memory_fetch", arguments: { id: conceptId, circle } }) as { content: Array<{ type: string; text: string }> };
      const rawText = fetched.content[0].text;
      // The real guarantee: never truncated mid-JSON by ok()'s own last-resort ceiling. A count-
      // cap-only bug here would either overflow into ok()'s raw truncation (leaving unparseable
      // JSON) or, if the cap were lowered blindly, undershoot; this proves neither happened by
      // actually parsing the response.
      const parsed = JSON.parse(rawText) as { outline: unknown[]; totalObservations: number; outlineNote?: string };
      expect(rawText.length).toBeLessThan(40_000);
      expect(parsed.totalObservations).toBe(sectionCount);
      expect(parsed.outline.length).toBeGreaterThan(0);
      expect(parsed.outline.length).toBeLessThan(sectionCount); // did not fit all 250 — this is the case that matters
      expect(parsed.outlineNote).toBe(`Showing the first ${parsed.outline.length} of ${sectionCount} sections.`);
    } finally {
      await client.close(); await server.close();
    }
  });

  it("drops a pathologically oversized outline entry instead of emitting it and truncating (round 4, Codex thread 10)", async () => {
    // The exact bug: the old fit loop's pre-push size check was gated on fitOutline.length > 0, so
    // the FIRST entry was always pushed unconditionally before the budget was ever checked against
    // it. A single heading path long enough to blow the whole 40 000-char budget BY ITSELF still
    // landed in fitOutline, and the response fell through to ok()'s last-resort truncation —
    // invalid, unparseable JSON — instead of a valid, empty outline with an explanatory note.
    const core = makeCore();
    core.createSource(sourceInput());
    const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-oversized-entry" });
    if (begun.kind !== "started") throw new Error("expected started run");
    const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
    // One heading path alone, well past 40 000 chars once serialized alongside the fixed fields.
    const hugeHeading = "Section heading padding text ".repeat(2000);
    const text = "body for the one oversized heading";
    const contentHash = computeSourceContentHash(Buffer.from(text, "utf8"));
    const ingestFingerprint = computeSourceIngestFingerprint({
      contentHash, headingPath: [hugeHeading], metadata, ingestConfigHash: begun.run.ingestConfigHash,
    });
    const chunk = {
      bindingId: "binding-0", bindingGeneration: 1,
      operationId: computeSourceOperationId(begun.run.sourceId, "binding-0", ingestFingerprint, begun.run.snapshotId, 1),
      relativePath: "HUGE.md", headingPath: [hugeHeading], occurrence: 1, segmentIndex: 1, documentSequence: 1,
      contentHash, ingestFingerprint, metadata,
      sourceRef: `source://source-a/HUGE.md#${encodeURIComponent(sourceHeadingAnchor([hugeHeading]))}~1`, content: text,
    };
    const files = [{ relativePath: "HUGE.md", type: "file" as const, contentHash: "huge-file-hash", byteLength: 100, title: "HUGE" }];
    core.stageSourceManifest({
      runId: begun.run.id, scanStatus: "complete", manifestHash: computeSourceManifestHash(files), files, chunks: [chunk],
    });
    const stored = await core.storeSource(chunk.content, {
      circle, sourceRefs: [chunk.sourceRef], operationId: chunk.operationId, resolution: "forceNew",
    });
    core.recordSourceBindingReceipt({
      runId: begun.run.id, bindingId: chunk.bindingId, conceptId: stored.conceptId, observationId: stored.observationId,
      predecessorObservationId: null, writeState: "committed",
    });
    core.publishSourceRun({ runId: begun.run.id, activationToken: core.beginSourceActivation(begun.run.id) });
    await core.recomputeSourceConceptBody(stored.conceptId);

    const server = new McpServer({ name: "outline-oversized-entry-test", version: "1" });
    registerMonetCoreTools(server, core, { sourceAuthorizationContext: auth, autoPrewarm: false, checkpointNudge: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "outline-oversized-entry-test-client", version: "1" });
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const fetched = await client.callTool({ name: "memory_fetch", arguments: { id: stored.conceptId, circle } }) as { content: Array<{ type: string; text: string }> };
      const rawText = fetched.content[0].text;
      // The real guarantee: this parses at all. A pre-fix response would truncate mid-JSON here.
      const parsed = JSON.parse(rawText) as { outline: unknown[]; totalObservations: number; outlineNote?: string };
      expect(rawText.length).toBeLessThan(40_000);
      expect(parsed.totalObservations).toBe(1);
      expect(parsed.outline).toEqual([]); // the one oversized entry was dropped, not truncated in place
      expect(parsed.outlineNote).toContain("could not be included");
    } finally {
      await client.close(); await server.close();
    }
  });

  it("preserves distinct segmentIndex values for a split section's outline entries (round 5, Codex thread R5-5)", async () => {
    // Engine returns segmentIndex on SourceOutlineEntry (a section too large for maxChunkBytes
    // splits into multiple chunker segments, same shape as round 4's thread 9/round 5's R5-3) —
    // the MCP fit loop's fitted candidate entries dropped it, making split segments of ONE section
    // indistinguishable from each other in memory_fetch's own outline output.
    const core = makeCore();
    core.createSource(sourceInput());
    const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-segment-index" });
    if (begun.kind !== "started") throw new Error("expected started run");
    const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
    const buildChunk = (segmentIndex: number, documentSequence: number, content: string) => {
      const contentHash = computeSourceContentHash(Buffer.from(content, "utf8"));
      const ingestFingerprint = computeSourceIngestFingerprint({
        contentHash, headingPath: ["Big"], metadata, ingestConfigHash: begun.run.ingestConfigHash,
      });
      return {
        bindingId: `binding-${segmentIndex}`, bindingGeneration: 1,
        operationId: computeSourceOperationId(begun.run.sourceId, `binding-${segmentIndex}`, ingestFingerprint, begun.run.snapshotId, 1),
        relativePath: "BIG.md", headingPath: ["Big"], occurrence: 1, segmentIndex, documentSequence,
        contentHash, ingestFingerprint, metadata,
        sourceRef: `source://source-a/BIG.md#big~1`, content,
      };
    };
    const chunks = [buildChunk(1, 1, "first half of an oversized section"), buildChunk(2, 2, "second half of an oversized section")];
    const files = [{ relativePath: "BIG.md", type: "file" as const, contentHash: "big-file-hash", byteLength: 1000, title: "BIG" }];
    core.stageSourceManifest({
      runId: begun.run.id, scanStatus: "complete", manifestHash: computeSourceManifestHash(files), files, chunks,
    });
    let conceptId: string | undefined;
    for (const chunk of chunks) {
      const stored = await core.storeSource(chunk.content, {
        circle, sourceRefs: [chunk.sourceRef], operationId: chunk.operationId,
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

    const server = new McpServer({ name: "outline-segment-index-test", version: "1" });
    registerMonetCoreTools(server, core, { sourceAuthorizationContext: auth, autoPrewarm: false, checkpointNudge: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "outline-segment-index-test-client", version: "1" });
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const fetched = await client.callTool({ name: "memory_fetch", arguments: { id: conceptId, circle } }) as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(fetched.content[0].text) as { outline: Array<{ headingPath: string[]; occurrence: number; segmentIndex: number; observationId: string }> };
      expect(parsed.outline).toHaveLength(2);
      const segmentIndices = parsed.outline.map((entry) => entry.segmentIndex).sort();
      expect(segmentIndices).toEqual([1, 2]); // pre-fix: both entries had segmentIndex undefined
    } finally {
      await client.close(); await server.close();
    }
  });

  it("reports a source gather card's ref COUNT and never the refs themselves (supersedes the round-4 cap)", async () => {
    // recomputeSourceConceptBody stores one source_refs entry per active chunk — hundreds for a
    // large file — and gather()'s cards used to include that array verbatim. A gather response
    // with even a couple of such cards can exceed RESULT_MAX_CHARS and get truncated mid-JSON by
    // ok(), same failure shape as the outline bug above. Round 4 (Codex thread 13) capped the array
    // at the first 20; the payload-noise pass found the capped 20 were not consumed either, so the
    // card now carries only the count.
    const core = makeCore();
    core.createSource(sourceInput());
    const begun = core.beginSourceRun({ sourceId: "source-a", snapshotId: "snap-refs-cap" });
    if (begun.kind !== "started") throw new Error("expected started run");
    const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
    const sectionCount = 40; // comfortably more than the old 20-entry card cap
    const chunks = Array.from({ length: sectionCount }, (_, i) => {
      const heading = `Section ${i}`;
      const text = `evidence about cobalt walruses, section ${i}`;
      const contentHash = computeSourceContentHash(Buffer.from(text, "utf8"));
      const ingestFingerprint = computeSourceIngestFingerprint({
        contentHash, headingPath: [heading], metadata, ingestConfigHash: begun.run.ingestConfigHash,
      });
      return {
        bindingId: `binding-${i}`, bindingGeneration: 1,
        operationId: computeSourceOperationId(begun.run.sourceId, `binding-${i}`, ingestFingerprint, begun.run.snapshotId, 1),
        relativePath: "MANY.md", headingPath: [heading], occurrence: 1, segmentIndex: 1, documentSequence: i + 1,
        contentHash, ingestFingerprint, metadata,
        sourceRef: `source://source-a/MANY.md#section-${i}~1`, content: text,
      };
    });
    const files = [{ relativePath: "MANY.md", type: "file" as const, contentHash: "many-file-hash", byteLength: 10_000, title: "MANY" }];
    core.stageSourceManifest({
      runId: begun.run.id, scanStatus: "complete", manifestHash: computeSourceManifestHash(files), files, chunks,
    });
    let conceptId: string | undefined;
    for (const chunk of chunks) {
      const stored = await core.storeSource(chunk.content, {
        circle, sourceRefs: [chunk.sourceRef], operationId: chunk.operationId,
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

    const gathered = await core.gather("cobalt walruses", { circle, sourceAuthorizationContext: auth });
    const card = gathered.ranked.find((c) => c.id === conceptId);
    expect(card).toBeDefined();
    expect(card!.sourceRefsCount).toBe(sectionCount);
    // The refs themselves must not ride along on the card at any size.
    expect(card).not.toHaveProperty("sourceRefs");
    expect(JSON.stringify(card)).not.toContain("source://source-a/MANY.md");
  });
});
