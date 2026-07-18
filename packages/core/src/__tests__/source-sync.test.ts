import { execFile as nodeExecFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MonetCore } from "../engine";
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

function fixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `monet-repo-sync-${label}-`));
  const repo = join(root, "repo");
  const storage = join(root, "managed");
  const db = join(root, "monet.db");
  execFileSync("git", ["init", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# Intro\n\ninitial committed body\n");
  git(repo, "add", "README.md"); git(repo, "commit", "-m", "initial");
  const core = new MonetCore(db, { sourceStorageDir: storage });
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

/** The sealed snapshot marker's own carriedPaths record (blocker 5a) for the CURRENTLY published
 * snapshot+config variant — read directly from the sidecar, since it isn't part of any public API. */
function sealedMarkerCarriedPaths(f: { core: MonetCore; storage: string }): string[] {
  const source = f.core.getSource("repo-source")!;
  const variant = `${source.activeSnapshotId!}-${source.activeIngestConfigHash!.slice(-64)}`;
  const sidecarPath = join(f.storage, "repo-md", "repo-source", "snapshots", `${variant}.complete.json`);
  const marker = JSON.parse(readFileSync(sidecarPath, "utf8")) as { carriedPaths?: string[] };
  return marker.carriedPaths ?? [];
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

  it("carries a binding across a rename whose destination itself fails validation this run (blocker 2 regression)", async () => {
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

      const renamed = await f.core.syncRepoMdSource("repo-source");
      expect(renamed.status).toBe("published");
      expect(f.core.listSourceSkippedFiles(renamed.runId!).map((row) => row.relativePath)).toEqual(["NEW.md"]);
      const carried = f.core.listSourceChunks(renamed.runId!, true).find((chunk) => chunk.relativePath === "NEW.md");
      expect(carried).toMatchObject({ bindingId: active.bindingId, conceptId: active.conceptId, lifecycle: "active" });
      expect(carried!.sourceRef).toBe("source://repo-source/NEW.md#intro~1");
      expect(rawConcept(f.core, active.conceptId!).status).toBe("active");
      expect(f.core.listSourceCleanupItems(renamed.runId!).some((item) => item.kind === "retire-absent")).toBe(false);

      // Healing NEW.md resumes the SAME binding/concept lineage (heal-cycle continuity) instead of
      // forking a new one.
      writeFileSync(join(f.repo, "NEW.md"), "# Intro\n\nhealed after rename\n");
      git(f.repo, "add", "NEW.md"); git(f.repo, "commit", "-m", "heal NEW.md");
      const healed = await f.core.syncRepoMdSource("repo-source");
      expect(healed.status).toBe("published");
      const healedChunk = f.core.listSourceChunks(healed.runId!, true)[0]!;
      expect(healedChunk.bindingId).toBe(active.bindingId);
      expect(healedChunk.conceptId).toBe(active.conceptId);
      expect(healedChunk.predecessorObservationId).toBe(carried!.observationId);
      expect(rawConcept(f.core, active.conceptId!).body).toContain("healed after rename");
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
      expect(sealedMarkerCarriedPaths(f).sort()).toEqual(["docs/a.md", "docs/b.md"]);
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
      expect(sealedMarkerCarriedPaths(f)).toEqual(["docs/a.md"]);
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
      expect(sealedMarkerCarriedPaths(f)).toEqual(["A.md"]);
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
      expect(sealedMarkerCarriedPaths(f)).toEqual(["A.md"]);
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
      expect(sealedMarkerCarriedPaths(f)).toEqual(["A.md"]);
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

  // NOTE: this proves the incident shape end-to-end for repo-md, including the sealed-snapshot
  // byte-level cross-check. The git-md-specific validator subtlety (validateSealedSnapshotAgainstGit
  // treating a substituted path as a member of BOTH entries and carriedPaths — source-materializer.ts)
  // is verified by direct code inspection/tracing rather than a dedicated git-md test: git-md's own
  // test fixtures (source-git.test.ts) are a substantially larger, separate harness (managed remote
  // fetch simulation) this session did not build out. The reworked function is exercised identically
  // regardless of source type — its inputs are just (marker, entries), and its logic contains no
  // repo-md/git-md branching — so the repo-md-level proof that carriedPaths/carriedFromRunId are
  // populated correctly is strong indirect evidence; flagging the gap rather than skipping it silently.

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

  for (const point of ["after-store", "after-engine-written", "after-refresh", "after-committed", "after-publish", "after-current"] as RepoMdSyncFaultPoint[]) {
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
        expect(f.core.listSourceChunks(source.activeRunId!, true)[0]!.content).toContain(`${point} body`);
      } finally { f.cleanup(); }
    });
  }

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
