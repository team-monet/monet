import { execFile as nodeExecFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MonetCore } from "../engine";
import { syncRepoMdSource as runRepoMdSync } from "../source-sync";
import type { RepoMdSyncFaultPoint, RepoMdSyncOptions } from "../source-sync";
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

  it("aborts partial scans without writes or inferred deletion", async () => {
    const f = fixture("partial");
    try {
      const initial = await f.core.syncRepoMdSource("repo-source");
      const activeRun = f.core.getSource("repo-source")!.activeRunId!;
      const active = f.core.listSourceChunks(activeRun, true)[0]!;
      writeFileSync(join(f.repo, "README.md"), Buffer.from([0xff, 0xfe, 0xfd]));
      git(f.repo, "add", "README.md"); git(f.repo, "commit", "-m", "invalid utf8");
      const partial = await f.core.syncRepoMdSource("repo-source");
      expect(partial.status).toBe("partial");
      expect(f.core.getSource("repo-source")!.activeRunId).toBe(activeRun);
      expect(f.core.listSourceChunks(activeRun, true)[0]).toMatchObject({ observationId: active.observationId, lifecycle: "active" });
      expect(f.core.listSourceChunks(partial.runId!)).toEqual([]);
      expect(initial.snapshotId).not.toBe(partial.snapshotId);
    } finally { f.cleanup(); }
  });

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
