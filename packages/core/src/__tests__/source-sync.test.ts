import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MonetCore } from "../engine";
import type { RepoMdSyncFaultPoint } from "../source-sync";
import type { StoragePort } from "../storage";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

describe("repo-md committed-HEAD sync", () => {
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
