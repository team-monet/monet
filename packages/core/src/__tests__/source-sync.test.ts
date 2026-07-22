import { execFile as nodeExecFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";
import type { EmbeddingProvider } from "../embedding";
import { computeSourceContentHash } from "../source-chunker";
import { syncRepoMdSource as runRepoMdSync } from "../source-sync";
import type { RepoMdSyncFaultPoint, RepoMdSyncOptions } from "../source-sync";
import { computeSourceIngestConfigHash, scanSourceSnapshot } from "../source-scanner";
import type { StoragePort } from "../storage";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function noRenameDiffExec(): typeof nodeExecFile {
  return ((file: string, args: readonly string[], options: object, callback: (...args: unknown[]) => void) => {
    if (file === "git" && args.includes("diff")) {
      callback(null, Buffer.alloc(0), Buffer.alloc(0));
      return {};
    }
    return nodeExecFile(file, [...args], options, callback as never);
  }) as unknown as typeof nodeExecFile;
}

function makeWritable(path: string): void {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) { rmSync(path, { force: true }); return; }
    if (!stats.isDirectory()) { chmodSync(path, 0o600); return; }
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) makeWritable(join(path, entry));
  } catch { /* test cleanup */ }
}

function fixture(label: string, opts: { embedder?: EmbeddingProvider } = {}) {
  const root = mkdtempSync(join(tmpdir(), `monet-repo-sync-${label}-`));
  const repo = join(root, "repo");
  const storage = join(root, "managed");
  const db = join(root, "monet.db");
  execFileSync("git", ["init", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# Intro\n\ninitial committed body\n");
  git(repo, "add", "README.md"); git(repo, "commit", "-m", "initial");
  const core = new MonetCore(db, { sourceStorageDir: storage, ...(opts.embedder ? { embedder: opts.embedder } : {}) });
  core.createSource({
    id: "repo-source", type: "repo-md", name: "repo", localPath: repo, circle: "repo-source",
    include: ["README.md"], exclude: [], autoDetect: false,
    access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] }, writeBack: "none",
  });
  return {
    root, repo, storage, db, core,
    commit(content: string, message: string) {
      writeFileSync(join(repo, "README.md"), content);
      git(repo, "add", "README.md"); git(repo, "commit", "-m", message);
      return git(repo, "rev-parse", "HEAD");
    },
    cleanup() { try { core.close(); } catch { /* already closed */ } makeWritable(root); rmSync(root, { recursive: true, force: true }); },
  };
}

function rawConcept(core: MonetCore, conceptId: string): { body: string; status: string; active_observation_id: string | null } {
  const db = (core as unknown as { db: StoragePort }).db;
  return db.prepare(`SELECT body,status,active_observation_id FROM concepts WHERE id=?`).get(conceptId) as ReturnType<typeof rawConcept>;
}

/** Full concept-row read for recompute regression tests (review fix, BLOCKER): title/body/embedding
 *  as they actually sit in the concepts table, not the ledger's own (always-correct) copy of chunk
 *  content — this is what the reviewer's "assert on the concept row, not ledger chunks" tests need. */
function rawConceptFull(core: MonetCore, conceptId: string): { title: string; body: string; embedding: string; status: string } {
  const db = (core as unknown as { db: StoragePort }).db;
  return db.prepare(`SELECT title,body,embedding,status FROM concepts WHERE id=?`).get(conceptId) as ReturnType<typeof rawConceptFull>;
}

/** True iff the embedding is the create-time all-zero placeholder (storeSourceChunk, engine.ts) —
 *  i.e. recompute never actually ran for this concept. */
function isPlaceholderEmbedding(embeddingJson: string): boolean {
  const vector = JSON.parse(embeddingJson) as number[];
  return vector.every((component) => component === 0);
}

function pendingRecomputeConceptIds(core: MonetCore, sourceId: string): string[] {
  const db = (core as unknown as { db: StoragePort }).db;
  return (db.prepare(`SELECT concept_id FROM source_recompute_pending WHERE source_id=?`).all(sourceId) as Array<{ concept_id: string }>)
    .map((row) => row.concept_id);
}

function sourceAttemptState(core: MonetCore, sourceId: string) {
  const db = (core as unknown as { db: StoragePort }).db;
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_id=?`).get(sourceId) as { count: number }).count;
  return {
    attempts: count("source_attempt_events"),
    prePin: count("source_pre_pin_attempts"),
    verification: count("source_verification_checks"),
  };
}

/** Raw bytes for `relativePath` as they actually sit in the currently-published sealed snapshot —
 * the same surface `source_path`/`sourcePath()` exposes — independent of what the ledger's
 * manifest claims. This is the blocker 5a cross-check: read here, not just the ledger. */
function rawSnapshotBytes(f: { core: MonetCore }, relativePath: string): Buffer {
  const located = f.core.sourcePath("repo-source", { callerId: "caller", projectId: "project" });
  return readFileSync(join(located.snapshotPath, relativePath));
}

type TestSnapshotMarker = {
  snapshotId: string;
  configHash: string;
  variant: string;
  files: Array<{ path: string; size: number; sha256: string; mode?: "100644" | "100755" }>;
};

function mutateSealedRepoSnapshot(
  snapshot: string,
  mutate: (marker: TestSnapshotMarker) => void,
): void {
  const sidecar = `${snapshot}.complete.json`;
  const marker = JSON.parse(readFileSync(sidecar, "utf8")) as TestSnapshotMarker;
  chmodSync(snapshot, 0o700);
  chmodSync(sidecar, 0o600);
  mutate(marker);
  marker.files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const file of marker.files) {
    const path = join(snapshot, file.path);
    if (existsSync(path)) chmodSync(path, 0o400);
  }
  chmodSync(snapshot, 0o500);
  writeFileSync(sidecar, JSON.stringify(marker));
  chmodSync(sidecar, 0o400);
}

function addFileToRepoSnapshot(snapshot: string, relativePath: string, content: Buffer): void {
  mutateSealedRepoSnapshot(snapshot, (marker) => {
    writeFileSync(join(snapshot, relativePath), content, { mode: 0o400 });
    marker.files.push({
      path: relativePath,
      size: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      mode: "100644",
    });
  });
}

function rewriteRepoSnapshotFile(snapshot: string, relativePath: string, content: Buffer): void {
  mutateSealedRepoSnapshot(snapshot, (marker) => {
    const file = marker.files.find((candidate) => candidate.path === relativePath);
    if (!file) throw new Error("test snapshot file missing");
    chmodSync(join(snapshot, relativePath), 0o600);
    writeFileSync(join(snapshot, relativePath), content);
    file.size = content.length;
    file.sha256 = createHash("sha256").update(content).digest("hex");
  });
}

function synthesizeOldRepoPublicationIdentity(
  f: ReturnType<typeof fixture>,
  oldHash: string,
): { oldVariant: string; currentHash: string } {
  const source = f.core.getSource("repo-source")!;
  const run = f.core.getSourceRun(source.activeRunId!)!;
  const currentHash = run.ingestConfigHash;
  const snapshots = join(f.storage, "repo-md", "repo-source", "snapshots");
  const currentVariant = join(snapshots, `${run.snapshotId}-${currentHash.slice(-64)}`);
  const oldVariant = join(snapshots, `${run.snapshotId}-${oldHash.slice(-64)}`);
  mutateSealedRepoSnapshot(currentVariant, (marker) => {
    marker.configHash = oldHash;
    marker.variant = `${run.snapshotId}-${oldHash.slice(-64)}`;
  });
  renameSync(currentVariant, oldVariant);
  renameSync(`${currentVariant}.complete.json`, `${oldVariant}.complete.json`);
  const current = join(f.storage, "repo-md", "repo-source", "current");
  rmSync(current);
  symlinkSync(join("snapshots", `${run.snapshotId}-${oldHash.slice(-64)}`), current, "dir");
  const db = (f.core as unknown as { db: StoragePort }).db;
  db.prepare(`UPDATE source_sync_runs SET ingest_config_hash=?,scan_config_version=? WHERE id=?`)
    .run(oldHash, "synthetic-old-scanner/synthetic-old-chunker", run.id);
  db.prepare(`UPDATE source_snapshots SET ingest_config_hash=? WHERE run_id=?`).run(oldHash, run.id);
  db.prepare(`UPDATE knowledge_sources SET active_ingest_config_hash=? WHERE id=?`).run(oldHash, source.id);
  return { oldVariant, currentHash };
}

describe("repo-md committed-HEAD sync", () => {
  it("keeps engine-owned repo storage, config, and lock clock authoritative", async () => {
    const f = fixture("trusted-materializer");
    try {
      const alternate = join(f.root, "alternate-managed");
      const forged = {
        sourceStorageDir: alternate,
        config: { include: ["missing.md"], exclude: [], limits: {} },
        lockStaleMs: 1,
        now: () => Number.MAX_SAFE_INTEGER,
      } as unknown as NonNullable<RepoMdSyncOptions["materializer"]>;
      await expect(f.core.syncRepoMdSource("repo-source", { materializer: forged })).resolves.toMatchObject({ status: "published" });
      expect(existsSync(alternate)).toBe(false);
      const path = f.core.sourcePath("repo-source", { callerId: "caller", projectId: "project" }).path;
      expect(readFileSync(join(path, "README.md"), "utf8")).toContain("initial committed body");
    } finally { f.cleanup(); }
  });

  it("carries binding identity across committed file renames and back while refreshing provenance", async () => {
    const f = fixture("rename-stability");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      const firstResult = await f.core.syncRepoMdSource("repo-source");
      const first = f.core.listSourceChunks(firstResult.runId!, true)[0]!;

      git(f.repo, "mv", "README.md", "GUIDE.md");
      git(f.repo, "add", "GUIDE.md"); git(f.repo, "commit", "-m", "rename guide");
      const secondResult = await f.core.syncRepoMdSource("repo-source");
      const second = f.core.listSourceChunks(secondResult.runId!, true)[0]!;
      expect(second).toMatchObject({
        bindingId: first.bindingId,
        conceptId: first.conceptId,
        bindingGeneration: first.bindingGeneration + 1,
        relativePath: "GUIDE.md",
        sourceRef: "source://repo-source/GUIDE.md#intro~1",
      });
      expect(second.operationId).not.toBe(first.operationId);
      expect(second.predecessorObservationId).toBe(first.observationId);
      expect(f.core.listSourceCleanupItems(secondResult.runId!).some((item) => item.kind === "retire-absent")).toBe(false);

      git(f.repo, "mv", "GUIDE.md", "README.md");
      git(f.repo, "commit", "-m", "rename guide back");
      const thirdResult = await f.core.syncRepoMdSource("repo-source");
      const third = f.core.listSourceChunks(thirdResult.runId!, true)[0]!;
      expect(third).toMatchObject({
        bindingId: first.bindingId,
        conceptId: first.conceptId,
        bindingGeneration: second.bindingGeneration + 1,
        relativePath: "README.md",
      });
      expect(new Set([first.operationId, second.operationId, third.operationId])).toHaveLength(3);
    } finally { f.cleanup(); }
  });

  it("does not carry a binding when a moved file's heading identity changes", async () => {
    const f = fixture("rename-heading-change");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      const firstResult = await f.core.syncRepoMdSource("repo-source");
      const first = f.core.listSourceChunks(firstResult.runId!, true)[0]!;
      git(f.repo, "mv", "README.md", "GUIDE.md");
      writeFileSync(join(f.repo, "GUIDE.md"), "# Different\n\ninitial committed body\n");
      git(f.repo, "add", "GUIDE.md"); git(f.repo, "commit", "-m", "rename with structure change");
      const secondResult = await f.core.syncRepoMdSource("repo-source");
      const second = f.core.listSourceChunks(secondResult.runId!, true)[0]!;
      expect(second.bindingId).not.toBe(first.bindingId);
      expect(second.conceptId).not.toBe(first.conceptId);
      expect(f.core.listSourceCleanupItems(secondResult.runId!)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "retire-absent", bindingId: first.bindingId }),
      ]));
    } finally { f.cleanup(); }
  });

  it("resolves one target concept for a renamed multi-heading file when the same run also adds and drops a heading (item 5, fileConceptThisRun upfront resolution)", async () => {
    const f = fixture("rename-restructure-same-run");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      // "One" dominates the file's bytes (~97%) so Git's default 50% rename-similarity threshold
      // reliably fires even though "Two" is dropped and "Three" is new in the same commit.
      const stableBig = "stable line for rename similarity\n".repeat(200);
      const smallSection = "y".repeat(220);
      f.commit(`# One\n\n${stableBig}\n# Two\n\n${smallSection}`, "two-section source");
      const firstResult = await f.core.syncRepoMdSource("repo-source");
      const first = f.core.listSourceChunks(firstResult.runId!, true);
      expect(first).toHaveLength(2);
      const firstOne = first.find((chunk) => chunk.headingPath[0] === "One")!;
      const firstTwo = first.find((chunk) => chunk.headingPath[0] === "Two")!;
      // file=concept: two headings of one file already share one concept before the rename.
      expect(firstOne.conceptId).toBe(firstTwo.conceptId);

      git(f.repo, "mv", "README.md", "GUIDE.md");
      writeFileSync(join(f.repo, "GUIDE.md"), `# One\n\n${stableBig}\n# Three\n\n${smallSection}new`);
      git(f.repo, "add", "GUIDE.md"); git(f.repo, "commit", "-m", "rename and restructure in one run");
      const secondResult = await f.core.syncRepoMdSource("repo-source");
      const second = f.core.listSourceChunks(secondResult.runId!, true);
      expect(second).toHaveLength(2);
      const secondOne = second.find((chunk) => chunk.headingPath[0] === "One")!;
      const secondThree = second.find((chunk) => chunk.headingPath[0] === "Three")!;

      // "One" is Git-proven unchanged content: its binding and concept both carry across the rename.
      expect(secondOne.bindingId).toBe(firstOne.bindingId);
      expect(secondOne.conceptId).toBe(firstOne.conceptId);
      expect(secondOne.relativePath).toBe("GUIDE.md");

      // "Three" is a brand-new heading with no binding history of its own, staged in the SAME run
      // as "One"'s carry-forward. It must still resolve to "One"'s (carried) concept, not mint a
      // separate one — proof that fileConceptThisRun resolves a file's target concept from its
      // whole staged chunk set upfront, so a sibling's carried identity is visible even to a chunk
      // that individually has neither a viaBinding match nor any prior-run history.
      expect(secondThree.bindingId).not.toBe(firstTwo.bindingId);
      expect(secondThree.conceptId).toBe(firstOne.conceptId);
      expect(secondThree.relativePath).toBe("GUIDE.md");

      // "Two" is gone: retired via retire-absent, without disturbing the surviving concept.
      expect(f.core.listSourceCleanupItems(secondResult.runId!)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "retire-absent", bindingId: firstTwo.bindingId }),
      ]));
      const body = rawConcept(f.core, firstOne.conceptId!).body;
      expect(body).toContain("new");
      expect(body).toContain(stableBig.trim());
    } finally { f.cleanup(); }
  });

  it("heals a pre-migration split (two headings of one file on two separate legacy concepts) on the next real sync (item 5, legacy-consolidation regression)", async () => {
    // Reproduces the exact shape of the historical one-concept-per-chunk store: before file=concept
    // existed, two headings of ONE file could legitimately sit on two DIFFERENT `kind:source`
    // concepts. That state can't be reached through today's syncRepoMdSource (fileConceptThisRun
    // always consolidates from the first sync onward) — so this test builds a real, fully
    // consolidated two-heading file first, then hand-splits it back apart at the row level to
    // stand in for the pre-migration starting state, then proves a REAL next sync heals it: this
    // caught a genuine bug (a store-wide dry-run against real accumulated data hit it first) where
    // (a) source-ledger.ts's validateDurableEngineReceipt rejected a binding whose new concept
    // differed from its own last-known concept, and (b) materializeStagedBindings always paired a
    // predecessor observation through supersedeSourceChunkObservation's same-concept CAS even when
    // the predecessor's own concept was about to be abandoned in favor of a sibling's.
    const f = fixture("legacy-split-heal");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      const bigOne = "content unique to heading one\n".repeat(80);
      const bigTwo = "content unique to heading two\n".repeat(80);
      f.commit(`# One\n\n${bigOne}\n# Two\n\n${bigTwo}`, "two-section source");
      const firstResult = await f.core.syncRepoMdSource("repo-source");
      const first = f.core.listSourceChunks(firstResult.runId!, true);
      expect(first).toHaveLength(2);
      const one = first.find((chunk) => chunk.headingPath[0] === "One")!;
      const two = first.find((chunk) => chunk.headingPath[0] === "Two")!;
      const consolidatedConceptId = one.conceptId!;
      expect(two.conceptId).toBe(consolidatedConceptId); // file=concept: already unified today

      // Hand-split: clone the concept row under a new id ("legacy concept B"), then repoint
      // "Two"'s currently active chunk row and its observation onto it — simulating a store that
      // predates file=concept, where "Two" never shared "One"'s concept in the first place.
      const db = (f.core as unknown as { db: StoragePort }).db;
      const legacyId = "legacy-concept-b";
      const original = db.prepare(`SELECT * FROM concepts WHERE id=?`).get(consolidatedConceptId) as Record<string, unknown>;
      const columns = Object.keys(original);
      db.prepare(
        `INSERT INTO concepts (${columns.join(",")}) VALUES (${columns.map((c) => `@${c}`).join(",")})`,
      ).run({ ...original, id: legacyId });
      db.prepare(`UPDATE source_chunks SET concept_id=? WHERE run_id=? AND binding_id=?`).run(legacyId, firstResult.runId, two.bindingId);
      db.prepare(`UPDATE observations SET concept_id=? WHERE id=?`).run(legacyId, two.observationId);
      expect(f.core.hasActiveSourceChunks(legacyId)).toBe(true);
      expect(f.core.hasActiveSourceChunks(consolidatedConceptId)).toBe(true); // "One" is still there

      // A real next sync: only "Two"'s content changes, so "One" stays untouched (skipped) while
      // "Two" goes through the real intent/write/supersede path — exactly the shape that crashed.
      f.commit(`# One\n\n${bigOne}\n# Two\n\n${bigTwo}edited`, "edit heading two only");
      const secondResult = await f.core.syncRepoMdSource("repo-source");
      expect(secondResult.status).toBe("published");
      const second = f.core.listSourceChunks(secondResult.runId!, true);
      expect(second).toHaveLength(2);
      const secondOne = second.find((chunk) => chunk.headingPath[0] === "One")!;
      const secondTwo = second.find((chunk) => chunk.headingPath[0] === "Two")!;

      // Both headings converge back onto the ORIGINAL (surviving, unchanged) concept — never the
      // legacy split-off one, and never a freshly minted third concept.
      expect(secondOne.conceptId).toBe(consolidatedConceptId);
      expect(secondTwo.conceptId).toBe(consolidatedConceptId);

      // The legacy concept is now a genuine orphan: zero active chunks, ready for a one-time sweep
      // to retire it (never automatically retired mid-sync — that decision needs the store-wide
      // "is this concept's last chunk really gone" check the migration script performs).
      expect(f.core.hasActiveSourceChunks(legacyId)).toBe(false);
      expect(f.core.hasActiveSourceChunks(consolidatedConceptId)).toBe(true);

      const body = rawConcept(f.core, consolidatedConceptId).body;
      expect(body).toContain(bigOne.trim());
      expect(body).toContain(bigTwo);
      expect(body).toContain("edited");
    } finally { f.cleanup(); }
  });

  it("stores an observation's content byte-exact, including trailing spaces a full trim would remove (storeSourceChunk regression)", async () => {
    // A store-wide dry-run against real accumulated data (a copy-pasted chat transcript, in
    // particular) hit this: source-chunker.ts's segmentSection strips trailing BLANK LINES and a
    // trailing newline run, but deliberately nothing narrower — trailing spaces on an otherwise
    // real last line survive into the chunk's content. storeSourceChunk (engine.ts) used to store
    // content.trim() for the observation row, silently dropping those spaces — divergent from the
    // exact bytes source-ledger.ts staged and hashed, which source-ledger.ts's
    // validateDurableEngineReceipt then rejected as "observation content does not match the staged
    // normalized content". This proves a section with meaningful trailing whitespace survives a
    // real sync intact, byte-for-byte, in the actual observations row (not just the ledger's own
    // copy — recomputeSourceConceptBody reads from source_chunks, which was never affected; this
    // guards the observation row specifically).
    const f = fixture("trailing-whitespace-content");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      const filler = "padding line to clear the minimum-chunk merge floor\n".repeat(6);
      // Three trailing spaces after "here", before EOF — no trailing newline, so segmentSection's
      // trailing-newline strip cannot remove them either.
      f.commit(`# Notes\n\n${filler}\nsome content here   `, "trailing whitespace in last line");
      const result = await f.core.syncRepoMdSource("repo-source");
      expect(result.status).toBe("published");
      const chunks = f.core.listSourceChunks(result.runId!, true);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content.endsWith("some content here   ")).toBe(true);

      const db = (f.core as unknown as { db: StoragePort }).db;
      const observation = db.prepare(`SELECT content FROM observations WHERE id=?`).get(chunks[0].observationId) as { content: string };
      // The observation's OWN stored content — not just the ledger's copy — must be byte-exact.
      expect(observation.content).toBe(chunks[0].content);
      expect(observation.content.endsWith("some content here   ")).toBe(true);

      const body = rawConcept(f.core, chunks[0].conceptId!).body;
      expect(body.endsWith("some content here   ")).toBe(true);
    } finally { f.cleanup(); }
  });

  it("carries matching chunks through a Git-proven rename with a body edit and preserves staged proof on resume", async () => {
    const f = fixture("rename-edited-multichunk-resume");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      const longBody = "stable line for rename similarity\n".repeat(80);
      f.commit(`# One\n\n${longBody}\n# Two\n\n${longBody}`, "large two-section source");
      const firstResult = await f.core.syncRepoMdSource("repo-source");
      const first = f.core.listSourceChunks(firstResult.runId!, true);
      expect(first).toHaveLength(2);
      git(f.repo, "mv", "README.md", "GUIDE.md");
      writeFileSync(join(f.repo, "GUIDE.md"), `# One\n\n${longBody}\n# Two\n\n${longBody}edited tail\n`);
      git(f.repo, "add", "GUIDE.md"); git(f.repo, "commit", "-m", "rename and edit multi-section source");
      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-stage" && !fired) { fired = true; throw new Error("stage crash"); } },
      })).rejects.toThrow("stage crash");
      const stagedRun = f.core.resumeSourceRun("repo-source")!;
      const stagedBindings = f.core.listSourceChunks(stagedRun.id).map((chunk) => chunk.bindingId).sort();
      expect(stagedBindings).toEqual(first.map((chunk) => chunk.bindingId).sort());
      expect(f.core.sourceStatus("repo-source", { callerId: "caller", projectId: "project" }).dirtyFiles).toBe(2);
      expect((await f.core.syncRepoMdSource("repo-source")).runId).toBe(stagedRun.id);
      const published = f.core.listSourceChunks(stagedRun.id, true);
      expect(published.map((chunk) => chunk.bindingId).sort()).toEqual(stagedBindings);
      expect(published.every((chunk) => chunk.relativePath === "GUIDE.md")).toBe(true);
    } finally { f.cleanup(); }
  });

  it("uses unique whole-file content only as a compatible fallback and rejects ambiguous copies", async () => {
    const f = fixture("rename-content-fallback");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      const firstResult = await f.core.syncRepoMdSource("repo-source");
      const first = f.core.listSourceChunks(firstResult.runId!, true)[0]!;
      git(f.repo, "mv", "README.md", "GUIDE.md"); git(f.repo, "commit", "-m", "fallback rename");
      const fallback = await runRepoMdSync(f.core, "repo-source", {
        sourceStorageDir: f.storage, materializer: { execFile: noRenameDiffExec() },
      });
      expect(f.core.listSourceChunks(fallback.runId!, true)[0]!.bindingId).toBe(first.bindingId);

      // Retaining the old path while adding an identical copy cannot move its exact binding.
      writeFileSync(join(f.repo, "COPY.md"), readFileSync(join(f.repo, "GUIDE.md")));
      git(f.repo, "add", "COPY.md"); git(f.repo, "commit", "-m", "copy source");
      const copied = await runRepoMdSync(f.core, "repo-source", {
        sourceStorageDir: f.storage, materializer: { execFile: noRenameDiffExec() },
      });
      const copiedChunks = f.core.listSourceChunks(copied.runId!, true);
      expect(copiedChunks.find((chunk) => chunk.relativePath === "GUIDE.md")!.bindingId).toBe(first.bindingId);
      expect(copiedChunks.find((chunk) => chunk.relativePath === "COPY.md")!.bindingId).not.toBe(first.bindingId);
    } finally { f.cleanup(); }
  });

  it("requires content fallback uniqueness across both complete selected manifests", async () => {
    const retainedPrior = fixture("rename-global-prior-duplicate");
    try {
      retainedPrior.core.updateSource("repo-source", { include: ["*.md"] });
      const content = readFileSync(join(retainedPrior.repo, "README.md"));
      writeFileSync(join(retainedPrior.repo, "B.md"), content);
      git(retainedPrior.repo, "add", "B.md"); git(retainedPrior.repo, "commit", "-m", "prior duplicate");
      const firstResult = await retainedPrior.core.syncRepoMdSource("repo-source");
      const first = retainedPrior.core.listSourceChunks(firstResult.runId!, true);
      const oldId = first.find((chunk) => chunk.relativePath === "README.md")!.bindingId;
      const retainedId = first.find((chunk) => chunk.relativePath === "B.md")!.bindingId;
      unlinkSync(join(retainedPrior.repo, "README.md")); writeFileSync(join(retainedPrior.repo, "C.md"), content);
      git(retainedPrior.repo, "add", "-A"); git(retainedPrior.repo, "commit", "-m", "delete one duplicate and add another");
      const next = await runRepoMdSync(retainedPrior.core, "repo-source", {
        sourceStorageDir: retainedPrior.storage, materializer: { execFile: noRenameDiffExec() },
      });
      const chunks = retainedPrior.core.listSourceChunks(next.runId!, true);
      expect(chunks.find((chunk) => chunk.relativePath === "B.md")!.bindingId).toBe(retainedId);
      expect(chunks.find((chunk) => chunk.relativePath === "C.md")!.bindingId).not.toBe(oldId);
    } finally { retainedPrior.cleanup(); }

    const retainedNext = fixture("rename-global-next-duplicate");
    try {
      retainedNext.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(retainedNext.repo, "B.md"), "# Other\n\ndifferent bytes\n");
      git(retainedNext.repo, "add", "B.md"); git(retainedNext.repo, "commit", "-m", "distinct retained file");
      const firstResult = await retainedNext.core.syncRepoMdSource("repo-source");
      const first = retainedNext.core.listSourceChunks(firstResult.runId!, true);
      const oldId = first.find((chunk) => chunk.relativePath === "README.md")!.bindingId;
      const content = readFileSync(join(retainedNext.repo, "README.md"));
      unlinkSync(join(retainedNext.repo, "README.md"));
      writeFileSync(join(retainedNext.repo, "B.md"), content); writeFileSync(join(retainedNext.repo, "C.md"), content);
      git(retainedNext.repo, "add", "-A"); git(retainedNext.repo, "commit", "-m", "new-side retained duplicate");
      const next = await runRepoMdSync(retainedNext.core, "repo-source", {
        sourceStorageDir: retainedNext.storage, materializer: { execFile: noRenameDiffExec() },
      });
      expect(retainedNext.core.listSourceChunks(next.runId!, true).every((chunk) => chunk.bindingId !== oldId)).toBe(true);
    } finally { retainedNext.cleanup(); }
  });

  it("keeps unique content fallback beside a case-different retained file and lets Git proof win over duplicate hashes", async () => {
    const unique = fixture("rename-global-case-distinct");
    try {
      unique.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(unique.repo, "B.md"), "# Intro\n\nINITIAL COMMITTED BODY\n");
      git(unique.repo, "add", "B.md"); git(unique.repo, "commit", "-m", "case-distinct retained source");
      const firstResult = await unique.core.syncRepoMdSource("repo-source");
      const first = unique.core.listSourceChunks(firstResult.runId!, true);
      const movedId = first.find((chunk) => chunk.relativePath === "README.md")!.bindingId;
      const retainedId = first.find((chunk) => chunk.relativePath === "B.md")!.bindingId;
      git(unique.repo, "mv", "README.md", "C.md"); git(unique.repo, "commit", "-m", "unique fallback move");
      const next = await runRepoMdSync(unique.core, "repo-source", {
        sourceStorageDir: unique.storage, materializer: { execFile: noRenameDiffExec() },
      });
      const chunks = unique.core.listSourceChunks(next.runId!, true);
      expect(chunks.find((chunk) => chunk.relativePath === "C.md")!.bindingId).toBe(movedId);
      expect(chunks.find((chunk) => chunk.relativePath === "B.md")!.bindingId).toBe(retainedId);
    } finally { unique.cleanup(); }

    const gitProof = fixture("rename-git-over-duplicate-hash");
    try {
      gitProof.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(gitProof.repo, "B.md"), readFileSync(join(gitProof.repo, "README.md")));
      git(gitProof.repo, "add", "B.md"); git(gitProof.repo, "commit", "-m", "duplicate before git move");
      const firstResult = await gitProof.core.syncRepoMdSource("repo-source");
      const first = gitProof.core.listSourceChunks(firstResult.runId!, true);
      const movedId = first.find((chunk) => chunk.relativePath === "README.md")!.bindingId;
      const retainedId = first.find((chunk) => chunk.relativePath === "B.md")!.bindingId;
      git(gitProof.repo, "mv", "README.md", "C.md"); git(gitProof.repo, "commit", "-m", "git-proven duplicate move");
      const next = await gitProof.core.syncRepoMdSource("repo-source");
      const chunks = gitProof.core.listSourceChunks(next.runId!, true);
      expect(chunks.find((chunk) => chunk.relativePath === "C.md")!.bindingId).toBe(movedId);
      expect(chunks.find((chunk) => chunk.relativePath === "B.md")!.bindingId).toBe(retainedId);
    } finally { gitProof.cleanup(); }
  });

  it("disables fallback on config drift and all changed-identity carry on parser incompatibility", async () => {
    const config = fixture("rename-config-incompatible");
    try {
      config.core.updateSource("repo-source", { include: ["*.md"] });
      const firstResult = await config.core.syncRepoMdSource("repo-source");
      const first = config.core.listSourceChunks(firstResult.runId!, true)[0]!;
      git(config.repo, "mv", "README.md", "GUIDE.md"); git(config.repo, "commit", "-m", "config rename");
      config.core.updateSource("repo-source", { exclude: ["NEVER.md"] });
      const changed = await runRepoMdSync(config.core, "repo-source", {
        sourceStorageDir: config.storage, materializer: { execFile: noRenameDiffExec() },
      });
      expect(config.core.listSourceChunks(changed.runId!, true)[0]!.bindingId).not.toBe(first.bindingId);
    } finally { config.cleanup(); }

    const parser = fixture("rename-parser-incompatible");
    try {
      parser.core.updateSource("repo-source", { include: ["*.md"] });
      const firstResult = await parser.core.syncRepoMdSource("repo-source");
      const first = parser.core.listSourceChunks(firstResult.runId!, true)[0]!;
      const db = (parser.core as unknown as { db: StoragePort }).db;
      db.prepare(`UPDATE source_sync_runs SET scan_config_version='legacy/incompatible' WHERE id=?`).run(firstResult.runId!);
      git(parser.repo, "mv", "README.md", "GUIDE.md"); git(parser.repo, "commit", "-m", "parser rename");
      const changed = await parser.core.syncRepoMdSource("repo-source");
      expect(parser.core.listSourceChunks(changed.runId!, true)[0]!.bindingId).not.toBe(first.bindingId);
    } finally { parser.cleanup(); }
  });

  it("rejects one-to-many, many-to-one, and many-to-many duplicate-content fallback", async () => {
    const f = fixture("rename-content-ambiguity");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      const firstResult = await f.core.syncRepoMdSource("repo-source");
      const firstId = f.core.listSourceChunks(firstResult.runId!, true)[0]!.bindingId;
      const content = readFileSync(join(f.repo, "README.md"));
      unlinkSync(join(f.repo, "README.md"));
      writeFileSync(join(f.repo, "A.md"), content); writeFileSync(join(f.repo, "B.md"), content);
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "one to two duplicate files");
      const oneToTwo = await runRepoMdSync(f.core, "repo-source", {
        sourceStorageDir: f.storage, materializer: { execFile: noRenameDiffExec() },
      });
      const pair = f.core.listSourceChunks(oneToTwo.runId!, true);
      expect(pair.every((chunk) => chunk.bindingId !== firstId)).toBe(true);

      unlinkSync(join(f.repo, "A.md")); unlinkSync(join(f.repo, "B.md")); writeFileSync(join(f.repo, "C.md"), content);
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "two to one duplicate file");
      const twoToOne = await runRepoMdSync(f.core, "repo-source", {
        sourceStorageDir: f.storage, materializer: { execFile: noRenameDiffExec() },
      });
      const singleId = f.core.listSourceChunks(twoToOne.runId!, true)[0]!.bindingId;
      expect(pair.some((chunk) => chunk.bindingId === singleId)).toBe(false);

      unlinkSync(join(f.repo, "C.md"));
      for (const name of ["D.md", "E.md"]) writeFileSync(join(f.repo, name), content);
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "prepare many side");
      const prepared = await runRepoMdSync(f.core, "repo-source", {
        sourceStorageDir: f.storage, materializer: { execFile: noRenameDiffExec() },
      });
      const beforeMany = f.core.listSourceChunks(prepared.runId!, true).map((chunk) => chunk.bindingId);
      unlinkSync(join(f.repo, "D.md")); unlinkSync(join(f.repo, "E.md"));
      for (const name of ["F.md", "G.md"]) writeFileSync(join(f.repo, name), content);
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "many to many duplicate files");
      const many = await runRepoMdSync(f.core, "repo-source", {
        sourceStorageDir: f.storage, materializer: { execFile: noRenameDiffExec() },
      });
      expect(f.core.listSourceChunks(many.runId!, true).every((chunk) => !beforeMany.includes(chunk.bindingId))).toBe(true);
    } finally { f.cleanup(); }
  });

  it("rejects a symlinked managed source root without touching its victim", async () => {
    const f = fixture("symlink-source-root");
    try {
      const managedRepo = join(f.storage, "repo-md");
      const victim = join(f.root, "victim-source-root");
      const variant = `${"a".repeat(40)}-${"b".repeat(64)}`;
      mkdirSync(join(victim, "snapshots", variant), { recursive: true });
      writeFileSync(join(victim, "sentinel.txt"), "victim bytes\n");
      writeFileSync(join(victim, "snapshots", variant, "README.md"), "victim snapshot\n");
      symlinkSync(join("snapshots", variant), join(victim, "current"), "dir");
      mkdirSync(managedRepo, { recursive: true });
      symlinkSync(victim, join(managedRepo, "repo-source"), "dir");

      await expect(f.core.syncRepoMdSource("repo-source")).rejects.toThrow(/source root.*real directory/);
      f.core.removeSource("repo-source");
      await expect(f.core.syncRepoMdSource("repo-source")).rejects.toThrow(/source root.*real directory/);
      expect(readFileSync(join(victim, "sentinel.txt"), "utf8")).toBe("victim bytes\n");
      expect(readFileSync(join(victim, "snapshots", variant, "README.md"), "utf8")).toBe("victim snapshot\n");
      expect(readlinkSync(join(victim, "current"))).toBe(join("snapshots", variant));
    } finally { f.cleanup(); }
  });

  it("rejects a symlinked managed repo-md parent without touching its victim", async () => {
    const f = fixture("symlink-repo-root");
    try {
      const victim = join(f.root, "victim-repo-root");
      mkdirSync(victim, { recursive: true });
      writeFileSync(join(victim, "sentinel.txt"), "repo victim bytes\n");
      mkdirSync(f.storage, { recursive: true });
      symlinkSync(victim, join(f.storage, "repo-md"), "dir");

      await expect(f.core.syncRepoMdSource("repo-source")).rejects.toThrow(/repo-md root.*real directory/);
      f.core.removeSource("repo-source");
      await expect(f.core.syncRepoMdSource("repo-source")).rejects.toThrow(/repo-md root.*real directory/);
      expect(readFileSync(join(victim, "sentinel.txt"), "utf8")).toBe("repo victim bytes\n");
      expect(readdirSync(victim)).toEqual(["sentinel.txt"]);
    } finally { f.cleanup(); }
  });

  it("removes a managed hardlink without chmodding its external victim inode", async () => {
    const f = fixture("managed-hardlink-victim");
    try {
      await f.core.syncRepoMdSource("repo-source");
      const current = join(f.storage, "repo-md", "repo-source", "current");
      const snapshot = resolve(dirname(current), readlinkSync(current));
      const victim = join(f.repo, "VICTIM.bin");
      writeFileSync(victim, "external victim bytes\n", { mode: 0o444 });
      chmodSync(snapshot, 0o700);
      linkSync(victim, join(snapshot, "HARDLINK.bin"));
      chmodSync(snapshot, 0o500);
      const contentBefore = readFileSync(victim);
      const before = statSync(victim);

      f.core.removeSource("repo-source");
      expect(await f.core.syncRepoMdSource("repo-source")).toMatchObject({ status: "removed" });
      const after = statSync(victim);
      expect(readFileSync(victim)).toEqual(contentBefore);
      expect(after.mode & 0o777).toBe(before.mode & 0o777);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.atimeMs).toBe(before.atimeMs);
      expect(existsSync(join(f.storage, "repo-md", "repo-source"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("publishes a same-HEAD config variant and points current at the activated variant", async () => {
    const f = fixture("same-head-config");
    try {
      writeFileSync(join(f.repo, "EXTRA.md"), "# Extra\n\nextra body\n");
      git(f.repo, "add", "EXTRA.md"); git(f.repo, "commit", "-m", "extra at pinned head");
      const first = await f.core.syncRepoMdSource("repo-source");
      const firstSource = f.core.getSource("repo-source")!;
      const firstVariant = join(
        f.storage, "repo-md", "repo-source", "snapshots",
        `${first.snapshotId!}-${firstSource.activeIngestConfigHash!.slice(-64)}`,
      );
      expect(f.core.listSourceFiles(firstSource.activeRunId!, true).map((file) => file.relativePath)).toEqual(["README.md"]);

      f.core.updateSource("repo-source", { include: ["**"] });
      const second = await f.core.syncRepoMdSource("repo-source");
      const secondSource = f.core.getSource("repo-source")!;
      const secondVariant = join(
        f.storage, "repo-md", "repo-source", "snapshots",
        `${second.snapshotId!}-${secondSource.activeIngestConfigHash!.slice(-64)}`,
      );
      expect(second.status).toBe("published");
      expect(second.snapshotId).toBe(first.snapshotId);
      expect(second.runId).not.toBe(first.runId);
      expect(secondVariant).not.toBe(firstVariant);
      expect(existsSync(firstVariant)).toBe(true);
      expect(existsSync(secondVariant)).toBe(true);
      expect(f.core.listSourceFiles(secondSource.activeRunId!, true).map((file) => file.relativePath).sort()).toEqual(["EXTRA.md", "README.md"]);
      const current = join(f.storage, "repo-md", "repo-source", "current");
      expect(resolve(dirname(current), readlinkSync(current))).toBe(secondVariant);
    } finally { f.cleanup(); }
  });

  it("authenticates exact repo-md active state and repairs missing or wrong current under its stored identity", async () => {
    const f = fixture("repo-active-current-repair");
    try {
      const first = await f.core.syncRepoMdSource("repo-source");
      const source = f.core.getSource("repo-source")!;
      const current = join(f.storage, "repo-md", "repo-source", "current");
      const storedTarget = readlinkSync(current);
      await expect(f.core.syncRepoMdSource("repo-source")).resolves.toMatchObject({ status: "noop", runId: null });

      rmSync(current);
      await expect(f.core.syncRepoMdSource("repo-source")).resolves.toMatchObject({ status: "noop", runId: null });
      expect(readlinkSync(current)).toBe(storedTarget);

      rmSync(current);
      symlinkSync(join("snapshots", `${"0".repeat(40)}-${"0".repeat(64)}`), current, "dir");
      await expect(f.core.syncRepoMdSource("repo-source")).resolves.toMatchObject({ status: "noop", runId: null });
      expect(readlinkSync(current)).toBe(storedTarget);
      expect(f.core.getSource("repo-source")).toMatchObject({
        activeRunId: first.runId,
        activeSnapshotId: first.snapshotId,
        activeIngestConfigHash: source.activeIngestConfigHash,
      });
    } finally { f.cleanup(); }
  });

  it("repairs repo-md's shipped non-Markdown strict superset and restores the old pair across interruption", async () => {
    const f = fixture("repo-strict-superset-repair");
    try {
      const image = Buffer.alloc(2048, 7);
      writeFileSync(join(f.repo, "IMAGE.png"), image);
      git(f.repo, "add", "IMAGE.png"); git(f.repo, "commit", "-m", "mixed source");
      f.core.updateSource("repo-source", { include: ["**"] });
      const first = await f.core.syncRepoMdSource("repo-source");
      const active = f.core.getSource("repo-source")!;
      const current = join(f.storage, "repo-md", "repo-source", "current");
      const target = readlinkSync(current);
      const snapshot = resolve(dirname(current), target);
      addFileToRepoSnapshot(snapshot, "IMAGE.png", image);

      let interrupted = false;
      await expect(f.core.syncRepoMdSource("repo-source", { materializer: { fault: (point) => {
        if (point === "before-sidecar-rename" && !interrupted) {
          interrupted = true;
          throw new Error("interrupt repo active repair split pair");
        }
      } } })).rejects.toThrow("interrupt repo active repair split pair");
      expect(readlinkSync(current)).toBe(target);
      expect(readFileSync(join(snapshot, "IMAGE.png"))).toEqual(image);
      expect(f.core.getSource("repo-source")).toMatchObject({
        activeRunId: active.activeRunId,
        activeSnapshotId: active.activeSnapshotId,
        activeIngestConfigHash: active.activeIngestConfigHash,
      });

      await expect(f.core.syncRepoMdSource("repo-source")).resolves.toMatchObject({
        status: "noop", runId: null, snapshotId: first.snapshotId,
      });
      expect(readlinkSync(current)).toBe(target);
      expect(existsSync(join(resolve(dirname(current), readlinkSync(current)), "IMAGE.png"))).toBe(false);
      expect(f.core.getSource("repo-source")).toMatchObject({ activeRunId: active.activeRunId });
    } finally { f.cleanup(); }
  });

  it("fails repo-md active repair closed for extra Markdown, missing accepted bytes, or accepted hash conflict", async () => {
    for (const mutation of ["extra-markdown", "missing-accepted", "accepted-conflict"] as const) {
      const f = fixture(`repo-active-repair-${mutation}`);
      try {
        const first = await f.core.syncRepoMdSource("repo-source");
        const active = f.core.getSource("repo-source")!;
        const current = join(f.storage, "repo-md", "repo-source", "current");
        const snapshot = resolve(dirname(current), readlinkSync(current));
        if (mutation === "extra-markdown") {
          addFileToRepoSnapshot(snapshot, "EXTRA.md", Buffer.from("# Extra\n\nnot in ledger\n"));
        } else if (mutation === "missing-accepted") {
          addFileToRepoSnapshot(snapshot, "IMAGE.png", Buffer.alloc(32, 1));
          mutateSealedRepoSnapshot(snapshot, (marker) => {
            rmSync(join(snapshot, "README.md"));
            marker.files = marker.files.filter((file) => file.path !== "README.md");
          });
        } else {
          addFileToRepoSnapshot(snapshot, "IMAGE.png", Buffer.alloc(32, 1));
          rewriteRepoSnapshotFile(snapshot, "README.md", Buffer.from("# Forged\n\nconflict\n"));
        }
        const verificationBefore = sourceAttemptState(f.core, "repo-source").verification;
        await expect(f.core.syncRepoMdSource("repo-source")).rejects.toThrow(/ledger|snapshot|strict-superset/i);
        expect(sourceAttemptState(f.core, "repo-source").verification).toBe(verificationBefore);
        expect(f.core.getSource("repo-source")).toMatchObject({
          activeRunId: first.runId,
          activeSnapshotId: first.snapshotId,
          activeIngestConfigHash: active.activeIngestConfigHash,
        });
      } finally { f.cleanup(); }
    }
  });

  it("repairs stored repo-md publication before a missing local clone fails without freshness verification", async () => {
    const f = fixture("repo-missing-local-after-repair");
    try {
      await f.core.syncRepoMdSource("repo-source");
      const current = join(f.storage, "repo-md", "repo-source", "current");
      const target = readlinkSync(current);
      rmSync(current);
      renameSync(f.repo, `${f.repo}-missing`);
      const verificationBefore = sourceAttemptState(f.core, "repo-source").verification;

      await expect(f.core.syncRepoMdSource("repo-source")).rejects.toThrow(/ENOENT|no such file|repository/i);
      expect(readlinkSync(current)).toBe(target);
      expect(readFileSync(join(f.core.sourcePath("repo-source", { callerId: "caller", projectId: "project" }).path, "README.md"), "utf8"))
        .toContain("initial committed body");
      expect(sourceAttemptState(f.core, "repo-source").verification).toBe(verificationBefore);
    } finally { f.cleanup(); }
  });

  it("migrates a genuine old repo-md publication identity through a current-hash candidate atomically", async () => {
    const f = fixture("repo-old-publication-migration");
    try {
      const first = await f.core.syncRepoMdSource("repo-source");
      const oldHash = `monet-src-ingest-config/v1:sha256:${"1".repeat(64)}`;
      const { oldVariant, currentHash } = synthesizeOldRepoPublicationIdentity(f, oldHash);
      const current = join(f.storage, "repo-md", "repo-source", "current");
      const oldTarget = readlinkSync(current);
      let interrupted = false;
      await expect(f.core.syncRepoMdSource("repo-source", { fault: (point) => {
        if (point === "after-stage" && !interrupted) {
          interrupted = true;
          throw new Error("interrupt current-hash candidate");
        }
      } })).rejects.toThrow("interrupt current-hash candidate");
      expect(readlinkSync(current)).toBe(oldTarget);
      expect(resolve(dirname(current), oldTarget)).toBe(oldVariant);
      expect(f.core.getSource("repo-source")).toMatchObject({
        activeRunId: first.runId,
        activeSnapshotId: first.snapshotId,
        activeIngestConfigHash: oldHash,
      });

      const migrated = await f.core.syncRepoMdSource("repo-source");
      expect(migrated.status).toBe("published");
      expect(migrated.runId).not.toBe(first.runId);
      expect(f.core.getSource("repo-source")!.activeIngestConfigHash).toBe(currentHash);
      expect(readlinkSync(current)).toContain(currentHash.slice(-64));
      expect(existsSync(oldVariant)).toBe(true);
    } finally { f.cleanup(); }
  });

  it("rejects corrupt canonical published files on unchanged repo-md without recording verification", async () => {
    const f = fixture("repo-published-ledger-corruption");
    try {
      const first = await f.core.syncRepoMdSource("repo-source");
      const activeBefore = f.core.getSource("repo-source")!;
      const attemptsBefore = sourceAttemptState(f.core, "repo-source");
      const db = (f.core as unknown as { db: StoragePort }).db;
      db.prepare(`UPDATE source_files SET content_hash=? WHERE run_id=? AND relative_path=?`)
        .run(`monet-src-content/v1:sha256:${"0".repeat(64)}`, first.runId, "README.md");

      await expect(f.core.syncRepoMdSource("repo-source")).rejects.toThrow(/active publication file manifest is corrupt/i);
      expect(sourceAttemptState(f.core, "repo-source").verification).toBe(attemptsBefore.verification);
      expect(f.core.getSource("repo-source")).toMatchObject({
        activeRunId: activeBefore.activeRunId,
        activeSnapshotId: activeBefore.activeSnapshotId,
        activeIngestConfigHash: activeBefore.activeIngestConfigHash,
      });
    } finally { f.cleanup(); }
  });

  it("rebuilds a scanning resume from the run's persisted config variant, not mutable registry config", async () => {
    const f = fixture("resume-config-variant");
    try {
      writeFileSync(join(f.repo, "EXTRA.md"), "# Extra\n\npersisted variant body\n");
      git(f.repo, "add", "EXTRA.md"); git(f.repo, "commit", "-m", "resume config fixture");
      await f.core.syncRepoMdSource("repo-source");
      f.core.updateSource("repo-source", { include: ["**"] });
      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-begin" && !fired) { fired = true; throw new Error("begin crash"); } },
      })).rejects.toThrow("begin crash");
      const run = f.core.resumeSourceRun("repo-source")!;
      expect(run.state).toBe("scanning");
      const persistedVariant = join(
        f.storage, "repo-md", "repo-source", "snapshots", `${run.snapshotId}-${run.ingestConfigHash.slice(-64)}`,
      );
      makeWritable(persistedVariant);
      rmSync(persistedVariant, { recursive: true });
      rmSync(`${persistedVariant}.complete.json`);

      f.core.updateSource("repo-source", { include: ["EXTRA.md"] });
      expect((await f.core.syncRepoMdSource("repo-source")).status).toBe("aborted");
      expect(readdirSync(persistedVariant).sort()).toEqual(["EXTRA.md", "README.md"]);
      expect(existsSync(`${persistedVariant}.complete.json`)).toBe(true);
    } finally { f.cleanup(); }
  });

  for (const [point, strandedState] of [
    ["after-store", "staging"], ["after-engine-written", "staging"],
    ["after-refresh", "staging"], ["after-activation", "activating"],
  ] as Array<[RepoMdSyncFaultPoint, "staging" | "activating"]>) {
    it(`recovers existing ${point} evidence after the source is removed without publishing`, async () => {
      const f = fixture(`removed-${point}`);
      try {
        await f.core.syncRepoMdSource("repo-source");
        const activeBefore = f.core.getSource("repo-source")!;
        const prior = f.core.listSourceChunks(activeBefore.activeRunId!, true)[0]!;
        const current = join(f.storage, "repo-md", "repo-source", "current");
        f.commit(`# Intro\n\nremoved ${point} mutation\n`, point);
        let fired = false;
        await expect(f.core.syncRepoMdSource("repo-source", {
          fault: (seen) => { if (seen === point && !fired) { fired = true; throw new Error(`fault:${point}`); } },
        })).rejects.toThrow(`fault:${point}`);
        const stranded = f.core.resumeSourceRun("repo-source")!;
        expect(stranded.state).toBe(strandedState);
        const runCount = f.core.listSourceRuns("repo-source").length;

        expect(f.core.removeSource("repo-source")!.lifecycle).toBe("tombstoned");
        const recovered = await f.core.syncRepoMdSource("repo-source");
        expect(recovered).toMatchObject({ status: "removed", runId: activeBefore.activeRunId });
        expect(f.core.resumeSourceRun("repo-source")).toBeNull();
        expect(f.core.listSourceCleanupItems(stranded.id).every((item) => item.acknowledgedAt !== null)).toBe(true);
        expect(f.core.listSourceRuns("repo-source")).toHaveLength(runCount);
        expect(rawConcept(f.core, prior.conceptId!)).toMatchObject({ status: "retired", active_observation_id: null });
        expect(existsSync(current)).toBe(false);
        expect(f.core.getSource("repo-source", { includeTombstoned: true })).toMatchObject({
          lifecycle: "tombstoned", activeRunId: null, activeSnapshotId: null,
        });
        expect(await f.core.syncRepoMdSource("repo-source")).toMatchObject({ status: "removed", runId: activeBefore.activeRunId });
      } finally { f.cleanup(); }
    });
  }

  it("recovers an engine-written binding whose predecessor belongs to a DIFFERENT concept during removal recovery (round 4, Codex thread 6)", async () => {
    // Mirrors materializeStagedBindings' own cross-concept branch (the legacy-split-heal test
    // above), but for reconcileExistingStagedBindings — the parallel path removal recovery takes
    // for a binding stranded in "engine-written" state. Pre-fix this called the same-concept CAS
    // (supersedeSourceChunkObservation) unconditionally, which throws when the predecessor
    // belongs to a different concept than the just-written successor — wedging removal on exactly
    // the binding recovery exists to unblock.
    const f = fixture("removed-cross-concept-predecessor");
    try {
      // Each section body must clear MIN_SOURCE_SECTION_BYTES (200) or the minimum-chunk merge
      // pass folds Alpha and Zulu into one chunk and this test's two-chunks premise breaks.
      const alphaBody = "alpha padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      const zuluBody = "zulu padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      const zuluBodyEdited = "zulu EDITED padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      f.commit(`# Alpha\n\n${alphaBody}\n\n# Zulu\n\n${zuluBody}\n`, "two sections");
      await f.core.syncRepoMdSource("repo-source");
      const activeBefore = f.core.getSource("repo-source")!;
      const chunksBefore = f.core.listSourceChunks(activeBefore.activeRunId!, true);
      const alpha = chunksBefore.find((c) => JSON.stringify(c.headingPath) === JSON.stringify(["Alpha"]))!;
      const zulu = chunksBefore.find((c) => JSON.stringify(c.headingPath) === JSON.stringify(["Zulu"]))!;
      expect(alpha.conceptId).toBe(zulu.conceptId); // sanity: file=concept, one concept for both

      // Simulate a legacy (pre-consolidation) shape: Zulu's chunk sits on its own separate concept.
      const legacy = await f.core.storeSource("legacy standalone chunk content", {
        circle: "repo", sourceRefs: [zulu.sourceRef], resolution: "forceNew",
      });
      const db = (f.core as unknown as { db: StoragePort }).db;
      db.prepare(`UPDATE source_chunks SET concept_id = ? WHERE run_id = ? AND binding_id = ?`)
        .run(legacy.conceptId, activeBefore.activeRunId, zulu.bindingId);
      db.prepare(`UPDATE observations SET concept_id = ? WHERE id = ?`).run(legacy.conceptId, zulu.observationId);

      // Change ONLY Zulu's content — Alpha stays byte-identical and sorts first, so
      // fileConceptThisRun resolves via Alpha's own prior (the ORIGINAL concept). Zulu's binding
      // then engine-writes its successor under the ORIGINAL concept while its OWN predecessor
      // observation (moved above) still belongs to the legacy concept — the exact cross-concept
      // shape. Faulting right after "after-engine-written" strands it there, before the
      // supersession call (whichever branch) would normally run.
      f.commit(`# Alpha\n\n${alphaBody}\n\n# Zulu\n\n${zuluBodyEdited}\n`, "edit zulu only");
      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-engine-written" && !fired) { fired = true; throw new Error("crash before refresh"); } },
      })).rejects.toThrow("crash before refresh");
      const stranded = f.core.resumeSourceRun("repo-source")!;
      expect(stranded.state).toBe("staging");
      const strandedZulu = f.core.listSourceChunks(stranded.id).find((c) => JSON.stringify(c.headingPath) === JSON.stringify(["Zulu"]))!;
      expect(strandedZulu.writeState).toBe("engine-written");
      expect(strandedZulu.conceptId).toBe(alpha.conceptId); // wrote to the ORIGINAL/winning concept
      expect(strandedZulu.predecessorObservationId).toBe(zulu.observationId); // predecessor still on the LEGACY concept

      // Tombstone the source while stuck mid-staging — recovery must reconcile this binding, not
      // throw and wedge removal.
      expect(f.core.removeSource("repo-source")!.lifecycle).toBe("tombstoned");
      const recovered = await f.core.syncRepoMdSource("repo-source");
      expect(recovered).toMatchObject({ status: "removed" });
      expect(f.core.resumeSourceRun("repo-source")).toBeNull();
      expect(rawConcept(f.core, alpha.conceptId!)).toMatchObject({ status: "retired" });
    } finally { f.cleanup(); }
  });

  it("keeps a legacy predecessor's content authorized-readable through the entire staging window of its own consolidation (round 5, Codex thread R5-4)", async () => {
    // The exact gap: materializeStagedBindings used to terminally supersede a cross-concept
    // predecessor's observation EAGERLY, mid-materialize — well before this run durably publishes
    // (source.active_run_id still points at the PRIOR run for the entire staging window).
    // queryAuthorizedSourcePublications joins against source.active_run_id, so an eagerly-killed
    // predecessor's still-genuinely-published content went invisible to every authorized read
    // (memory_fetch/search/gather) for as long as staging took — permanently if the run then
    // aborted before publishing. Fixed by deferring the retirement to publishRun itself (the
    // transaction that actually advances active_run_id) instead of doing it at materialize time.
    const f = fixture("legacy-predecessor-visibility");
    try {
      const alphaBody = "alpha padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      const zuluBody = "zulu padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      const zuluBodyEdited = "zulu EDITED padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      f.commit(`# Alpha\n\n${alphaBody}\n\n# Zulu\n\n${zuluBody}\n`, "two sections");
      await f.core.syncRepoMdSource("repo-source");
      const activeBefore = f.core.getSource("repo-source")!;
      const chunksBefore = f.core.listSourceChunks(activeBefore.activeRunId!, true);
      const zulu = chunksBefore.find((c) => JSON.stringify(c.headingPath) === JSON.stringify(["Zulu"]))!;

      const legacy = await f.core.storeSource("legacy standalone chunk content", {
        circle: "repo-source", sourceRefs: [zulu.sourceRef], resolution: "forceNew",
      });
      const db = (f.core as unknown as { db: StoragePort }).db;
      db.prepare(`UPDATE source_chunks SET concept_id = ? WHERE run_id = ? AND binding_id = ?`)
        .run(legacy.conceptId, activeBefore.activeRunId, zulu.bindingId);
      db.prepare(`UPDATE observations SET concept_id = ? WHERE id = ?`).run(legacy.conceptId, zulu.observationId);
      // Sanity: authorized before the consolidating sync even starts.
      expect(await f.core.getConcept(legacy.conceptId, { sourceAuthorizationContext: { callerId: "caller", projectId: "project" } })).not.toBeNull();

      // A THIRD sync edits Zulu only, resolving fileConceptThisRun via Alpha's own (unchanged,
      // sorts-first) prior concept — the winning target — while Zulu's predecessor observation
      // (moved above) still belongs to the legacy concept. Fault right after materialize commits
      // this exact binding — pre-fix, this is the EXACT point the predecessor used to die.
      f.commit(`# Alpha\n\n${alphaBody}\n\n# Zulu\n\n${zuluBodyEdited}\n`, "edit zulu only");
      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-committed" && !fired) { fired = true; throw new Error("crash after materialize commits zulu"); } },
      })).rejects.toThrow("crash after materialize commits zulu");

      // The run has NOT published — source.active_run_id is still the FIRST run.
      const stillStaging = f.core.getSource("repo-source")!;
      expect(stillStaging.activeRunId).toBe(activeBefore.activeRunId);
      const resumable = f.core.resumeSourceRun("repo-source")!;
      expect(resumable.state).toBe("staging");

      // THE KEY ASSERTION: the legacy concept's content is STILL authorized-readable — not a
      // visibility gap where neither the old nor the new copy is readable.
      expect(await f.core.getConcept(legacy.conceptId, { sourceAuthorizationContext: { callerId: "caller", projectId: "project" } })).not.toBeNull();
      expect((await f.core.search("legacy standalone", { circle: "repo-source", sourceAuthorizationContext: { callerId: "caller", projectId: "project" } })).map((r) => r.id)).toContain(legacy.conceptId);

      // Resuming and letting it publish converges cleanly: the legacy concept's chunk is no
      // longer active (publishRun's own bulk sweep + the new cross-concept retirement both fire
      // atomically in the SAME transaction that advances active_run_id).
      const recovered = await f.core.syncRepoMdSource("repo-source");
      expect(recovered.status).toBe("published");
      expect(f.core.hasActiveSourceChunks(legacy.conceptId)).toBe(false);
    } finally { f.cleanup(); }
  });

  it("recovers cleanly from a crash mid-drain during tombstoned removal of a cross-concept binding, without a durable half-applied state (round 5, Codex thread R5-6)", async () => {
    // Round 4's fix deferred the cross-concept predecessor's chunk-lifecycle flip to an in-memory
    // list applied AFTER drainCleanup finished — a crash between drainCleanup acknowledging its
    // cleanup items and that list being applied lost the list for good, leaving a chunk
    // permanently pointing at a dead observation with nothing durable left to heal it, wedging
    // every future removal attempt (beginRemoval's exact-ownership check would throw forever).
    // Round 5 closes this by never creating anything that needs a durable-vs-in-memory distinction
    // in the first place: a cross-concept predecessor during removal recovery is left completely
    // untouched (see reconcileExistingStagedBindings' own docstring) — there is nothing to lose.
    const f = fixture("removed-cross-concept-crash-mid-drain");
    try {
      const alphaBody = "alpha padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      const zuluBody = "zulu padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      const zuluBodyEdited = "zulu EDITED padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      f.commit(`# Alpha\n\n${alphaBody}\n\n# Zulu\n\n${zuluBody}\n`, "two sections");
      await f.core.syncRepoMdSource("repo-source");
      const activeBefore = f.core.getSource("repo-source")!;
      const chunksBefore = f.core.listSourceChunks(activeBefore.activeRunId!, true);
      const alpha = chunksBefore.find((c) => JSON.stringify(c.headingPath) === JSON.stringify(["Alpha"]))!;
      const zulu = chunksBefore.find((c) => JSON.stringify(c.headingPath) === JSON.stringify(["Zulu"]))!;

      const legacy = await f.core.storeSource("legacy standalone chunk content", {
        circle: "repo-source", sourceRefs: [zulu.sourceRef], resolution: "forceNew",
      });
      const db = (f.core as unknown as { db: StoragePort }).db;
      db.prepare(`UPDATE source_chunks SET concept_id = ? WHERE run_id = ? AND binding_id = ?`)
        .run(legacy.conceptId, activeBefore.activeRunId, zulu.bindingId);
      db.prepare(`UPDATE observations SET concept_id = ? WHERE id = ?`).run(legacy.conceptId, zulu.observationId);

      f.commit(`# Alpha\n\n${alphaBody}\n\n# Zulu\n\n${zuluBodyEdited}\n`, "edit zulu only");
      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-engine-written" && !fired) { fired = true; throw new Error("crash before refresh"); } },
      })).rejects.toThrow("crash before refresh");
      expect(f.core.resumeSourceRun("repo-source")!.state).toBe("staging");

      // Tombstone, then crash a SECOND time — this time mid-drainCleanup, right after its cleanup
      // item(s) are acknowledged (the exact crash window R5-6 named: after ack, before whatever
      // would apply the compensating chunk-lifecycle flip).
      expect(f.core.removeSource("repo-source")!.lifecycle).toBe("tombstoned");
      let firedDrain = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-cleanup" && !firedDrain) { firedDrain = true; throw new Error("crash mid-drain"); } },
      })).rejects.toThrow("crash mid-drain");

      // The run is left in whatever state drainCleanup's own crash-recovery already guarantees —
      // the load-bearing assertion is what happens NEXT: a third attempt must fully converge, not
      // wedge on a stale (chunk, observation) inconsistency beginRemoval would reject forever.
      const recovered = await f.core.syncRepoMdSource("repo-source");
      expect(recovered).toMatchObject({ status: "removed" });
      expect(f.core.resumeSourceRun("repo-source")).toBeNull();
      expect(rawConcept(f.core, alpha.conceptId!)).toMatchObject({ status: "retired" });
      expect(rawConcept(f.core, legacy.conceptId)).toMatchObject({ status: "retired" });
    } finally { f.cleanup(); }
  });

  it("aborts a removed scanning run without scanning or creating evidence", async () => {
    const f = fixture("removed-scanning");
    try {
      await f.core.syncRepoMdSource("repo-source");
      const activeBefore = f.core.getSource("repo-source")!;
      const prior = f.core.listSourceChunks(activeBefore.activeRunId!, true)[0]!;
      f.commit("# Intro\n\nnever scanned after removal\n", "removed scan");
      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-begin" && !fired) { fired = true; throw new Error("scanning crash"); } },
      })).rejects.toThrow("scanning crash");
      const scanning = f.core.resumeSourceRun("repo-source")!;
      expect(scanning.state).toBe("scanning");
      const runCount = f.core.listSourceRuns("repo-source").length;
      f.core.removeSource("repo-source");
      expect(await f.core.syncRepoMdSource("repo-source")).toMatchObject({ status: "removed", runId: activeBefore.activeRunId });
      expect(f.core.listSourceChunks(scanning.id)).toEqual([]);
      expect(f.core.listSourceCleanupItems(scanning.id)).toEqual([]);
      expect(f.core.listSourceRuns("repo-source")).toHaveLength(runCount);
      expect(rawConcept(f.core, prior.conceptId!)).toMatchObject({ status: "retired", active_observation_id: null });
    } finally { f.cleanup(); }
  });

  it("drains published retire-absent cleanup after removal without advancing current or starting a run", async () => {
    const f = fixture("removed-cleaning");
    try {
      await f.core.syncRepoMdSource("repo-source");
      const priorRun = f.core.getSource("repo-source")!.activeRunId!;
      const prior = f.core.listSourceChunks(priorRun, true)[0]!;
      unlinkSync(join(f.repo, "README.md"));
      git(f.repo, "add", "-u"); git(f.repo, "commit", "-m", "remove before cleanup");
      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-publish" && !fired) { fired = true; throw new Error("published before removal"); } },
      })).rejects.toThrow("published before removal");
      const cleaning = f.core.resumeSourceRun("repo-source")!;
      expect(cleaning.state).toBe("cleaning");
      const runCount = f.core.listSourceRuns("repo-source").length;
      const current = join(f.storage, "repo-md", "repo-source", "current");

      f.core.removeSource("repo-source");
      const recovered = await f.core.syncRepoMdSource("repo-source");
      expect(recovered).toMatchObject({ status: "removed", runId: cleaning.id });
      expect(f.core.resumeSourceRun("repo-source")).toBeNull();
      expect(f.core.listSourceCleanupItems(cleaning.id).every((item) => item.acknowledgedAt !== null)).toBe(true);
      expect(f.core.listSourceRuns("repo-source")).toHaveLength(runCount);
      expect(rawConcept(f.core, prior.conceptId!)).toMatchObject({ status: "retired", active_observation_id: null });
      expect(f.core.listSourceChunks(priorRun, true)[0]!.lifecycle).toBe("deleted");
      expect(existsSync(current)).toBe(false);
      expect(await f.core.syncRepoMdSource("repo-source")).toMatchObject({ status: "removed", runId: cleaning.id });
    } finally { f.cleanup(); }
  });

  it("durably removes every published binding and managed variant across each crash boundary", async () => {
    const f = fixture("whole-removal-crashes");
    let core = f.core;
    try {
      writeFileSync(join(f.repo, "SECOND.md"), "# Second\n\nsecond published body\n");
      git(f.repo, "add", "SECOND.md"); git(f.repo, "commit", "-m", "second binding");
      core.updateSource("repo-source", { include: ["*.md"] });
      await core.syncRepoMdSource("repo-source");
      const active = core.getSource("repo-source")!;
      const chunks = core.listSourceChunks(active.activeRunId!, true);
      expect(chunks).toHaveLength(2);
      const runCount = core.listSourceRuns("repo-source").length;
      const readme = readFileSync(join(f.repo, "README.md"), "utf8");
      const second = readFileSync(join(f.repo, "SECOND.md"), "utf8");
      core.removeSource("repo-source");

      const reopen = (): void => {
        core.close();
        core = new MonetCore(f.db, { sourceStorageDir: f.storage });
      };
      const crash = async (point: RepoMdSyncFaultPoint): Promise<void> => {
        let fired = false;
        await expect(core.syncRepoMdSource("repo-source", {
          fault: (seen) => { if (seen === point && !fired) { fired = true; throw new Error(`remove:${point}`); } },
        })).rejects.toThrow(`remove:${point}`);
        reopen();
      };

      await crash("after-remove-current");
      expect(existsSync(join(f.storage, "repo-md", "repo-source", "current"))).toBe(false);
      await crash("after-remove-item");
      expect(core.listSourceRemovalItems("repo-source").filter((item) => item.acknowledgedAt !== null)).toHaveLength(1);
      await crash("after-remove-item");
      expect(core.listSourceRemovalItems("repo-source").every((item) => item.acknowledgedAt !== null)).toBe(true);
      await crash("after-remove-snapshots");
      expect(existsSync(join(f.storage, "repo-md", "repo-source", "snapshots"))).toBe(false);
      await crash("before-remove-complete");
      expect(core.getSourceRemoval("repo-source")!.state).toBe("files-revoked");
      await crash("after-remove-complete");

      expect(await core.syncRepoMdSource("repo-source")).toMatchObject({
        status: "removed", runId: active.activeRunId, snapshotId: active.activeSnapshotId,
      });
      expect(core.getSourceRemoval("repo-source")!.state).toBe("complete");
      expect(core.getSource("repo-source", { includeTombstoned: true })).toMatchObject({
        lifecycle: "tombstoned", activeRunId: null, activeSnapshotId: null, activeIngestConfigHash: null,
      });
      expect(core.listSourceRuns("repo-source")).toHaveLength(runCount);
      for (const chunk of chunks) {
        expect(rawConcept(core, chunk.conceptId!)).toMatchObject({ status: "retired", active_observation_id: null });
        expect(await core.getConcept(chunk.conceptId!)).toBeNull();
      }
      expect(core.listSourceChunks(active.activeRunId!, true).every((chunk) => chunk.lifecycle === "deleted")).toBe(true);
      expect(existsSync(join(f.storage, "repo-md", "repo-source", "current"))).toBe(false);
      expect(existsSync(join(f.storage, "repo-md", "repo-source", "snapshots"))).toBe(false);
      expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe(readme);
      expect(readFileSync(join(f.repo, "SECOND.md"), "utf8")).toBe(second);
    } finally {
      if (core !== f.core) { try { core.close(); } catch { /* test cleanup */ } }
      f.cleanup();
    }
  });

  it("never resurrects attempt state when a resumable run faults after removal completion", async () => {
    const f = fixture("removed-attempt-resurrection");
    let core = f.core;
    try {
      await core.syncRepoMdSource("repo-source");
      f.commit("# Intro\n\nresumable before removal\n", "resumable before removal");
      let beginFault = false;
      await expect(core.syncRepoMdSource("repo-source", {
        fault: (point) => {
          if (point === "after-begin" && !beginFault) {
            beginFault = true;
            throw new Error("leave resumable run");
          }
        },
      })).rejects.toThrow("leave resumable run");
      const resumable = core.resumeSourceRun("repo-source")!;
      expect(resumable.state).toBe("scanning");
      expect(sourceAttemptState(core, "repo-source").attempts).toBeGreaterThan(0);

      core.removeSource("repo-source");
      let completeFault = false;
      await expect(core.syncRepoMdSource("repo-source", {
        fault: (point) => {
          if (point === "after-remove-complete" && !completeFault) {
            completeFault = true;
            throw new Error("primary after-remove-complete fault");
          }
        },
      })).rejects.toThrow("primary after-remove-complete fault");
      expect(core.getSourceRemoval("repo-source")!.state).toBe("complete");
      expect(sourceAttemptState(core, "repo-source")).toEqual({ attempts: 0, prePin: 0, verification: 0 });

      for (let reopen = 0; reopen < 2; reopen += 1) {
        core.close();
        core = new MonetCore(f.db, { sourceStorageDir: f.storage });
        expect(core.getSourceRemoval("repo-source")!.state).toBe("complete");
        expect(sourceAttemptState(core, "repo-source")).toEqual({ attempts: 0, prePin: 0, verification: 0 });
      }
      expect(await core.syncRepoMdSource("repo-source")).toMatchObject({ status: "removed" });
      expect(core.completeSourceRemoval("repo-source").state).toBe("complete");
      expect(sourceAttemptState(core, "repo-source")).toEqual({ attempts: 0, prePin: 0, verification: 0 });
      expect(core.getSourceRun(resumable.id)).toMatchObject({ state: "aborted" });
    } finally {
      if (core !== f.core) { try { core.close(); } catch { /* test cleanup */ } }
      f.cleanup();
    }
  });

  it("completes and replays removal for a published source with no bindings", async () => {
    const f = fixture("empty-removal");
    try {
      f.core.updateSource("repo-source", { include: ["NO-SUCH-FILE.md"] });
      const published = await f.core.syncRepoMdSource("repo-source");
      expect(f.core.listSourceChunks(published.runId!, true)).toEqual([]);
      f.core.removeSource("repo-source");
      expect(await f.core.syncRepoMdSource("repo-source")).toMatchObject({ status: "removed", runId: published.runId });
      expect(f.core.listSourceRemovalItems("repo-source")).toEqual([]);
      expect(f.core.getSourceRemoval("repo-source")!.state).toBe("complete");
      expect(await f.core.syncRepoMdSource("repo-source")).toMatchObject({ status: "removed", runId: published.runId });
      expect(readFileSync(join(f.repo, "README.md"), "utf8")).toContain("initial committed body");
    } finally { f.cleanup(); }
  });

  it("completes and replays removal before any source snapshot was published", async () => {
    const f = fixture("never-published-removal");
    try {
      f.core.removeSource("repo-source");
      expect(await f.core.syncRepoMdSource("repo-source")).toMatchObject({
        status: "removed", runId: null, snapshotId: null,
      });
      expect(f.core.listSourceRuns("repo-source")).toEqual([]);
      expect(f.core.listSourceRemovalItems("repo-source")).toEqual([]);
      expect(f.core.getSourceRemoval("repo-source")!.state).toBe("complete");
      expect(await f.core.syncRepoMdSource("repo-source")).toMatchObject({ status: "removed", runId: null });
      expect(readFileSync(join(f.repo, "README.md"), "utf8")).toContain("initial committed body");
    } finally { f.cleanup(); }
  });

  it("ingests, skips unchanged HEAD, refreshes changed content, and retires deletions", async () => {
    const f = fixture("lifecycle");
    try {
      const initial = await f.core.syncRepoMdSource("repo-source");
      expect(initial.status).toBe("published");
      const firstRun = f.core.getSource(initial.sourceId)!.activeRunId!;
      const firstChunk = f.core.listSourceChunks(firstRun, true)[0]!;
      expect(firstChunk.content).toContain("initial committed body");
      expect(f.core.listSourceRuns("repo-source")).toHaveLength(1);

      expect((await f.core.syncRepoMdSource("repo-source")).status).toBe("noop");
      expect(f.core.listSourceRuns("repo-source")).toHaveLength(1);

      f.commit("# Intro\n\nchanged committed body\n", "changed");
      const changed = await f.core.syncRepoMdSource("repo-source");
      expect(changed.status).toBe("published");
      const changedChunk = f.core.listSourceChunks(changed.runId!, true)[0]!;
      expect(changedChunk.conceptId).toBe(firstChunk.conceptId);
      expect(changedChunk.observationId).not.toBe(firstChunk.observationId);
      expect(changedChunk.predecessorObservationId).toBe(firstChunk.observationId);
      expect(rawConcept(f.core, firstChunk.conceptId!).body).toContain("changed committed body");

      unlinkSync(join(f.repo, "README.md"));
      git(f.repo, "add", "-u"); git(f.repo, "commit", "-m", "delete");
      const deleted = await f.core.syncRepoMdSource("repo-source");
      expect(deleted.status).toBe("published");
      expect(f.core.listSourceChunks(deleted.runId!, true)).toEqual([]);
      expect(rawConcept(f.core, firstChunk.conceptId!).status).toBe("retired");
      expect(f.core.listSourceChunks(changed.runId!, true)[0]!.lifecycle).toBe("deleted");
    } finally { f.cleanup(); }
  });

  it("skip-and-diagnoses a transiently unreadable file without inferred deletion, then resumes the same binding once healed", async () => {
    const f = fixture("partial");
    try {
      const initial = await f.core.syncRepoMdSource("repo-source");
      const activeRun = f.core.getSource("repo-source")!.activeRunId!;
      const active = f.core.listSourceChunks(activeRun, true)[0]!;
      writeFileSync(join(f.repo, "README.md"), Buffer.from([0xff, 0xfe, 0xfd]));
      git(f.repo, "add", "README.md"); git(f.repo, "commit", "-m", "invalid utf8");

      // A per-file diagnostic (invalid UTF-8) no longer blocks the whole scan: the run publishes,
      // minus the unreadable file, rather than aborting partial.
      const skipped = await f.core.syncRepoMdSource("repo-source");
      expect(skipped.status).toBe("published");
      expect(initial.snapshotId).not.toBe(skipped.snapshotId);
      // The carried-forward file stays indexed (its content is still live); filesSkipped records
      // that THIS run could not confirm it fresh.
      expect(f.core.sourceStatus("repo-source", { callerId: "caller", projectId: "project" })).toMatchObject({
        lastSyncResult: "success", filesIndexed: 1, filesSkipped: 1,
      });

      // CLOSURE FIX: README.md's prior binding carries forward unchanged rather than being
      // inferred deleted — same bindingId/conceptId/observationId, concept lifecycle untouched,
      // and no retire-absent cleanup item is created for it.
      const skippedRun = f.core.getSource("repo-source")!.activeRunId!;
      expect(skippedRun).not.toBe(activeRun);
      const carried = f.core.listSourceChunks(skippedRun, true)[0]!;
      expect(carried).toMatchObject({
        bindingId: active.bindingId, conceptId: active.conceptId,
        observationId: active.observationId, lifecycle: "active",
      });
      expect(rawConcept(f.core, active.conceptId!).status).toBe("active");
      expect(f.core.listSourceCleanupItems(skipped.runId!).some((item) => item.kind === "retire-absent")).toBe(false);

      // Healing the file resumes the SAME binding/concept lineage rather than forking a new one.
      f.commit("# Intro\n\nhealed body\n", "healed");
      const healed = await f.core.syncRepoMdSource("repo-source");
      expect(healed.status).toBe("published");
      const healedChunk = f.core.listSourceChunks(healed.runId!, true)[0]!;
      expect(healedChunk.bindingId).toBe(active.bindingId);
      expect(healedChunk.conceptId).toBe(active.conceptId);
      expect(healedChunk.observationId).not.toBe(active.observationId);
      expect(healedChunk.predecessorObservationId).toBe(active.observationId);
      expect(rawConcept(f.core, active.conceptId!).body).toContain("healed body");
    } finally { f.cleanup(); }
  });

  it("aborts tree-level partial scans without writes or inferred deletion (gate regression)", async () => {
    const f = fixture("tree-partial");
    try {
      const initial = await f.core.syncRepoMdSource("repo-source");
      const activeRun = f.core.getSource("repo-source")!.activeRunId!;
      const active = f.core.listSourceChunks(activeRun, true)[0]!;
      f.commit("# Intro\n\nchanged committed body\n", "changed");
      // A tree-level violation still fails the whole scan closed, distinguishing it from the
      // per-file skip-and-diagnose case above; injecting the scanner result isolates this from
      // any particular resource limit while proving the sync-level abort/no-write/no-deletion path.
      const syncWithScan = f.core.syncRepoMdSource.bind(f.core) as unknown as (
        sourceId: string,
        options: { scan: (input: Parameters<typeof scanSourceSnapshot>[0]) => ReturnType<typeof scanSourceSnapshot> },
      ) => ReturnType<typeof f.core.syncRepoMdSource>;
      const partial = await syncWithScan("repo-source", { scan: (input) => ({
        ...scanSourceSnapshot(input), status: "partial", publishable: false,
        diagnostics: [{ code: "entry-budget-exceeded", message: "injected tree-level partial scan" }],
      }) });
      expect(partial.status).toBe("partial");
      expect(f.core.getSource("repo-source")!.activeRunId).toBe(activeRun);
      expect(f.core.listSourceChunks(activeRun, true)[0]).toMatchObject({ observationId: active.observationId, lifecycle: "active" });
      expect(f.core.listSourceChunks(partial.runId!)).toEqual([]);
      expect(initial.snapshotId).not.toBe(partial.snapshotId);
    } finally { f.cleanup(); }
  });

  it("publishes complete with zero files when every selected file is skip-and-diagnosed on a first sync", async () => {
    const f = fixture("all-bad");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "README.md"), Buffer.from([0xff, 0xfe, 0xfd]));
      git(f.repo, "add", "README.md"); git(f.repo, "commit", "-m", "corrupt the only file");
      const result = await f.core.syncRepoMdSource("repo-source");
      expect(result.status).toBe("published");
      const activeRun = f.core.getSource("repo-source")!.activeRunId!;
      expect(f.core.listSourceFiles(activeRun, true)).toEqual([]);
      expect(f.core.listSourceChunks(activeRun, true)).toEqual([]);
      expect(f.core.sourceStatus("repo-source", { callerId: "caller", projectId: "project" })).toMatchObject({
        lastSyncResult: "success", filesIndexed: 0, filesSkipped: 1,
      });
    } finally { f.cleanup(); }
  });

  it("publishes a mixed tree of good, wrong-type, oversized, and invalid-frontmatter files with a stable skip set across repeated syncs (incident regression)", async () => {
    const f = fixture("mixed-tree");
    try {
      f.core.updateSource("repo-source", { include: ["*.md", "*.docx"] });
      writeFileSync(join(f.repo, "second.md"), "# Second\n\nsecond body\n");
      writeFileSync(join(f.repo, "notes.docx"), "wrong-type bytes, not Markdown");
      writeFileSync(join(f.repo, "bad-frontmatter.md"), "---\nowner:\n  name: docs\n---\n# Body\ntext");
      writeFileSync(join(f.repo, "oversized.md"), Buffer.alloc(3 * 1024 * 1024, 0x61));
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "mixed tree");
      const first = await f.core.syncRepoMdSource("repo-source");
      expect(first.status).toBe("published");
      const firstRun = f.core.getSource("repo-source")!.activeRunId!;
      expect(f.core.listSourceFiles(firstRun, true).map((file) => file.relativePath).sort()).toEqual(["README.md", "second.md"]);
      const status = f.core.sourceStatus("repo-source", { callerId: "caller", projectId: "project" });
      expect(status).toMatchObject({ lastSyncResult: "success", filesIndexed: 2, filesSkipped: 3, freshness: "fresh" });
      expect(status.schedule.consecutiveFailures).toBe(0);

      // Force a genuine second scan (not a same-HEAD noop) by touching only a good file. The same
      // three files are still bad in exactly the same way: this incident's regression is that the
      // second run must reproduce the identical deterministic skip set, publish clean, and show
      // zero failures/backoff growth, rather than the pre-fix behavior of the whole source wedging.
      f.commit("# Intro\n\nupdated committed body\n", "touch good file");
      const second = await f.core.syncRepoMdSource("repo-source");
      expect(second.status).toBe("published");
      expect(second.snapshotId).not.toBe(first.snapshotId);
      const secondRun = f.core.getSource("repo-source")!.activeRunId!;
      const codes = (runId: string) => f.core.listSourceSkippedFiles(runId)
        .map((row) => ({ relativePath: row.relativePath, code: row.code }))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      const firstCodes = codes(firstRun);
      const secondCodes = codes(secondRun);
      expect(secondCodes).toEqual(firstCodes);
      expect(secondCodes).toEqual([
        { relativePath: "bad-frontmatter.md", code: "invalid-frontmatter" },
        { relativePath: "notes.docx", code: "not-markdown" },
        { relativePath: "oversized.md", code: "file-too-large" },
      ]);
      const statusAgain = f.core.sourceStatus("repo-source", { callerId: "caller", projectId: "project" });
      expect(statusAgain).toMatchObject({ lastSyncResult: "success", filesSkipped: 3 });
      expect(statusAgain.schedule.consecutiveFailures).toBe(0);
    } finally { f.cleanup(); }
  });

  it("does not wedge the whole sync when one chunk's embed() throws mid-materialize — degrades that chunk to the zero-vector placeholder, diagnoses it, and still publishes (reviewer finding 7)", async () => {
    // materializeStagedBindings (source-sync.ts) calls core.storeSource per chunk with no
    // try/catch of its own — before storeSourceChunk's own fix (engine.ts), an embed() throw here
    // (a realistic transient ONNX hiccup) would propagate to the run-level failure handler and
    // abort the ENTIRE sync pre-publish, reintroducing the "one file wedges the whole source"
    // class skip-and-diagnose (#49) eliminated for classification failures. This proves the fix
    // end-to-end: the run still publishes, every OTHER chunk still gets a real vector, and the
    // failure is diagnosed (stderr) rather than silent.
    //
    // Throws exactly ONCE, on the first embed() call whose text contains the marker — that call is
    // troubled.md's OWN chunk embed during materialization (chronologically first). This
    // deliberately does NOT also fail troubled.md's post-publish recomputeSourceConceptBody
    // whole-file embed (same marker text, called later): that embed call is a SEPARATE, already-
    // accepted risk (post-publish, self-healing via the source_recompute_pending sweep) — out of
    // scope for this fix, and conflating the two would test something this change never claimed.
    const real = new HashingEmbeddingProvider();
    const troubledMarker = "TROUBLED SECTION MARKER";
    let hasThrown = false;
    const flaky: EmbeddingProvider = {
      dim: real.dim,
      modelId: real.modelId,
      embed: (text) => {
        if (!hasThrown && text.includes(troubledMarker)) {
          hasThrown = true;
          throw new Error("injected transient embedding failure");
        }
        return real.embed(text);
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture("embed-failure", { embedder: flaky });
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "troubled.md"), `# Troubled\n\n${troubledMarker} appears in this section.\n`);
      writeFileSync(join(f.repo, "fine.md"), "# Fine\n\nOrdinary content with no marker at all.\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add troubled and fine files");

      const result = await f.core.syncRepoMdSource("repo-source");
      // The run still publishes — a single chunk's embed failure does not wedge the source.
      expect(result.status).toBe("published");
      const runId = f.core.getSource("repo-source")!.activeRunId!;
      expect(f.core.listSourceFiles(runId, true).map((file) => file.relativePath).sort()).toEqual(["README.md", "fine.md", "troubled.md"]);
      // Not a skip: troubled.md is fully ingested (chunked, staged, committed, published) — only
      // its retrieval VECTOR is degraded, which is an entirely different axis from skip-and-diagnose.
      expect(f.core.listSourceSkippedFiles(runId)).toEqual([]);

      const rawDb = (f.core as unknown as { db: StoragePort }).db;
      const embeddingFor = (relativePath: string): number[] => {
        const row = rawDb
          .prepare(
            `SELECT o.embedding AS embedding FROM source_chunks sc JOIN observations o ON o.id = sc.observation_id
              WHERE sc.relative_path = ? AND sc.lifecycle = 'active'`,
          )
          .get(relativePath) as { embedding: string };
        return JSON.parse(row.embedding) as number[];
      };
      expect(embeddingFor("troubled.md").every((component) => component === 0)).toBe(true);
      expect(embeddingFor("fine.md").some((component) => component !== 0)).toBe(true);

      // Diagnosed via stderr, not silent.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("embedding failed for a source chunk"));
    } finally {
      errorSpy.mockRestore();
      f.cleanup();
    }
  });

  it("ingests array-valued frontmatter alongside a genuinely-invalid file, and sourceStatus's skip count reflects only the real skip (frontmatter array tolerance)", async () => {
    const f = fixture("frontmatter-array-mixed");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      // Real vaults (Obsidian, etc.) use array-valued frontmatter for keys other than `tags`
      // routinely — this file used to be silently dropped (invalid-frontmatter) even though it has
      // no genuinely nested structure, just a flat list of names.
      writeFileSync(join(f.repo, "meeting.md"), "---\nattendees: [Priya Patel, Sarah Chen]\n---\n# Standup\nDiscussed the roadmap.\n");
      // A genuinely nested value (map, not a flat list) is still unsupported and still skips —
      // unaffected by this fix.
      writeFileSync(join(f.repo, "bad-frontmatter.md"), "---\nowner:\n  name: docs\n---\n# Body\ntext");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "frontmatter array mix");

      const result = await f.core.syncRepoMdSource("repo-source");
      expect(result.status).toBe("published");
      const runId = f.core.getSource("repo-source")!.activeRunId!;
      // README.md (fixture default) + meeting.md now both ingest; bad-frontmatter.md alone skips.
      expect(f.core.listSourceFiles(runId, true).map((file) => file.relativePath).sort()).toEqual(["README.md", "meeting.md"]);
      expect(f.core.listSourceSkippedFiles(runId).map((row) => ({ relativePath: row.relativePath, code: row.code })))
        .toEqual([{ relativePath: "bad-frontmatter.md", code: "invalid-frontmatter" }]);

      // Surfaced in the status projection (source_status MCP tool / core.sourceStatus): a sync
      // that skipped a file no longer looks perfectly healthy at a glance, and — the actual fix
      // here — the array-frontmatter file is no longer counted among the skips at all.
      const status = f.core.sourceStatus("repo-source", { callerId: "caller", projectId: "project" });
      expect(status).toMatchObject({ lastSyncResult: "success", filesIndexed: 2, filesSkipped: 1, freshness: "fresh" });
    } finally { f.cleanup(); }
  });

  it("re-evaluates an already-published source on an otherwise-UNCHANGED working tree once its stored ingest-config hash goes stale (review fix, Codex P1 finding 1)", async () => {
    // SOURCE_CHUNKER_VERSION's own bump (v3->v4, source-chunker.ts) is what actually closes this in
    // production: a classification-affecting parser change must change computeSourceIngestConfigHash
    // so an already-registered, already-synced source doesn't take beginSourceRun's unchanged-
    // snapshot/config noop path (source-ledger.ts ~835-837) forever. This test can't literally
    // replay an OLDER build's parser (that code no longer exists once this fix lands), so it proves
    // the exact mechanism the version bump relies on directly: ANY staleness in the source's stored
    // active_ingest_config_hash — for whatever reason, a version bump included — defeats the noop
    // short-circuit and forces one real re-scan on an UNCHANGED git tree, which then reflects the
    // CURRENT parser's classification (proven separately, extensively, by this file's and
    // frontmatter-array-values.test.ts's other tests).
    const f = fixture("stale-ingest-hash");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "meeting.md"), "---\nattendees: [Priya Patel, Sarah Chen]\n---\n# Standup\nDiscussed the roadmap.\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add array-frontmatter file");

      const first = await f.core.syncRepoMdSource("repo-source");
      expect(first.status).toBe("published");
      const firstRun = f.core.getSource("repo-source")!.activeRunId!;
      expect(f.core.listSourceFiles(firstRun, true).map((file) => file.relativePath).sort()).toEqual(["README.md", "meeting.md"]);

      // Simulate a stale ingest-config hash on an otherwise fully-published, up-to-date source —
      // standing in for "this exact publication predates a classification-affecting version bump"
      // without depending on any specific OLD parser's behavior.
      const rawDb = (f.core as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
      rawDb.prepare(`UPDATE knowledge_sources SET active_ingest_config_hash = ? WHERE id = ?`).run("stale-pre-bump-hash", "repo-source");

      // No commit, no config change: the working tree is byte-for-byte what it was for `first`.
      const second = await f.core.syncRepoMdSource("repo-source");
      expect(second.status).not.toBe("noop"); // the stale hash alone defeats the noop short-circuit
      expect(second.status).toBe("published");
      const secondRun = f.core.getSource("repo-source")!.activeRunId!;
      expect(secondRun).not.toBe(firstRun); // a genuine new run actually happened, not a cache hit
      // The re-scan reflects the CURRENT (already-correct) parser — still both files, still no skips.
      expect(f.core.listSourceFiles(secondRun, true).map((file) => file.relativePath).sort()).toEqual(["README.md", "meeting.md"]);
      expect(f.core.listSourceSkippedFiles(secondRun)).toEqual([]);
    } finally { f.cleanup(); }
  });

  it("gracefully aborts partial instead of throwing when carried-forward content exceeds the run's chunk budget (blocker 1 regression)", async () => {
    const f = fixture("carry-budget");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "A.md"), "# A\n\nbody\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add A");
      const first = await f.core.syncRepoMdSource("repo-source");
      expect(first.status).toBe("published");
      const firstActiveRun = f.core.getSource("repo-source")!.activeRunId!;
      const priorChunks = f.core.listSourceChunks(firstActiveRun, true);
      expect(priorChunks).toHaveLength(2);

      // Corrupt A.md so it becomes skip-and-diagnosed (carry-forward eligible), and patch the next
      // run's own persisted budget to exactly what README.md's surviving fresh chunk alone fills —
      // isolated from any particular default limit, matching the auditor's tight-budget repro shape.
      writeFileSync(join(f.repo, "A.md"), Buffer.from([0xff, 0xfe, 0xfd]));
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "corrupt A");
      let patched = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => {
          if (point === "after-begin" && !patched) {
            patched = true;
            const runId = f.core.resumeSourceRun("repo-source")!.id;
            const db = (f.core as unknown as { db: StoragePort }).db;
            const row = db.prepare(`SELECT effective_config_json FROM source_sync_runs WHERE id=?`).get(runId) as { effective_config_json: string };
            const config = JSON.parse(row.effective_config_json);
            config.limits.maxChunks = 1;
            // ingest_config_hash is a SEPARATE stored column, not recomputed from
            // effective_config_json on read — keep both consistent (as a real config-driven new
            // run always would) or the scanner's own freshly-recomputed hash (from effectiveConfig)
            // disagrees with this run's stored ingestConfigHash the moment anything gets rescanned.
            db.prepare(`UPDATE source_sync_runs SET effective_config_json=?, ingest_config_hash=? WHERE id=?`)
              .run(JSON.stringify(config), computeSourceIngestConfigHash(config), runId);
            throw new Error("force resume with patched budget");
          }
        },
      })).rejects.toThrow("force resume with patched budget");

      // BLOCKER 1 FIX: README.md's fresh chunk alone fills the patched maxChunks=1 budget; adding
      // A.md's carried chunk on top pushes the staged manifest to 2. Without the fix,
      // planManifest's carry-forward silently exceeds the budget and validateManifest throws,
      // which the outer handler records as a hard "failed" run (the cured disease reintroduced)
      // instead of this graceful partial abort with the prior publication left untouched.
      const result = await f.core.syncRepoMdSource("repo-source");
      expect(result.status).toBe("partial");
      expect(f.core.getSource("repo-source")!.activeRunId).toBe(firstActiveRun);
      expect(f.core.listSourceChunks(firstActiveRun, true)).toEqual(priorChunks);
    } finally { f.cleanup(); }
  });

  it("rejects a rename carry absent from the sealed snapshot before activation", async () => {
    const f = fixture("rename-into-skip");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      const initial = await f.core.syncRepoMdSource("repo-source");
      const active = f.core.listSourceChunks(initial.runId!, true)[0]!;

      // Rename README.md -> NEW.md and, in the SAME commit, append one invalid UTF-8 byte: the
      // destination never reaches scan.files (it's skip-diagnosed, not scanned), so ordinary
      // rename matching — keyed off addedPaths, which requires a successful scan — can't fire for
      // it. The corruption is a minimal one-byte perturbation so Git's own similarity-based rename
      // detection still recognizes NEW.md as README.md's rename target.
      const original = readFileSync(join(f.repo, "README.md"));
      git(f.repo, "mv", "README.md", "NEW.md");
      writeFileSync(join(f.repo, "NEW.md"), Buffer.concat([original, Buffer.from([0x80])]));
      git(f.repo, "add", "NEW.md"); git(f.repo, "commit", "-m", "rename into invalid utf-8");

      await expect(f.core.syncRepoMdSource("repo-source")).rejects.toThrow(/ledger|snapshot|parity/);
      expect(f.core.getSource("repo-source")!.activeRunId).toBe(initial.runId);
      expect(f.core.getSource("repo-source")!.activeSnapshotId).toBe(initial.snapshotId);
      expect(rawSnapshotBytes(f, "README.md").toString("utf8")).toBe(original.toString("utf8"));
      expect(rawConcept(f.core, active.conceptId!).status).toBe("active");

      // Once the destination is valid, a fresh candidate can publish normally.
      writeFileSync(join(f.repo, "NEW.md"), "# Intro\n\nhealed after rename\n");
      git(f.repo, "add", "NEW.md"); git(f.repo, "commit", "-m", "heal NEW.md");
      const healed = await f.core.syncRepoMdSource("repo-source");
      expect(healed.status).toBe("published");
      const healedChunk = f.core.listSourceChunks(healed.runId!, true)[0]!;
      expect(healedChunk.relativePath).toBe("NEW.md");
      expect(rawConcept(f.core, healedChunk.conceptId!).body).toContain("healed after rename");
    } finally { f.cleanup(); }
  });

  it("preserves skip-and-diagnose evidence for a materializer-excluded file across a crash between begin and stage (blocker 3 regression)", async () => {
    const f = fixture("resume-diagnostics");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "A.md"), "# A\n\nbody\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add A");
      const initial = await f.core.syncRepoMdSource("repo-source");
      expect(initial.status).toBe("published");
      const activeRun = f.core.getSource("repo-source")!.activeRunId!;
      const active = f.core.listSourceChunks(activeRun, true).find((chunk) => chunk.relativePath === "A.md")!;

      // Replace the previously published A.md with a selected Git symlink: a materializer-level
      // skip that never reaches the scanner at all, so its diagnostic depends entirely on the
      // pin-time materialize call's own result.
      unlinkSync(join(f.repo, "A.md"));
      symlinkSync("README.md", join(f.repo, "A.md"));
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "replace A.md with a symlink");

      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-begin" && !fired) { fired = true; throw new Error("begin crash"); } },
      })).rejects.toThrow("begin crash");
      const stranded = f.core.resumeSourceRun("repo-source")!;
      expect(stranded.state).toBe("scanning");

      // Fault-free resume: a fresh invocation has no in-memory pin-time evidence (pinnedDiagnostics
      // is unset), so it must recover the pin-time materializer diagnostic from the now-durably-
      // sealed snapshot's own marker instead of silently reporting none.
      const resumed = await f.core.syncRepoMdSource("repo-source");
      expect(resumed.status).toBe("published");
      const resumedRun = f.core.getSource("repo-source")!.activeRunId!;
      // byteLength wiring (minor): carried into the skip record from A.md's last-confirmed size.
      expect(f.core.listSourceSkippedFiles(resumedRun).map((row) => ({ relativePath: row.relativePath, code: row.code, byteLength: row.byteLength })))
        .toEqual(expect.arrayContaining([{ relativePath: "A.md", code: "unsupported-node", byteLength: Buffer.byteLength("# A\n\nbody\n") }]));
      const carried = f.core.listSourceChunks(resumedRun, true).find((chunk) => chunk.relativePath === "A.md")!;
      expect(carried).toMatchObject({ bindingId: active.bindingId, conceptId: active.conceptId, lifecycle: "active" });
      expect(rawConcept(f.core, active.conceptId!).status).toBe("active");
      expect(f.core.listSourceCleanupItems(resumed.runId!).some((item) => item.kind === "retire-absent" && item.bindingId === active.bindingId)).toBe(false);
    } finally { f.cleanup(); }
  });

  it("protects previously published descendants when their subtree root becomes a non-regular Git entry (blocker 4 regression)", async () => {
    const f = fixture("subtree-symlink");
    try {
      f.core.updateSource("repo-source", { include: ["docs/**"], exclude: [] });
      mkdirSync(join(f.repo, "docs"));
      writeFileSync(join(f.repo, "docs", "a.md"), "# A\n\ndoc a body\n");
      writeFileSync(join(f.repo, "docs", "b.md"), "# B\n\ndoc b body\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add docs subtree");
      const initial = await f.core.syncRepoMdSource("repo-source");
      expect(initial.status).toBe("published");
      const activeRun = f.core.getSource("repo-source")!.activeRunId!;
      const activeChunks = f.core.listSourceChunks(activeRun, true);
      expect(activeChunks.map((chunk) => chunk.relativePath).sort()).toEqual(["docs/a.md", "docs/b.md"]);

      // Replace the whole subtree with a symlink: the diagnostic names the subtree ROOT ("docs"),
      // not each descendant individually — exact-path protection alone would wrongly retire both.
      rmSync(join(f.repo, "docs"), { recursive: true });
      symlinkSync(".", join(f.repo, "docs"));
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "replace docs subtree with a symlink");

      const result = await f.core.syncRepoMdSource("repo-source");
      expect(result.status).toBe("published");
      expect(f.core.listSourceSkippedFiles(result.runId!).map((row) => row.relativePath)).toEqual(["docs"]);
      const carried = f.core.listSourceChunks(result.runId!, true);
      expect(carried.map((chunk) => chunk.relativePath).sort()).toEqual(["docs/a.md", "docs/b.md"]);
      expect(carried.map((chunk) => chunk.bindingId).sort()).toEqual(activeChunks.map((chunk) => chunk.bindingId).sort());
      expect(carried.every((chunk) => chunk.lifecycle === "active")).toBe(true);
      for (const chunk of activeChunks) expect(rawConcept(f.core, chunk.conceptId!).status).toBe("active");
      expect(f.core.listSourceCleanupItems(result.runId!).some((item) => item.kind === "retire-absent")).toBe(false);

      // THE CROSS-CHECK (scope item 3, "subtree"): both descendants the materializer pre-seal
      // carried and both descendants planManifest carried into the manifest agree, and the sealed
      // snapshot actually delivers their prior bytes. Compared against the FILE record's
      // contentHash (whole-file bytes), not the chunk's (which hashes only that chunk's body,
      // excluding e.g. its own heading line — a different, smaller hash domain).
      const carriedFiles = f.core.listSourceFiles(result.runId!, true);
      for (const [path, body] of [["docs/a.md", "doc a body"], ["docs/b.md", "doc b body"]] as const) {
        const file = carriedFiles.find((candidate) => candidate.relativePath === path)!;
        const raw = rawSnapshotBytes(f, path);
        expect(computeSourceContentHash(raw)).toBe(file.contentHash);
        expect(raw.toString("utf8")).toContain(body);
      }
    } finally { f.cleanup(); }
  });

  it("does not carry a subtree descendant the current config now excludes (Codex 3606534107)", async () => {
    const f = fixture("subtree-exclude-drift");
    try {
      f.core.updateSource("repo-source", { include: ["docs/**"], exclude: [] });
      mkdirSync(join(f.repo, "docs"));
      writeFileSync(join(f.repo, "docs", "a.md"), "# A\n\ndoc a body\n");
      writeFileSync(join(f.repo, "docs", "private.md"), "# Private\n\nsecret body\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add docs subtree");
      const initial = await f.core.syncRepoMdSource("repo-source");
      expect(initial.status).toBe("published");
      const activeRun = f.core.getSource("repo-source")!.activeRunId!;
      const activeChunks = f.core.listSourceChunks(activeRun, true);
      expect(activeChunks.map((chunk) => chunk.relativePath).sort()).toEqual(["docs/a.md", "docs/private.md"]);
      const privateBinding = activeChunks.find((chunk) => chunk.relativePath === "docs/private.md")!;

      // Simultaneously: replace docs/ with a symlink (diagnoses the whole subtree) AND newly
      // exclude docs/private.md via config. Without the fix, subtree-protection carry-forward
      // would silently resurrect the now-explicitly-excluded file in both the manifest and the
      // pre-seal-carried snapshot, until the subtree healed.
      rmSync(join(f.repo, "docs"), { recursive: true });
      symlinkSync(".", join(f.repo, "docs"));
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "replace docs subtree with a symlink");
      f.core.updateSource("repo-source", { exclude: ["docs/private.md"] });

      const result = await f.core.syncRepoMdSource("repo-source");
      expect(result.status).toBe("published");
      const carried = f.core.listSourceChunks(result.runId!, true);
      expect(carried.map((chunk) => chunk.relativePath)).toEqual(["docs/a.md"]);
      // The now-excluded binding is correctly treated as absent (retired), not silently kept alive
      // by carry-forward.
      expect(f.core.listSourceCleanupItems(result.runId!)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "retire-absent", bindingId: privateBinding.bindingId }),
      ]));

      // Cross-check: the pre-seal materializer carry set agrees — it never carried the excluded
      // descendant into the newly sealed snapshot either.
    } finally { f.cleanup(); }
  });

  it("does not reuse a cached snapshot's stale carried content across a different prior publication (Codex 3606534127)", async () => {
    const f = fixture("carry-cache-stale-prior-publication");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "A.md"), "# A\n\noriginal body\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add A");
      await f.core.syncRepoMdSource("repo-source");

      // Commit X: A.md becomes a symlink (materializer-diagnosed) — carries "original body" into
      // a NEWLY sealed snapshot for X.
      unlinkSync(join(f.repo, "A.md"));
      symlinkSync("README.md", join(f.repo, "A.md"));
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "replace A.md with a symlink");
      const symlinkResult = await f.core.syncRepoMdSource("repo-source");
      expect(symlinkResult.status).toBe("published");
      const commitX = git(f.repo, "rev-parse", "HEAD");
      expect(symlinkResult.snapshotId).toBe(commitX);
      expect(rawSnapshotBytes(f, "A.md").toString("utf8")).toBe("# A\n\noriginal body\n");

      // Heal A.md with DIFFERENT content at a new commit — the prior publication changes.
      rmSync(join(f.repo, "A.md"));
      writeFileSync(join(f.repo, "A.md"), "# A\n\nhealed body\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "heal A with new content");
      const healedResult = await f.core.syncRepoMdSource("repo-source");
      expect(healedResult.status).toBe("published");
      expect(f.core.listSourceChunks(healedResult.runId!, true).find((chunk) => chunk.relativePath === "A.md")!.content)
        .toContain("healed body");

      // Revisit commit X directly: the SAME snapshotId+config as the symlink sync above, whose
      // sealed snapshot (still on disk) carries the ORIGINAL body from before A.md healed. The
      // CURRENT prior publication is now the healed run, not the one active when X was first sealed.
      execFileSync("git", ["reset", "--hard", commitX], { cwd: f.repo });
      const revisited = await f.core.syncRepoMdSource("repo-source");
      expect(revisited.status).toBe("published");
      expect(revisited.snapshotId).toBe(commitX);
      const revisitedChunk = f.core.listSourceChunks(revisited.runId!, true).find((chunk) => chunk.relativePath === "A.md")!;

      // THE FIX: the rebuilt snapshot must carry the CURRENT prior publication's content (healed
      // body), not the stale content from when this exact snapshot variant was first sealed —
      // proving the cache hit was correctly fenced and rebuilt rather than blindly reused.
      expect(revisitedChunk.content).toContain("healed body");
      const raw = rawSnapshotBytes(f, "A.md");
      expect(raw.toString("utf8")).toContain("healed body");
      expect(raw.toString("utf8")).not.toContain("original body");
      const carriedFile = f.core.listSourceFiles(revisited.runId!, true).find((file) => file.relativePath === "A.md")!;
      expect(computeSourceContentHash(raw)).toBe(carriedFile.contentHash);
    } finally { f.cleanup(); }
  });

  it("recomputes a carried chunk's fingerprint when the effective ingest config changes in the same run as a skip (blocker 6 regression)", async () => {
    const f = fixture("carry-config-change");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "A.md"), "# A\n\nbody\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add A");
      await f.core.syncRepoMdSource("repo-source");
      const activeRun = f.core.getSource("repo-source")!.activeRunId!;
      const active = f.core.listSourceChunks(activeRun, true).find((chunk) => chunk.relativePath === "A.md")!;

      // Corrupt A.md (carry-eligible) AND change the effective ingest config in the same cycle.
      // The carried chunk's fingerprint was computed under the OLD ingestConfigHash;
      // validateManifest checks every chunk's fingerprint against the CURRENT run's hash
      // unconditionally, carried or not, and the one existing config-hash fence only disables
      // content-hash rename matching — it does not gate carry-forward at all.
      writeFileSync(join(f.repo, "A.md"), Buffer.from([0xff, 0xfe, 0xfd]));
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "corrupt A");
      f.core.updateSource("repo-source", { exclude: ["NEVER.md"] });

      const result = await f.core.syncRepoMdSource("repo-source");
      expect(result.status).toBe("published");
      const carried = f.core.listSourceChunks(result.runId!, true).find((chunk) => chunk.relativePath === "A.md")!;
      expect(carried).toMatchObject({ bindingId: active.bindingId, conceptId: active.conceptId, lifecycle: "active" });
      expect(carried.ingestFingerprint).not.toBe(active.ingestFingerprint);
      expect(rawConcept(f.core, active.conceptId!).status).toBe("active");
    } finally { f.cleanup(); }
  });

  it("carries a previously-published file's bytes into the newly sealed snapshot when it becomes an oversized blob (blocker 5a scenario; plain-skip cross-check)", async () => {
    const f = fixture("carry-into-snapshot-oversized");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "A.md"), "# A\n\nbody\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add A");
      await f.core.syncRepoMdSource("repo-source");
      const activeRun = f.core.getSource("repo-source")!.activeRunId!;
      const active = f.core.listSourceChunks(activeRun, true).find((chunk) => chunk.relativePath === "A.md")!;

      // Grows A.md past maxFileBytes: enumerateSelectedTree's own blob-size check (a MATERIALIZER
      // diagnostic, from Git's reported size, before any read) fires here — the exact shape
      // blocker 5a's Codex comment named ("the file became an oversized blob"), and the only shape
      // pre-seal carry-forward is scoped to (a scanner-diagnosed carry's bytes are already present
      // via normal materialization; out of scope here, see the KNOWN OPEN GAP comment this closes).
      writeFileSync(join(f.repo, "A.md"), Buffer.alloc(3 * 1024 * 1024, 0x61));
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "grow A past the per-file limit");

      const result = await f.core.syncRepoMdSource("repo-source");
      expect(result.status).toBe("published");
      expect(f.core.listSourceSkippedFiles(result.runId!).map((row) => ({ relativePath: row.relativePath, code: row.code })))
        .toEqual(expect.arrayContaining([{ relativePath: "A.md", code: "file-too-large" }]));
      const carried = f.core.listSourceChunks(result.runId!, true).find((chunk) => chunk.relativePath === "A.md")!;
      expect(carried).toMatchObject({ bindingId: active.bindingId, conceptId: active.conceptId, lifecycle: "active" });

      // THE CROSS-CHECK (scope item 3/4): the materializer's pre-seal carry set and planManifest's
      // final carried-file set agree, and the sealed snapshot actually delivers what the manifest
      // claims — not the fresh (grown) bytes just committed. Compared against the FILE record's
      // contentHash (whole-file bytes), not the chunk's own (a different, smaller hash domain).
      const carriedFile = f.core.listSourceFiles(result.runId!, true).find((file) => file.relativePath === "A.md")!;
      const raw = rawSnapshotBytes(f, "A.md");
      expect(computeSourceContentHash(raw)).toBe(carriedFile.contentHash);
      expect(raw.toString("utf8")).toBe("# A\n\nbody\n");
    } finally { f.cleanup(); }
  });

  // DELIBERATELY NOT COVERED (rename+skip cross-check via a materializer-diagnosed destination,
  // e.g. rename into an oversized blob): constructing it reliably fought two requirements in
  // tension — the destination must be similar enough to the ORIGINAL content for Git's rename
  // detection to fire (REPO_MD_RENAME_SIMILARITY, source-materializer.ts), and different enough in
  // SIZE to cross maxFileBytes. A tiny append preserves similarity but rarely reaches a realistic
  // maxFileBytes; a wholesale size change (e.g. Buffer.alloc(3MB)) reliably falls below the
  // similarity threshold and Git simply never reports the rename. CORRECTION (cold audit of
  // 67ad7c3): the shape IS constructible with realistic small limits — e.g. maxFileBytes=10 with
  // a 15-byte file renamed+grown to 18 bytes stays >50% similar (REPO_MD_RENAME_SIMILARITY=50)
  // while crossing the limit — the 3MB-blob difficulty above was self-imposed, not fundamental.
  // And the composition claim is FALSE for this shape: planManifest's case-(c) rename carry emits
  // a destination path the pre-seal mirror structurally cannot produce (it iterates prior files
  // only), so the manifest claims bytes the sealed snapshot lacks — git-md fails the ledger
  // cross-check post-publish; repo-md leaves a source_path gap. This is the KNOWN OPEN case-(c)
  // divergence documented at treeLevelCarryCandidates (source-materializer.ts) and planManifest's
  // carry comment (source-sync.ts); pre-existing before pre-seal carry landed, tracked as a
  // follow-up requiring pre-seal rename knowledge. A regression test lands with that fix.

  it("gracefully aborts partial instead of throwing when a materializer-diagnosed carry pushes the run over its chunk budget (budget-abort cross-check)", async () => {
    const f = fixture("carry-budget-materializer");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "A.md"), "# A\n\nbody\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add A");
      const first = await f.core.syncRepoMdSource("repo-source");
      const firstActiveRun = f.core.getSource("repo-source")!.activeRunId!;
      const priorChunks = f.core.listSourceChunks(firstActiveRun, true);
      expect(priorChunks).toHaveLength(2);

      writeFileSync(join(f.repo, "A.md"), Buffer.alloc(3 * 1024 * 1024, 0x61));
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "grow A past the per-file limit");
      let patched = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => {
          if (point === "after-begin" && !patched) {
            patched = true;
            const runId = f.core.resumeSourceRun("repo-source")!.id;
            const db = (f.core as unknown as { db: StoragePort }).db;
            const row = db.prepare(`SELECT effective_config_json FROM source_sync_runs WHERE id=?`).get(runId) as { effective_config_json: string };
            const config = JSON.parse(row.effective_config_json);
            config.limits.maxChunks = 1;
            // ingest_config_hash is a SEPARATE stored column, not recomputed from
            // effective_config_json on read — keep both consistent (as a real config-driven new
            // run always would) or the scanner's own freshly-recomputed hash (from effectiveConfig)
            // disagrees with this run's stored ingestConfigHash the moment anything gets rescanned.
            db.prepare(`UPDATE source_sync_runs SET effective_config_json=?, ingest_config_hash=? WHERE id=?`)
              .run(JSON.stringify(config), computeSourceIngestConfigHash(config), runId);
            throw new Error("force resume with patched budget");
          }
        },
      })).rejects.toThrow("force resume with patched budget");

      const result = await f.core.syncRepoMdSource("repo-source");
      expect(result.status).toBe("partial");
      expect(f.core.getSource("repo-source")!.activeRunId).toBe(firstActiveRun);
      expect(f.core.listSourceChunks(firstActiveRun, true)).toEqual(priorChunks);
      expect(first.status).toBe("published");
    } finally { f.cleanup(); }
  });

  it("gracefully aborts partial instead of throwing when a carried chunk exceeds a lowered maxChunkBytes (audit regression: the fifth budget dimension)", async () => {
    const f = fixture("carry-chunk-bytes-budget");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "A.md"), `# A\n\n${"x".repeat(200)}\n`);
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add A");
      const first = await f.core.syncRepoMdSource("repo-source");
      const firstActiveRun = f.core.getSource("repo-source")!.activeRunId!;
      const priorChunks = f.core.listSourceChunks(firstActiveRun, true);
      const priorA = priorChunks.find((chunk) => chunk.relativePath === "A.md")!;
      expect(Buffer.byteLength(priorA.content, "utf8")).toBeGreaterThan(100);

      // Rename A.md -> B.md with a minimal one-byte invalid-UTF-8 append (preserves Git's rename
      // similarity detection, same technique as the blocker-2 regression above), NOT a same-path
      // symlink/oversized-blob/same-path-corruption trigger: those are all now either pre-seal
      // classifier-substituted (CODEX FIX 3606534097 — the scanner never sees bad bytes, so it
      // naturally re-discovers and re-chunks the substituted content, bypassing planManifest's
      // carry mechanism entirely) or intercepted by the order-dependent residual check, making
      // planManifest's own carry-forward structurally unreachable via those triggers now. B.md,
      // however, was never ITSELF previously published — only A.md was — so it is not a
      // classifier-substitution candidate at all (that candidate set is exactly the previously-
      // published, currently-selected paths); the scanner genuinely rejects B.md's still-corrupted
      // fresh bytes, and planManifest's rename-carry (case c) is what supplies its content, exactly
      // as blocker 2 already proves — this is the one remaining same-run shape where a carried
      // chunk's byte size is decided by planManifest rather than a natural rescan.
      const originalA = readFileSync(join(f.repo, "A.md"));
      git(f.repo, "mv", "A.md", "B.md");
      writeFileSync(join(f.repo, "B.md"), Buffer.concat([originalA, Buffer.from([0x80])]));
      git(f.repo, "add", "B.md"); git(f.repo, "commit", "-m", "rename A to B with invalid utf-8");
      let patched = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => {
          if (point === "after-begin" && !patched) {
            patched = true;
            const runId = f.core.resumeSourceRun("repo-source")!.id;
            const db = (f.core as unknown as { db: StoragePort }).db;
            const row = db.prepare(`SELECT effective_config_json FROM source_sync_runs WHERE id=?`).get(runId) as { effective_config_json: string };
            const config = JSON.parse(row.effective_config_json);
            config.limits.maxChunkBytes = 100;
            // ingest_config_hash is a SEPARATE stored column, not recomputed from
            // effective_config_json on read — keep both consistent (as a real config-driven new
            // run always would) or the scanner's own freshly-recomputed hash (from effectiveConfig)
            // disagrees with this run's stored ingestConfigHash the moment anything gets rescanned
            // — exactly what a freshly re-chunked (now two-piece, still-selected) file exposes.
            db.prepare(`UPDATE source_sync_runs SET effective_config_json=?, ingest_config_hash=? WHERE id=?`)
              .run(JSON.stringify(config), computeSourceIngestConfigHash(config), runId);
            throw new Error("force resume with lowered maxChunkBytes");
          }
        },
      })).rejects.toThrow("force resume with lowered maxChunkBytes");

      const result = await f.core.syncRepoMdSource("repo-source");
      expect(result.status).toBe("partial");
      expect(f.core.getSource("repo-source")!.activeRunId).toBe(firstActiveRun);
      expect(f.core.listSourceChunks(firstActiveRun, true)).toEqual(priorChunks);
      expect(first.status).toBe("published");
    } finally { f.cleanup(); }
  });

  it("publishes through a same-path frontmatter corruption via pre-seal classifier substitution, then heals the same binding (Codex 3606534097 incident shape)", async () => {
    const f = fixture("classifier-substitution-incident");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "A.md"), "# A\n\noriginal body\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add A");
      await f.core.syncRepoMdSource("repo-source");
      const activeRun = f.core.getSource("repo-source")!.activeRunId!;
      const active = f.core.listSourceChunks(activeRun, true).find((chunk) => chunk.relativePath === "A.md")!;

      // Corrupt A.md's frontmatter (nested/nonflat — still a perfectly valid, in-budget Git blob,
      // still selected). John's ruling "A": the pre-seal classifier (source-chunker.ts) rejects
      // the fresh bytes and substitutes the prior sealed snapshot's bytes BEFORE the scanner ever
      // runs on this commit.
      writeFileSync(join(f.repo, "A.md"), "---\nowner:\n  name: docs\n---\n# A\n\nnew body\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "corrupt A's frontmatter");

      const result = await f.core.syncRepoMdSource("repo-source");
      // THE INCIDENT SHAPE: sync PUBLISHES (never partial, never throws) — substitution means the
      // scanner reads valid (substituted, prior) bytes and never itself notices anything was wrong.
      expect(result.status).toBe("published");
      // Audit visibility survives even though the scanner sees clean content: the materializer's
      // own classifier rejection is still durably recorded (source_skipped_files).
      expect(f.core.listSourceSkippedFiles(result.runId!).map((row) => ({ relativePath: row.relativePath, code: row.code })))
        .toEqual(expect.arrayContaining([{ relativePath: "A.md", code: "invalid-frontmatter" }]));
      // Index keeps the OLD content records: same binding/concept, content unchanged.
      const carried = f.core.listSourceChunks(result.runId!, true).find((chunk) => chunk.relativePath === "A.md")!;
      expect(carried).toMatchObject({ bindingId: active.bindingId, conceptId: active.conceptId, lifecycle: "active" });
      expect(carried.content).toContain("original body");
      expect(rawConcept(f.core, active.conceptId!).status).toBe("active");

      // The snapshot serves the OLD bytes for that path — not the fresh, corrupted commit's bytes
      // — and the manifest's claimed contentHash matches exactly what's physically there.
      const carriedFile = f.core.listSourceFiles(result.runId!, true).find((file) => file.relativePath === "A.md")!;
      const raw = rawSnapshotBytes(f, "A.md");
      expect(computeSourceContentHash(raw)).toBe(carriedFile.contentHash);
      expect(raw.toString("utf8")).toBe("# A\n\noriginal body\n");

      // Heal cycle: fixing the frontmatter resumes the SAME binding/concept lineage rather than
      // forking a new one.
      writeFileSync(join(f.repo, "A.md"), "# A\n\nhealed body\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "heal A");
      const healed = await f.core.syncRepoMdSource("repo-source");
      expect(healed.status).toBe("published");
      const healedChunk = f.core.listSourceChunks(healed.runId!, true).find((chunk) => chunk.relativePath === "A.md")!;
      expect(healedChunk.bindingId).toBe(active.bindingId);
      expect(healedChunk.conceptId).toBe(active.conceptId);
      expect(healedChunk.content).toContain("healed body");
    } finally { f.cleanup(); }
  });

  it("degrades to a graceful tree-level-partial exit when a previously-published, classifier-valid file is chunk-budget-skipped (Codex 3606534097 order-dependent residual)", async () => {
    const f = fixture("chunk-budget-residual");
    try {
      f.core.updateSource("repo-source", { include: ["*.md"] });
      writeFileSync(join(f.repo, "A.md"), "# A\n\nx\n");
      git(f.repo, "add", "-A"); git(f.repo, "commit", "-m", "add A");
      const first = await f.core.syncRepoMdSource("repo-source");
      const firstActiveRun = f.core.getSource("repo-source")!.activeRunId!;
      const priorChunks = f.core.listSourceChunks(firstActiveRun, true);
      expect(priorChunks.map((chunk) => chunk.relativePath).sort()).toEqual(["A.md", "README.md"]);

      // Force a genuine rescan (not a same-commit noop) with BOTH files' own content untouched and
      // classifier-valid, then patch maxChunks to exactly what "A.md" alone consumes (files walk in
      // sorted order; "A.md" sorts before "README.md"). README.md — previously published,
      // classifier-valid, untouched — is what runs out of walk-order-dependent chunk budget: a
      // diagnostic the pre-seal classifier could not have predicted, since chunk-budget-exceeded
      // depends on cumulative usage across the whole walk, not this file's own bytes.
      f.commit("# Intro\n\nunrelated content change to force a rescan\n", "unrelated change");
      let patched = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => {
          if (point === "after-begin" && !patched) {
            patched = true;
            const runId = f.core.resumeSourceRun("repo-source")!.id;
            const db = (f.core as unknown as { db: StoragePort }).db;
            const row = db.prepare(`SELECT effective_config_json FROM source_sync_runs WHERE id=?`).get(runId) as { effective_config_json: string };
            const config = JSON.parse(row.effective_config_json);
            config.limits.maxChunks = 1;
            db.prepare(`UPDATE source_sync_runs SET effective_config_json=?, ingest_config_hash=? WHERE id=?`)
              .run(JSON.stringify(config), computeSourceIngestConfigHash(config), runId);
            throw new Error("force resume with a one-chunk budget");
          }
        },
      })).rejects.toThrow("force resume with a one-chunk budget");

      const result = await f.core.syncRepoMdSource("repo-source");
      expect(result.status).toBe("partial");
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "chunk-budget-exceeded", relativePath: "README.md" }),
      ]));
      expect(f.core.getSource("repo-source")!.activeRunId).toBe(firstActiveRun);
      expect(f.core.listSourceChunks(firstActiveRun, true)).toEqual(priorChunks);
      expect(first.status).toBe("published");
    } finally { f.cleanup(); }
  });

  // DELIBERATELY NOT COVERED BY AN AUTOMATED TEST (prior-sealed-snapshot-unavailable edge case):
  // attempted by deleting the prior sealed snapshot directory + sidecar directly on disk before a
  // second sync. This reliably came back "published", not "partial" — discovered why: repo-md
  // sources self-heal their ACTIVE snapshot at the very start of EVERY sync (source-sync.ts, the
  // `if (source.activeSnapshotId && type !== "git-md")` block, unconditional, runs before the pin
  // block for the NEW commit even begins) — materializeCommit for the active snapshotId silently
  // rebuilds exactly what was just deleted, before this run's own carry-forward logic ever gets a
  // chance to observe it missing. Reaching the edge case would need either a git-md fixture (no
  // equivalent self-heal — this test file only sets up repo-md) or fault-injecting a deletion
  // between self-heal and the carry attempt, and no fault point exists between them today.
  // Confidence here rests on code inspection instead: carryForwardPriorFiles' try/catch around
  // validateSealedSnapshot returns `unavailable` (never throws) on ANY failure reading the prior
  // snapshot, and the syncSource check immediately after skipDiagnostics is assembled aborts
  // gracefully as partial before ever calling stageSourceManifest — the identical, already-tested
  // graceful-abort machinery the maxChunks/maxChunkBytes budget tests above exercise, just with
  // this specific trigger condition unverified end-to-end.

  it("compensates a committed refresh when config drift fences activation", async () => {
    const f = fixture("drift");
    try {
      const initial = await f.core.syncRepoMdSource("repo-source");
      const priorRun = f.core.getSource("repo-source")!.activeRunId!;
      const prior = f.core.listSourceChunks(priorRun, true)[0]!;
      f.commit("# Intro\n\ndrifted successor\n", "drift successor");
      let drifted = false;
      const result = await f.core.syncRepoMdSource("repo-source", {
        fault: (point) => {
          if (point === "after-committed" && !drifted) {
            drifted = true;
            f.core.updateSource("repo-source", { name: "config drift" });
          }
        },
      });
      expect(result.status).toBe("aborted");
      expect(f.core.getSource("repo-source")!.activeRunId).toBe(priorRun);
      expect(rawConcept(f.core, prior.conceptId!)).toMatchObject({
        body: expect.stringContaining("initial committed body"), active_observation_id: prior.observationId,
      });
      expect(f.core.listSourceCleanupItems(result.runId!).every((item) => item.acknowledgedAt !== null)).toBe(true);
      expect((await f.core.syncRepoMdSource("repo-source")).status).toBe("published");
      expect(rawConcept(f.core, prior.conceptId!).body).toContain("drifted successor");
      expect(initial.runId).toBe(priorRun);
    } finally { f.cleanup(); }
  });

  it("terminally retires a new orphan when initial publication is fenced", async () => {
    const f = fixture("new-orphan");
    try {
      let drifted = false;
      const result = await f.core.syncRepoMdSource("repo-source", {
        fault: (point) => {
          if (point === "after-committed" && !drifted) {
            drifted = true;
            f.core.updateSource("repo-source", { name: "initial drift" });
          }
        },
      });
      expect(result.status).toBe("aborted");
      const staged = f.core.listSourceChunks(result.runId!)[0]!;
      expect(staged.predecessorObservationId).toBeNull();
      expect(rawConcept(f.core, staged.conceptId!)).toMatchObject({ status: "retired", active_observation_id: null });
      expect(f.core.listSourceCleanupItems(result.runId!)[0]!.acknowledgedAt).not.toBeNull();
      expect((await f.core.syncRepoMdSource("repo-source")).status).toBe("published");
    } finally { f.cleanup(); }
  });

  it("resumes the durable run OID even when repository HEAD advances", async () => {
    const f = fixture("resume-oid");
    try {
      await f.core.syncRepoMdSource("repo-source");
      const pinned = f.commit("# Intro\n\npinned B\n", "B");
      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-stage" && !fired) { fired = true; throw new Error("stage crash"); } },
      })).rejects.toThrow("stage crash");
      const later = f.commit("# Intro\n\nlater C\n", "C");
      expect(later).not.toBe(pinned);
      const resumed = await f.core.syncRepoMdSource("repo-source");
      expect(resumed.snapshotId).toBe(pinned);
      expect(f.core.getSource("repo-source")!.activeSnapshotId).toBe(pinned);
      expect(f.core.listSourceChunks(resumed.runId!, true)[0]!.content).toContain("pinned B");
    } finally { f.cleanup(); }
  });

  for (const point of [
    "after-store", "after-engine-written", "after-refresh", "after-committed", "after-publish", "after-current",
    // REVIEW FIX (BLOCKER): "after-publish" already lands exactly in the crash window the review
    // found (a durable publish committed, recompute not yet run) — "after-recompute" additionally
    // proves recovery is clean when the crash happens just past a successful recompute. Both now
    // get the concept-row assertions below, which is what actually exercises the fix: the
    // pre-existing ledger-chunk assertion alone was blind to this bug (the ledger's own copy of
    // chunk content was always correct — only the concept row could go stale/empty).
    "after-recompute",
  ] as RepoMdSyncFaultPoint[]) {
    it(`resumes exactly after ${point}`, async () => {
      const f = fixture(point);
      try {
        await f.core.syncRepoMdSource("repo-source");
        f.commit(`# Intro\n\n${point} body\n`, point);
        let fired = false;
        await expect(f.core.syncRepoMdSource("repo-source", {
          fault: (seen) => { if (seen === point && !fired) { fired = true; throw new Error(`fault:${point}`); } },
        })).rejects.toThrow(`fault:${point}`);
        const recovered = await f.core.syncRepoMdSource("repo-source");
        expect(["published", "noop"]).toContain(recovered.status);
        const source = f.core.getSource("repo-source")!;
        expect(source.activeSnapshotId).toBe(git(f.repo, "rev-parse", "HEAD"));
        const current = join(f.storage, "repo-md", "repo-source", "current");
        expect(resolve(dirname(current), readlinkSync(current))).toBe(join(
          f.storage, "repo-md", "repo-source", "snapshots", `${source.activeSnapshotId!}-${source.activeIngestConfigHash!.slice(-64)}`,
        ));
        const chunk = f.core.listSourceChunks(source.activeRunId!, true)[0]!;
        expect(chunk.content).toContain(`${point} body`);
        // REVIEW FIX (BLOCKER): the concept row itself, not just the ledger's own copy of the
        // content — this is what a stranded concept (recompute skipped past its crash-fenced
        // envelope) would fail on: empty/stale body, placeholder title, all-zero embedding.
        const concept = rawConceptFull(f.core, chunk.conceptId!);
        expect(concept.status).toBe("active");
        expect(concept.body).toContain(`${point} body`);
        expect(concept.title).toBe("README");
        expect(isPlaceholderEmbedding(concept.embedding)).toBe(false);
        expect(pendingRecomputeConceptIds(f.core, "repo-source")).toEqual([]);
      } finally { f.cleanup(); }
    });
  }

  it("aborts a version-stale 'scanning' run instead of wedging on every retry (round 4, Codex thread 15)", async () => {
    // A live "scanning" run whose scanConfigVersion/ingestConfigHash were persisted under an
    // OLDER SOURCE_SCANNER_VERSION/SOURCE_CHUNKER_VERSION than what's currently live — the exact
    // shape of a process restarting under upgraded code with a run still in flight. Simulated by
    // stranding a real "scanning" run, then rewriting BOTH persisted fields together (computing
    // just one and leaving the other consistent with the CURRENT version is not a real state a
    // version bump would ever produce). Pre-fix, this reproduced Codex's claim exactly: EVERY
    // subsequent sync attempt threw "chunk.ingestFingerprint does not match chunk content,
    // heading, metadata, and ingest config" — resumeSourceRun keeps handing back the SAME stuck
    // run, so nothing ever recovers.
    const f = fixture("version-stale-scanning-resume");
    try {
      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-begin" && !fired) { fired = true; throw new Error("stranded mid-scan"); } },
      })).rejects.toThrow("stranded mid-scan");
      const stranded = f.core.resumeSourceRun("repo-source")!;
      expect(stranded.state).toBe("scanning");

      const db = (f.core as unknown as { db: StoragePort }).db;
      const staleVersion = "OLD-SCANNER-v1/OLD-CHUNKER-v2";
      const staleHash = `monet-src-ingest-config/v1:sha256:${"0".repeat(64)}`;
      db.prepare(`UPDATE source_sync_runs SET scan_config_version=?, ingest_config_hash=? WHERE id=?`).run(staleVersion, staleHash, stranded.id);
      db.prepare(`UPDATE source_snapshots SET ingest_config_hash=? WHERE run_id=?`).run(staleHash, stranded.id);

      // The fix: this resolves cleanly on the very next attempt (the stale run is aborted and a
      // fresh one takes over), not just "eventually" after repeated failures.
      const recovered = await f.core.syncRepoMdSource("repo-source");
      expect(recovered.status).toBe("published");
      expect(recovered.runId).not.toBe(stranded.id); // a genuinely NEW run, not the stale one continued

      // A second, later sync sees a healthy steady state — no wedge, no repeated failure.
      const again = await f.core.syncRepoMdSource("repo-source");
      expect(again.status).toBe("noop");

      // The stale run is durably retired, not silently forgotten or left resumable.
      expect(f.core.getSourceRun(stranded.id)).toMatchObject({ state: "aborted", result: "failed" });
      expect(f.core.resumeSourceRun("repo-source")).toBeNull();
    } finally { f.cleanup(); }
  });

  it("never strands a brand-new file's concept at its create-time placeholder when the run collapses straight to cleaned (item 4/BLOCKER)", async () => {
    // The deep case, precisely: a zero-cleanup-items run (nothing to delete — this is the
    // source's first-ever content) collapses published->cleaning->cleaned in ONE ledger
    // transaction (publishRun) — durably unresumable the instant that transaction commits. A
    // crash between "after-publish" and recompute leaves the run itself with nothing to resume:
    // the next sync is a noop (the snapshot on disk hasn't changed), and pre-fix nothing would
    // ever call recomputeSourceConceptBody again — the concept was stranded forever at its
    // create-time placeholder (body='', all-zero embedding, content-derived placeholder title),
    // fully authorized and visible. Only the durable pending-recompute sweep (run unconditionally
    // at the start of every sync, including this noop one) can heal it.
    const f = fixture("brand-new-file-crash");
    try {
      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-publish" && !fired) { fired = true; throw new Error("crash before recompute"); } },
      })).rejects.toThrow("crash before recompute");

      const source = f.core.getSource("repo-source")!;
      expect(source.activeRunId).not.toBeNull(); // the publish itself DID durably commit
      const chunk = f.core.listSourceChunks(source.activeRunId!, true)[0]!;
      expect(chunk.conceptId).not.toBeNull();
      expect(pendingRecomputeConceptIds(f.core, "repo-source")).toContain(chunk.conceptId);
      // Pre-fix, this is exactly where the bug lived: the run is no longer resumable at all.
      expect(f.core.resumeSourceRun("repo-source")).toBeNull();

      const recovered = await f.core.syncRepoMdSource("repo-source");
      // Confirms this exercises the exact seam the review found: nothing to resume, nothing
      // changed on disk — a plain noop, not a "published" resume path with its own recompute call.
      expect(recovered.status).toBe("noop");
      const concept = rawConceptFull(f.core, chunk.conceptId!);
      expect(concept.status).toBe("active");
      expect(concept.body).not.toBe("");
      expect(concept.body).toContain("initial committed body");
      expect(concept.title).toBe("README");
      expect(isPlaceholderEmbedding(concept.embedding)).toBe(false);
      expect(pendingRecomputeConceptIds(f.core, "repo-source")).toEqual([]);
    } finally { f.cleanup(); }
  });

  it("recomputes a survivor's concept on resuming an already-published, still-cleaning run (cleaning-resume branch, item 4/BLOCKER)", async () => {
    // The other named case, precisely: a run with cleanup items stays 'cleaning' (not auto-
    // advanced to 'cleaned') until EVERY item is acknowledged, so it IS still resumable if a
    // crash lands mid-drain — but the PR#49-era fast path that resumes it (source-sync.ts,
    // "if (run?.state === 'cleaning')") predates recomputeTouchedSourceConcepts and returned
    // "published" without ever calling it. Two deletions (two cleanup items) so the crash can
    // land after the first item's acknowledgement but before the second's, leaving the run
    // genuinely still 'cleaning' (not collapsed to 'cleaned') on resume — this is what actually
    // reaches the fixed branch, not just the general sweep (that path is covered by the
    // brand-new-file and parameterized-loop tests above).
    const f = fixture("cleaning-resume-crash");
    try {
      writeFileSync(join(f.repo, "A.md"), "# A\n\nfile a body\n");
      writeFileSync(join(f.repo, "B.md"), "# B\n\nfile b body\n");
      f.core.updateSource("repo-source", { include: ["*.md"] });
      git(f.repo, "add", "A.md", "B.md"); git(f.repo, "commit", "-m", "add A and B");
      await f.core.syncRepoMdSource("repo-source");

      unlinkSync(join(f.repo, "A.md"));
      unlinkSync(join(f.repo, "B.md"));
      writeFileSync(join(f.repo, "README.md"), "# Intro\n\nedited survivor body\n");
      git(f.repo, "add", "-u"); git(f.repo, "commit", "-m", "delete A and B, edit README");

      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-cleanup" && !fired) { fired = true; throw new Error("crash mid-drain"); } },
      })).rejects.toThrow("crash mid-drain");

      // Confirms the crash landed where intended: still resumable, still mid-cleanup.
      const stuck = f.core.resumeSourceRun("repo-source");
      expect(stuck?.state).toBe("cleaning");

      const recovered = await f.core.syncRepoMdSource("repo-source");
      expect(recovered.status).toBe("published");
      const source = f.core.getSource("repo-source")!;
      const survivor = f.core.listSourceChunks(source.activeRunId!, true).find((chunk) => chunk.relativePath === "README.md")!;
      const concept = rawConceptFull(f.core, survivor.conceptId!);
      expect(concept.status).toBe("active");
      expect(concept.body).toContain("edited survivor body");
      expect(isPlaceholderEmbedding(concept.embedding)).toBe(false);
      expect(pendingRecomputeConceptIds(f.core, "repo-source")).toEqual([]);
      expect(f.core.listSourceCleanupItems(source.activeRunId!).every((item) => item.acknowledgedAt !== null)).toBe(true);
    } finally { f.cleanup(); }
  });

  it("recomputes a file's concept when it ONLY loses a section, with its other sections unchanged (round 4, Codex thread 2/(a))", async () => {
    // The gap precisely: publishRun's touchedConcepts (source-ledger.ts) and
    // recomputeTouchedSourceConcepts (above) both key off write_state='committed' chunks. A
    // section deletion with the file's OTHER sections byte-identical produces ZERO committed
    // chunks this run — the survivor takes the 'skipped' fast path, and the deleted section is
    // handled only by a retire-absent cleanup item, which neither of those committed-chunk
    // filters ever sees. Without marking the concept pending from the cleanup item too, its
    // stored body/embedding would keep including the deleted section forever.
    const f = fixture("deletion-only-recompute");
    try {
      // Each section body must clear MIN_SOURCE_SECTION_BYTES (200) or the minimum-chunk merge
      // pass (source-chunker.ts) folds them into ONE chunk before either section ever gets its
      // own writeState to skip or change independently.
      const sectionABody = "section a padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      const sectionBBody = "section b padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      f.commit(`# A\n\n${sectionABody}\n\n# B\n\n${sectionBBody}\n`, "two sections");
      const first = await f.core.syncRepoMdSource("repo-source");
      const conceptId = f.core.listSourceChunks(first.runId!, true)[0]!.conceptId!;
      const before = rawConceptFull(f.core, conceptId);
      expect(before.body).toContain("section a padding");
      expect(before.body).toContain("section b padding");

      // Remove section B only — section A's bytes are unchanged, so its chunk takes the
      // 'skipped' fast path this run; the only ledger evidence of B's removal is a cleanup item.
      f.commit(`# A\n\n${sectionABody}\n`, "remove section b");
      const second = await f.core.syncRepoMdSource("repo-source");
      expect(second.status).toBe("published");

      // Confirm this actually exercises the gap: section A's surviving chunk really did skip.
      const survivorChunk = f.core.listSourceChunks(second.runId!, true).find((c) => c.relativePath === "README.md")!;
      expect(survivorChunk.writeState).toBe("skipped");
      expect(f.core.listSourceCleanupItems(second.runId!).some((item) => item.kind === "retire-absent")).toBe(true);

      const after = rawConceptFull(f.core, conceptId);
      expect(after.body).toContain("section a padding");
      expect(after.body).not.toContain("section b padding");
      expect(pendingRecomputeConceptIds(f.core, "repo-source")).toEqual([]);
    } finally { f.cleanup(); }
  });

  it("heals an unchanged chunk parked on a non-winning legacy concept onto the file's resolved concept (round 4, Codex thread 8)", async () => {
    // Simulates a file mid-consolidation off the old one-chunk-per-concept shape: section Zulu's
    // ledger row is manually parked on a SEPARATE ("legacy") concept, as if migration/prior
    // history had left it there while the rest of the file already lives on the winning concept.
    // A sync where Zulu's OWN content is unchanged must still heal it onto the resolved concept —
    // "content unchanged" alone must not be read as "already on the right concept".
    const f = fixture("legacy-split-heal");
    try {
      // Each section body must clear MIN_SOURCE_SECTION_BYTES (200) in EVERY commit below, or the
      // minimum-chunk merge pass (source-chunker.ts) folds Alpha and Zulu into one combined chunk
      // and this test's two-independent-chunks premise breaks.
      const alphaBody = "alpha padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      const alphaBodyEdited = "alpha EDITED padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      const zuluBody = "zulu padding text to exceed the two hundred byte minimum section size threshold reliably. ".repeat(3);
      f.commit(`# Alpha\n\n${alphaBody}\n\n# Zulu\n\n${zuluBody}\n`, "two sections");
      await f.core.syncRepoMdSource("repo-source");
      const activeBefore = f.core.getSource("repo-source")!;
      const chunksBefore = f.core.listSourceChunks(activeBefore.activeRunId!, true);
      const alpha = chunksBefore.find((c) => JSON.stringify(c.headingPath) === JSON.stringify(["Alpha"]))!;
      const zulu = chunksBefore.find((c) => JSON.stringify(c.headingPath) === JSON.stringify(["Zulu"]))!;
      expect(alpha.conceptId).toBe(zulu.conceptId); // sanity: file=concept, one concept for both

      const legacy = await f.core.storeSource("legacy standalone chunk content", {
        circle: "repo", sourceRefs: [zulu.sourceRef], resolution: "forceNew",
      });
      const db = (f.core as unknown as { db: StoragePort }).db;
      db.prepare(`UPDATE source_chunks SET concept_id = ? WHERE run_id = ? AND binding_id = ?`)
        .run(legacy.conceptId, activeBefore.activeRunId, zulu.bindingId);
      db.prepare(`UPDATE observations SET concept_id = ? WHERE id = ?`).run(legacy.conceptId, zulu.observationId);

      // A THIRD sync where Alpha's content CHANGES (guarantees a rescan, and — since Alpha sorts
      // before Zulu in listSourceChunks' relative_path,heading_path_json ordering — guarantees
      // fileConceptThisRun resolves via Alpha's own prior concept, the ORIGINAL one) while Zulu's
      // bytes stay identical to what they were before the manual move above.
      f.commit(`# Alpha\n\n${alphaBodyEdited}\n\n# Zulu\n\n${zuluBody}\n`, "edit alpha only");
      const third = await f.core.syncRepoMdSource("repo-source");
      expect(third.status).toBe("published");

      const chunksAfter = f.core.listSourceChunks(third.runId!, true);
      const healedAlpha = chunksAfter.find((c) => JSON.stringify(c.headingPath) === JSON.stringify(["Alpha"]))!;
      const healedZulu = chunksAfter.find((c) => JSON.stringify(c.headingPath) === JSON.stringify(["Zulu"]))!;
      expect(healedAlpha.conceptId).toBe(alpha.conceptId); // Alpha never left the original concept
      // The bug: Zulu's unchanged content used to skip in place on the legacy concept forever.
      // The fix: it heals onto the SAME concept as the rest of the file.
      expect(healedZulu.conceptId).toBe(healedAlpha.conceptId);
      expect(healedZulu.conceptId).not.toBe(legacy.conceptId);
      expect(f.core.hasActiveSourceChunks(legacy.conceptId)).toBe(false);
    } finally { f.cleanup(); }
  });

  it("resumes after the final deletion-cleanup acknowledgement boundary", async () => {
    const f = fixture("cleanup-crash");
    try {
      await f.core.syncRepoMdSource("repo-source");
      unlinkSync(join(f.repo, "README.md"));
      git(f.repo, "add", "-u"); git(f.repo, "commit", "-m", "delete for cleanup crash");
      let fired = false;
      let currentAgreedAtCleanup = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => {
          if (point === "after-cleanup" && !fired) {
            fired = true;
            const source = f.core.getSource("repo-source")!;
            const current = join(f.storage, "repo-md", "repo-source", "current");
            currentAgreedAtCleanup = resolve(dirname(current), readlinkSync(current))
              === join(f.storage, "repo-md", "repo-source", "snapshots", `${source.activeSnapshotId!}-${source.activeIngestConfigHash!.slice(-64)}`);
            throw new Error("cleanup crash");
          }
        },
      })).rejects.toThrow("cleanup crash");
      expect(currentAgreedAtCleanup).toBe(true);
      const recovered = await f.core.syncRepoMdSource("repo-source");
      expect(["published", "noop"]).toContain(recovered.status);
      const active = f.core.getSource("repo-source")!;
      expect(f.core.listSourceChunks(active.activeRunId!, true)).toEqual([]);
      expect(f.core.listSourceRuns("repo-source").flatMap((run) => f.core.listSourceCleanupItems(run.id)).every((item) => item.acknowledgedAt !== null)).toBe(true);
    } finally { f.cleanup(); }
  });

  it("repairs current after reopen and rejects a concurrent sync lock", async () => {
    const f = fixture("reopen-lock");
    try {
      let fired = false;
      await expect(f.core.syncRepoMdSource("repo-source", {
        fault: (point) => { if (point === "after-publish" && !fired) { fired = true; throw new Error("published crash"); } },
      })).rejects.toThrow("published crash");
      f.core.close();
      const reopened = new MonetCore(f.db, { sourceStorageDir: f.storage });
      const repaired = await reopened.syncRepoMdSource("repo-source");
      expect(["published", "noop"]).toContain(repaired.status);
      const current = join(f.storage, "repo-md", "repo-source", "current");
      expect(existsSync(current)).toBe(true);

      f.commit("# Intro\n\nconcurrent\n", "concurrent");
      const outcomes = await Promise.allSettled([
        reopened.syncRepoMdSource("repo-source"), reopened.syncRepoMdSource("repo-source"),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expect(String((outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason)).toContain("locked");
      reopened.close();
    } finally { f.cleanup(); }
  });
});
