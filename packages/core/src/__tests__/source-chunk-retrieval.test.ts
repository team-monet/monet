/**
 * Chunk-granular source retrieval (ratified): search()/gather() rank a kind='source' concept by
 * the MAX cosine over its own ACTIVE chunk vectors (observations.embedding, now a real per-chunk
 * embedding written at ingestion by storeSourceChunk) instead of one mean-pooled whole-file
 * concepts.embedding — root cause: a multi-section file's on-topic chunk gets diluted below the
 * noise floor by every OTHER unrelated section sharing that single whole-file vector.
 *
 * These tests hand-drive the source ledger exactly the way source-retrieval.test.ts's own
 * `publish()` helper does (beginSourceRun -> stageSourceManifest -> storeSource ->
 * recordSourceBindingReceipt -> publishSourceRun -> recomputeSourceConceptBody) — this IS "the
 * staging pipeline" syncRepoMdSource/syncGitMdSource drive via materializeStagedBindings, just
 * orchestrated by hand instead of by scanning a real git/filesystem tree, matching this suite's
 * existing convention for testing the ledger without git subprocess overhead.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider, cosine } from "../embedding";
import { computeSourceContentHash, computeSourceIngestFingerprint, computeSourceOperationId, sourceHeadingAnchor } from "../source-chunker";
import { computeSourceManifestHash } from "../source-scanner";
import type { SourceSyncRun, StageSourceManifestInput } from "../source-types";
import type { StoragePort } from "../storage";

const auth = Object.freeze({ callerId: "caller", projectId: "project" });
const circle = "chunk-retrieval-circle";
const EMBED_DIM = new HashingEmbeddingProvider().dim;

function sourceInput(id = "source-a") {
  return {
    id, type: "repo-md" as const, name: id, localPath: `/tmp/${id}`, circle,
    access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] }, writeBack: "none" as const,
  };
}

function oneChunkManifest(
  run: SourceSyncRun, text: string, bindingGeneration = 1,
  relativePath = "README.md", headingPath = ["Retrieval"],
): StageSourceManifestInput {
  const contentHash = computeSourceContentHash(Buffer.from(text, "utf8"));
  const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
  const ingestFingerprint = computeSourceIngestFingerprint({
    contentHash, headingPath, metadata, ingestConfigHash: run.ingestConfigHash,
  });
  const files = [{ relativePath, type: "file" as const, contentHash: "file-hash", byteLength: Buffer.byteLength(text), title: relativePath }];
  return {
    runId: run.id, scanStatus: "complete", manifestHash: computeSourceManifestHash(files), files,
    chunks: [{
      bindingId: "binding-1", bindingGeneration,
      operationId: computeSourceOperationId(run.sourceId, "binding-1", ingestFingerprint, run.snapshotId, bindingGeneration),
      relativePath, headingPath, occurrence: 1, segmentIndex: 1, documentSequence: 1,
      contentHash, ingestFingerprint, metadata,
      sourceRef: `source://${run.sourceId}/${relativePath}#${sourceHeadingAnchor(headingPath)}~1`, content: text,
    }],
  };
}

async function publish(core: MonetCore, sourceId = "source-a", text = "Published evidence.", sourceCircle = circle) {
  const begun = core.beginSourceRun({ sourceId, snapshotId: `snapshot-${sourceId}-1` });
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
    runId: begun.run.id, activationToken: core.beginSourceActivation(begun.run.id), expectedManifestHash: manifest.manifestHash,
  });
  await core.recomputeSourceConceptBody(stored.conceptId);
  return { run: begun.run, chunk, stored };
}

/** Re-syncs an EXISTING published binding with CHANGED content: the real successor/supersession
 *  sequence materializeStagedBindings (source-sync.ts) drives, hand-driven the same way
 *  source-retrieval.test.ts's own refresh test does. Proves item 6: a re-sync of an existing
 *  source actually rewrites that chunk's row (and, post-fix, its embedding) rather than being a
 *  no-op — unlike an UNCHANGED file, which the real pipeline's ingestFingerprint fast path skips. */
async function republish(
  core: MonetCore,
  prior: { stored: { conceptId: string; observationId: string } },
  sourceId: string, text: string, snapshotId: string, sourceCircle = circle,
) {
  const replacement = core.beginSourceRun({ sourceId, snapshotId });
  if (replacement.kind !== "started") throw new Error("expected replacement run");
  const manifest = oneChunkManifest(replacement.run, text, 2);
  core.stageSourceManifest(manifest);
  const chunk = manifest.chunks[0];
  const successor = await core.storeSource(chunk.content, {
    circle: sourceCircle, sourceRefs: [chunk.sourceRef], operationId: chunk.operationId, attachTo: prior.stored.conceptId,
  });
  core.recordSourceBindingReceipt({
    runId: replacement.run.id, bindingId: chunk.bindingId, conceptId: successor.conceptId,
    observationId: successor.observationId, predecessorObservationId: prior.stored.observationId, writeState: "engine-written",
  });
  await core.supersedeSourceChunkObservation(successor.conceptId, successor.observationId, prior.stored.observationId);
  core.recordSourceBindingReceipt({ runId: replacement.run.id, bindingId: chunk.bindingId, writeState: "committed" });
  core.publishSourceRun({
    runId: replacement.run.id, activationToken: core.beginSourceActivation(replacement.run.id), expectedManifestHash: manifest.manifestHash,
  });
  await core.recomputeSourceConceptBody(successor.conceptId);
  return { run: replacement.run, chunk, stored: successor };
}

interface Section { headingPath: string[]; content: string }

function multiChunkManifest(run: SourceSyncRun, sections: Section[], relativePath = "NOTES.md"): StageSourceManifestInput {
  const chunks = sections.map((section, i) => {
    const contentHash = computeSourceContentHash(Buffer.from(section.content, "utf8"));
    const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
    const ingestFingerprint = computeSourceIngestFingerprint({
      contentHash, headingPath: section.headingPath, metadata, ingestConfigHash: run.ingestConfigHash,
    });
    const bindingId = `binding-${i + 1}`;
    return {
      bindingId, bindingGeneration: 1,
      operationId: computeSourceOperationId(run.sourceId, bindingId, ingestFingerprint, run.snapshotId, 1),
      relativePath, headingPath: section.headingPath, occurrence: 1, segmentIndex: 1, documentSequence: i + 1,
      contentHash, ingestFingerprint, metadata,
      sourceRef: `source://${run.sourceId}/${relativePath}#${sourceHeadingAnchor(section.headingPath)}~1`,
      content: section.content,
    };
  });
  const totalBytes = sections.reduce((n, s) => n + Buffer.byteLength(s.content, "utf8"), 0);
  const files = [{ relativePath, type: "file" as const, contentHash: "file-hash", byteLength: totalBytes, title: relativePath }];
  return { runId: run.id, scanStatus: "complete", manifestHash: computeSourceManifestHash(files), files, chunks };
}

/**
 * Publishes `count` INDEPENDENT single-chunk files (each its own forceNew source concept) to
 * `sourceId` in ONE sync run — for the candidate-scoring-at-scale test (review fix, Codex P2
 * finding 6), which needs many real, fully-authorized source concepts fast. Deliberately skips
 * recomputeSourceConceptBody for every decoy (their concepts.embedding stays the create-time
 * zero placeholder — irrelevant to this test, which only exercises the per-chunk vector query) —
 * this is what keeps 500+ decoys cheap; publish()'s own per-file embed+recompute cost is the part
 * this helper avoids paying 500+ times over.
 */
async function publishManyDecoys(core: MonetCore, sourceId: string, count: number): Promise<void> {
  const begun = core.beginSourceRun({ sourceId, snapshotId: `snapshot-${sourceId}-decoys` });
  if (begun.kind !== "started") throw new Error("expected a new run");
  const chunks = Array.from({ length: count }, (_, i) => {
    const relativePath = `decoy-${i}.md`;
    const content = `Filler note number ${i} about unrelated household chores and errands.`;
    const contentHash = computeSourceContentHash(Buffer.from(content, "utf8"));
    const metadata = { tags: [] as string[], scope: null, frontmatter: {} };
    const ingestFingerprint = computeSourceIngestFingerprint({
      contentHash, headingPath: ["Note"], metadata, ingestConfigHash: begun.run.ingestConfigHash,
    });
    const bindingId = `decoy-binding-${i}`;
    return {
      bindingId, bindingGeneration: 1,
      operationId: computeSourceOperationId(begun.run.sourceId, bindingId, ingestFingerprint, begun.run.snapshotId, 1),
      relativePath, headingPath: ["Note"], occurrence: 1, segmentIndex: 1, documentSequence: i + 1,
      contentHash, ingestFingerprint, metadata,
      sourceRef: `source://${begun.run.sourceId}/${relativePath}#note~1`, content,
    };
  });
  const files = chunks.map((chunk) => ({
    relativePath: chunk.relativePath, type: "file" as const, contentHash: "file-hash",
    byteLength: Buffer.byteLength(chunk.content), title: chunk.relativePath,
  }));
  const manifest: StageSourceManifestInput = {
    runId: begun.run.id, scanStatus: "complete", manifestHash: computeSourceManifestHash(files), files, chunks,
  };
  core.stageSourceManifest(manifest);
  for (const chunk of chunks) {
    const stored = await core.storeSource(chunk.content, {
      circle, sourceRefs: [chunk.sourceRef], operationId: chunk.operationId, resolution: "forceNew",
    });
    core.recordSourceBindingReceipt({
      runId: begun.run.id, bindingId: chunk.bindingId, conceptId: stored.conceptId,
      observationId: stored.observationId, predecessorObservationId: null, writeState: "committed",
    });
  }
  core.publishSourceRun({
    runId: begun.run.id, activationToken: core.beginSourceActivation(begun.run.id), expectedManifestHash: manifest.manifestHash,
  });
}

async function publishMulti(core: MonetCore, sourceId: string, sections: Section[], sourceCircle = circle, relativePath = "NOTES.md") {
  const begun = core.beginSourceRun({ sourceId, snapshotId: `snapshot-${sourceId}-multi` });
  if (begun.kind !== "started") throw new Error("expected a new run");
  const manifest = multiChunkManifest(begun.run, sections, relativePath);
  core.stageSourceManifest(manifest);
  let attachTo: string | undefined;
  let conceptId = "";
  for (const chunk of manifest.chunks) {
    const stored = await core.storeSource(chunk.content, {
      circle: sourceCircle, sourceRefs: [chunk.sourceRef], operationId: chunk.operationId,
      ...(attachTo ? { attachTo } : { resolution: "forceNew" as const }),
    });
    conceptId = stored.conceptId;
    attachTo = stored.conceptId;
    core.recordSourceBindingReceipt({
      runId: begun.run.id, bindingId: chunk.bindingId, conceptId: stored.conceptId,
      observationId: stored.observationId, predecessorObservationId: null, writeState: "committed",
    });
  }
  core.publishSourceRun({
    runId: begun.run.id, activationToken: core.beginSourceActivation(begun.run.id), expectedManifestHash: manifest.manifestHash,
  });
  await core.recomputeSourceConceptBody(conceptId);
  return { run: begun.run, conceptId };
}

type RawDb = Pick<StoragePort, "prepare">;
const rawDb = (core: MonetCore): RawDb => (core as unknown as { db: RawDb }).db;

function rawObservationEmbedding(core: MonetCore, observationId: string): string {
  return (rawDb(core).prepare(`SELECT embedding FROM observations WHERE id = ?`).get(observationId) as { embedding: string }).embedding;
}

function rawConceptEmbedding(core: MonetCore, conceptId: string): string {
  return (rawDb(core).prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(conceptId) as { embedding: string }).embedding;
}

/** Mirrors source-sync.test.ts's own `isPlaceholderEmbedding` helper (same substrate-wide
 *  convention for "is this still the all-zero placeholder"). */
function isZeroEmbeddingJson(json: string): boolean {
  return (JSON.parse(json) as number[]).every((component) => component === 0);
}

/** Simulates a chunk observation written by a build that predates chunk-granular retrieval —
 *  storeSourceChunk always wrote an all-zero placeholder for observations.embedding then. */
function zeroOutObservationEmbedding(core: MonetCore, observationId: string): void {
  rawDb(core).prepare(`UPDATE observations SET embedding = ? WHERE id = ?`).run(JSON.stringify(new Array(EMBED_DIM).fill(0)), observationId);
}

const cores: MonetCore[] = [];
const makeCore = (): MonetCore => {
  const core = new MonetCore(":memory:", { defaultCircle: circle });
  cores.push(core);
  return core;
};
afterEach(() => { while (cores.length) cores.pop()!.close(); });

describe("chunk-granular source retrieval — write path", () => {
  it("writes a real, non-zero per-chunk embedding at ingestion (not the old placeholder)", async () => {
    const core = makeCore();
    core.createSource(sourceInput());
    const { stored } = await publish(core, "source-a", "Cobalt walruses migrate south for the winter breeding season.");
    expect(isZeroEmbeddingJson(rawObservationEmbedding(core, stored.observationId))).toBe(false);
    // Item 4: the concept's OWN (whole-file) embedding is unaffected by this change — still a
    // real embedding of the recomputed body (recomputeSourceConceptBody), unrelated to whether the
    // chunk-level write is a placeholder or not; asserted here only to document it stays populated.
    expect(isZeroEmbeddingJson(rawConceptEmbedding(core, stored.conceptId))).toBe(false);
  });

  it("a re-sync of an existing source rewrites the changed chunk with a fresh, real embedding", async () => {
    const core = makeCore();
    core.createSource(sourceInput());
    const initial = await publish(core, "source-a", "The original README describes cobalt walrus migration.");
    // Simulate this row predating the fix (an old build's permanent zero-vector placeholder).
    zeroOutObservationEmbedding(core, initial.stored.observationId);
    expect(isZeroEmbeddingJson(rawObservationEmbedding(core, initial.stored.observationId))).toBe(true);

    const refreshed = await republish(core, initial, "source-a", "The updated README now describes narwhal migration instead.", "snapshot-2");
    // The superseded predecessor's row is untouched (a new row is written, never mutated in place).
    expect(isZeroEmbeddingJson(rawObservationEmbedding(core, initial.stored.observationId))).toBe(true);
    // The successor — this run's actual write, via the same staging pipeline a real sync drives —
    // gets a real, non-zero embedding of its own (changed) content.
    expect(refreshed.stored.observationId).not.toBe(initial.stored.observationId);
    expect(isZeroEmbeddingJson(rawObservationEmbedding(core, refreshed.stored.observationId))).toBe(false);
  });
});

describe("chunk-granular source retrieval — best-chunk ranking", () => {
  const query = "What database powers the billing service?";

  // A multi-section file where only ONE section is on-topic; the rest is deliberately unrelated
  // filler, long enough to dilute the whole-file mean-pooled vector — the exact failure mode the
  // ratified fix targets (measured in the wow-e2e repro: on-topic chunk 0.3274 vs whole-file
  // 0.0799 for the same shape of query). A single-chunk distractor sits between the two: it beats
  // the multi-section file's DILUTED whole-file score, but loses to its FOCUSED chunk score — a
  // clean, self-verifying rank flip rather than a hand-picked threshold.
  const targetSection: Section = {
    headingPath: ["Database"],
    content:
      "We chose PostgreSQL for the billing service database. PostgreSQL was selected over MongoDB " +
      "because the billing service needs ACID multi-row transactions for the ledger and strong " +
      "foreign key integrity across every billing table. The billing service database decision " +
      "was finalized after the team evaluated every alternative database for the billing service.",
  };
  const fillerSections: Section[] = [
    { headingPath: ["Weather"], content: "The regional weather station logged record rainfall across the valley this week. Local meteorologists expect the storm system to clear by the weekend, bringing sunshine back to the coastline. Umbrella sales spiked at the downtown market stalls." },
    { headingPath: ["Recipes"], content: "The community cookbook added a new recipe for roasted garlic pasta with fresh basil. Reviewers praised the bright lemon finish and the crunchy toasted breadcrumb topping. The editor suggested pairing it with a chilled cucumber salad." },
    { headingPath: ["Parking"], content: "Parking permits for the north garage renew every calendar quarter for badge holders. Visitors without a permit must register at the front desk kiosk before nine in the morning. Overnight parking remains prohibited on weekdays." },
    { headingPath: ["Gardening"], content: "The community garden volunteers planted new rows of tomatoes and peppers this spring. Watering duty rotates weekly among the garden club members according to the posted schedule. The compost bins need turning every other Sunday." },
    { headingPath: ["Hiking"], content: "The trail committee marked a new loop through the ridge with fresh blue blazes. Hikers should carry extra water since the summit section has no shade for nearly two miles. The overlook near the old quarry offers the best sunset view." },
    { headingPath: ["Book Club"], content: "This month's book club pick follows a lighthouse keeper on a remote northern island. Members debated the ending for nearly an hour before settling on next month's mystery novel instead." },
    { headingPath: ["Office Move"], content: "Facilities confirmed the third floor lounge furniture arrives before the holiday break. The old couches will be donated to the shelter downtown once the new seating is installed." },
  ];
  const distractorText =
    "Every team owns its own database independently. The billing service database was chosen by " +
    "the billing team, without a shared standard across the platform.";

  async function buildFixture(core: MonetCore) {
    core.createSource(sourceInput("multi-source"));
    core.createSource(sourceInput("distractor-source"));
    const multi = await publishMulti(core, "multi-source", [targetSection, ...fillerSections]);
    const distractor = await publish(core, "distractor-source", distractorText);
    return { multi, distractor };
  }

  it("search() surfaces the multi-section file's on-topic chunk where whole-file scoring would miss it", async () => {
    const core = makeCore();
    const { multi, distractor } = await buildFixture(core);

    const embedder = new HashingEmbeddingProvider();
    const queryEmb = await embedder.embed(query);
    const wholeFileCos = cosine(queryEmb, Float32Array.from(JSON.parse(rawConceptEmbedding(core, multi.conceptId)) as number[]));
    const distractorCos = cosine(queryEmb, Float32Array.from(JSON.parse(rawConceptEmbedding(core, distractor.stored.conceptId)) as number[]));
    // Sanity-check the fixture actually reproduces dilution: the multi-section file's whole-file
    // vector scores BELOW the single-chunk distractor for this query (i.e. old whole-file-only
    // scoring would rank the distractor above it, or omit it from a small top-k entirely).
    expect(wholeFileCos).toBeLessThan(distractorCos);

    const results = await core.search(query, { circle, limit: 5, sourceAuthorizationContext: auth });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(multi.conceptId);
    const multiCard = results.find((r) => r.id === multi.conceptId)!;
    const distractorCard = results.find((r) => r.id === distractor.stored.conceptId);
    // The fix: ranked by its BEST chunk, the multi-section file now outranks the distractor that
    // beat its diluted whole-file score.
    if (distractorCard) expect(multiCard.score).toBeGreaterThan(distractorCard.score);
    expect(multiCard.score).toBeGreaterThan(wholeFileCos);
  });

  it("gather() surfaces the same multi-section file for the same query, consistent with search()", async () => {
    const core = makeCore();
    const { multi, distractor } = await buildFixture(core);

    const gathered = await core.gather(query, { circle, sourceAuthorizationContext: auth });
    const gatheredIds = [...gathered.seed.map((c) => c.id), ...gathered.ranked.map((c) => c.id)];
    expect(gatheredIds).toContain(multi.conceptId);

    const results = await core.search(query, { circle, limit: 5, sourceAuthorizationContext: auth });
    const searchIds = results.map((r) => r.id);
    // search() and gather() agree on the hit itself (both read best-chunk scores off the same
    // scoreSourceConcepts helper) — not necessarily on final fused scores, since gather() also
    // folds seed strength / RRF fusion through fuse(), which search() never applies.
    expect(searchIds).toContain(multi.conceptId);
    void distractor;
  });
});

describe("chunk-granular source retrieval — zero-vector compatibility", () => {
  it("falls back to the whole-file concept embedding when every active chunk vector is still an old-build zero placeholder", async () => {
    const core = makeCore();
    core.createSource(sourceInput());
    const { stored } = await publish(core, "source-a", "Cobalt walruses migrate south for the winter breeding season.");
    zeroOutObservationEmbedding(core, stored.observationId);
    expect(isZeroEmbeddingJson(rawObservationEmbedding(core, stored.observationId))).toBe(true);

    const embedder = new HashingEmbeddingProvider();
    const query = "Where do cobalt walruses migrate?";
    const queryEmb = await embedder.embed(query);
    const wholeFileEmb = Float32Array.from(JSON.parse(rawConceptEmbedding(core, stored.conceptId)) as number[]);
    const expectedFallbackScore = cosine(queryEmb, wholeFileEmb);
    expect(expectedFallbackScore).not.toBe(0); // otherwise this fixture can't distinguish fallback from a broken MAX-over-zeros=0

    const results = await core.search(query, { circle, limit: 5, sourceAuthorizationContext: auth });
    const card = results.find((r) => r.id === stored.conceptId);
    expect(card).toBeDefined();
    // Exact match: today's status-quo whole-file cosine, not 0 (which MAX-over-zero-vectors would
    // produce without the fallback, ranking strictly worse than pre-fix behavior).
    expect(card!.score).toBe(expectedFallbackScore);

    const gathered = await core.gather(query, { circle, sourceAuthorizationContext: auth });
    const gatheredIds = [...gathered.seed.map((c) => c.id), ...gathered.ranked.map((c) => c.id)];
    expect(gatheredIds).toContain(stored.conceptId);
  });
});

describe("chunk-granular source retrieval — partial-refresh mixed state (review fix, Codex P2 finding 5)", () => {
  it("does not lose an UNCHANGED section's relevance to an unrelated section that happens to have a real vector", async () => {
    // A multi-section file where only ONE section (Weather) has ever been touched by a
    // content-changing sync since this build started writing real chunk vectors — the OTHER
    // section (Database, the query's actual target) is still on its old-build zero placeholder.
    // Before this fix, ANY non-zero chunk suppressed the whole-file fallback entirely, so this
    // query scored against ONLY the unrelated Weather chunk — worse than pre-chunk-granular
    // whole-file scoring, not just no-better.
    const core = makeCore();
    core.createSource(sourceInput("mixed-source"));
    const databaseSection: Section = {
      headingPath: ["Database"],
      content:
        "We chose PostgreSQL for the billing service database. PostgreSQL was selected over MongoDB " +
        "because the billing service needs ACID multi-row transactions for the ledger and strong " +
        "foreign key integrity across every billing table.",
    };
    const weatherSection: Section = {
      headingPath: ["Weather"],
      content:
        "The regional weather station logged record rainfall across the valley this week. Local " +
        "meteorologists expect the storm system to clear by the weekend, bringing sunshine back to " +
        "the coastline. Umbrella sales spiked at the downtown market stalls.",
    };
    const { conceptId } = await publishMulti(core, "mixed-source", [databaseSection, weatherSection]);

    // Find each section's own chunk observation and zero out ONLY Database's — simulating an
    // old-build store where just the Weather section was ever re-synced with real content since.
    const rows = rawDb(core)
      .prepare(
        `SELECT sc.heading_path_json AS heading, sc.observation_id AS observation_id
           FROM source_chunks sc WHERE sc.concept_id = ? AND sc.lifecycle = 'active'`,
      )
      .all(conceptId) as Array<{ heading: string; observation_id: string }>;
    const databaseObservationId = rows.find((r) => JSON.parse(r.heading)[0] === "Database")!.observation_id;
    zeroOutObservationEmbedding(core, databaseObservationId);
    expect(isZeroEmbeddingJson(rawObservationEmbedding(core, databaseObservationId))).toBe(true);

    const query = "What database did we choose?";
    const embedder = new HashingEmbeddingProvider();
    const queryEmb = await embedder.embed(query);
    const wholeFileCos = cosine(queryEmb, Float32Array.from(JSON.parse(rawConceptEmbedding(core, conceptId)) as number[]));
    const weatherObservationId = rows.find((r) => JSON.parse(r.heading)[0] === "Weather")!.observation_id;
    const weatherChunkCos = cosine(queryEmb, Float32Array.from(JSON.parse(rawObservationEmbedding(core, weatherObservationId)) as number[]));
    // Sanity-check the fixture: the unrelated-but-non-zero Weather chunk scores BELOW the diluted
    // whole-file embedding, which still carries the real Database section's text — this is exactly
    // the shape where the OLD all-or-nothing fallback regressed (it would have used weatherChunkCos
    // alone, since bestByConceptId was non-empty).
    expect(weatherChunkCos).toBeLessThan(wholeFileCos);

    const results = await core.search(query, { circle, limit: 5, sourceAuthorizationContext: auth });
    const card = results.find((r) => r.id === conceptId);
    expect(card).toBeDefined();
    // The fix: MAX(whole-file, every non-zero chunk) — whole-file wins here, recovering the
    // Database section's relevance instead of scoring against Weather's irrelevant real vector alone.
    expect(card!.score).toBe(Math.max(wholeFileCos, weatherChunkCos));
    expect(card!.score).toBe(wholeFileCos);

    const gathered = await core.gather(query, { circle, sourceAuthorizationContext: auth });
    const gatheredIds = [...gathered.seed.map((c) => c.id), ...gathered.ranked.map((c) => c.id)];
    expect(gatheredIds).toContain(conceptId);
  });
});

describe("chunk-granular source retrieval — candidate scoring at scale (review fix, Codex P2 finding 6)", () => {
  // This explicit ceiling preserves CI headroom for deterministic 520-store scale work.
  it("scores correctly against a large source-concept id list, via the json_each(?) parameter-count-independent query", async () => {
    const core = makeCore();
    core.createSource(sourceInput("batch-source"));
    // scoreSourceConcepts (engine.ts) joins the candidate id list through json_each(?) on ONE
    // bound JSON-array parameter rather than an IN (?,?,...) whose host-parameter count scales
    // with the candidate count (this build's measured ceiling: SQLite 3.49.2 accepts up to 32766
    // bound parameters, throws at 32767 — see scoreSourceConcepts' own comment). A few hundred
    // decoys is plenty to prove the query returns EVERY matching row correctly at a nontrivial
    // multi-hundred count — the mechanism itself no longer has a batch boundary to cross, so this
    // is a correctness-at-scale check, not a boundary-crossing one. Each decoy is an
    // independently-published, fully-authorized source concept sharing no vocabulary with the
    // target query; the real target is published LAST, after every decoy.
    const DECOY_COUNT = 520;
    await publishManyDecoys(core, "batch-source", DECOY_COUNT);
    const { stored: target } = await publish(
      core, "batch-source",
      "We chose PostgreSQL for the billing service database, selected over MongoDB for ACID transactions.",
    );

    const results = await core.search("What database did we choose for the billing service?", {
      circle, limit: 5, sourceAuthorizationContext: auth,
    });
    expect(results.map((r) => r.id)).toContain(target.conceptId);
    expect(results[0].id).toBe(target.conceptId);

    const gathered = await core.gather("What database did we choose for the billing service?", {
      circle, sourceAuthorizationContext: auth,
    });
    const gatheredIds = [...gathered.seed.map((c) => c.id), ...gathered.ranked.map((c) => c.id)];
    expect(gatheredIds).toContain(target.conceptId);
  }, 10_000);
});
