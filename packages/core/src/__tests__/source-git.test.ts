import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import * as publicApi from "../index";
import { MonetCore } from "../engine";
import { syncGitMdSource as syncGitMdSourceCoordinator, type GitMdSyncOptions } from "../source-sync";
import { runRemoteGit, syncManagedGitRepository, validateManagedGitRepository, type RemoteGitOptions } from "../source-git";
import { materializeGitMdCommit, withGitMdMaterializerLock } from "../source-materializer";
import { scanSourceSnapshot } from "../source-scanner";
import type { SourceChunkRecord } from "../source-types";
import type { StoragePort } from "../storage";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeWritable(path: string): void {
  try {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) makeWritable(join(path, child));
  } catch { /* fixture cleanup only */ }
}

function repositoryBytes(path: string): number {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error("test repository unexpectedly contains a symlink");
  if (entry.isFile()) return entry.size;
  return readdirSync(path).reduce((bytes, child) => bytes + repositoryBytes(join(path, child)), 0);
}

function repositoryDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (path: string, relativePath: string): void => {
    const entry = lstatSync(path);
    hash.update(`${relativePath}\0${entry.mode}\0${entry.size}\0`);
    if (entry.isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child), relativePath ? `${relativePath}/${child}` : child);
    else if (entry.isFile()) hash.update(readFileSync(path));
    else if (entry.isSymbolicLink()) throw new Error("test repository unexpectedly contains a symlink");
  };
  walk(root, "");
  return hash.digest("hex");
}

function noFollowTreeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (path: string, relativePath: string): void => {
    const entry = lstatSync(path);
    const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other";
    hash.update(`${relativePath}\0${kind}\0${entry.mode}\0${entry.size}\0`);
    if (entry.isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child), relativePath ? `${relativePath}/${child}` : child);
    else if (entry.isFile()) hash.update(readFileSync(path));
    else if (entry.isSymbolicLink()) hash.update(readlinkSync(path));
    else throw new Error("test tree contains an unsupported node");
  };
  walk(root, "");
  return hash.digest("hex");
}

function sourceProjection(core: MonetCore, chunks: SourceChunkRecord[]): unknown[] {
  const db = (core as unknown as { db: StoragePort }).db;
  return chunks.map((chunk) => ({
    bindingId: chunk.bindingId,
    concept: db.prepare(`SELECT * FROM concepts WHERE id=?`).get(chunk.conceptId!),
    observation: db.prepare(`SELECT * FROM observations WHERE id=?`).get(chunk.observationId!),
  }));
}

function differentDeviceOps(target: string, counters: { chmod: number; rm: number }) {
  return {
    lstat: ((path: Parameters<typeof lstatSync>[0]) => {
      const entry = lstatSync(path);
      if (String(path) !== target) return entry;
      const forged = Object.create(entry) as ReturnType<typeof lstatSync>;
      Object.defineProperty(forged, "dev", { value: entry.dev + 1 });
      return forged;
    }) as typeof lstatSync,
    readdir: readdirSync,
    chmod: ((path: Parameters<typeof chmodSync>[0], mode: Parameters<typeof chmodSync>[1]) => {
      counters.chmod += 1; chmodSync(path, mode);
    }) as typeof chmodSync,
    rm: ((path: Parameters<typeof rmSync>[0], options?: Parameters<typeof rmSync>[1]) => {
      counters.rm += 1; rmSync(path, options);
    }) as typeof rmSync,
  };
}

function differentOwnerOps(target: string, counters: { chmod: number; rm: number }) {
  return {
    lstat: ((path: Parameters<typeof lstatSync>[0]) => {
      const entry = lstatSync(path);
      if (String(path) !== target) return entry;
      const forged = Object.create(entry) as ReturnType<typeof lstatSync>;
      Object.defineProperty(forged, "uid", { value: entry.uid + 1 });
      return forged;
    }) as typeof lstatSync,
    chmod: ((path: Parameters<typeof chmodSync>[0], mode: Parameters<typeof chmodSync>[1]) => {
      counters.chmod += 1; chmodSync(path, mode);
    }) as typeof chmodSync,
    rm: ((path: Parameters<typeof rmSync>[0], options?: Parameters<typeof rmSync>[1]) => {
      counters.rm += 1; rmSync(path, options);
    }) as typeof rmSync,
  };
}

function rewriteSealedSnapshot(snapshot: string, relativePath: string, content: string): void {
  const sidecar = `${snapshot}.complete.json`;
  const marker = JSON.parse(readFileSync(sidecar, "utf8")) as {
    files: Array<{ path: string; size: number; sha256: string; mode?: string }>;
  };
  const target = marker.files.find((file) => file.path === relativePath);
  if (!target) throw new Error("test snapshot file missing");
  chmodSync(snapshot, 0o700);
  chmodSync(join(snapshot, relativePath), 0o600);
  writeFileSync(join(snapshot, relativePath), content);
  target.size = Buffer.byteLength(content);
  target.sha256 = createHash("sha256").update(content).digest("hex");
  chmodSync(join(snapshot, relativePath), 0o400);
  chmodSync(snapshot, 0o500);
  chmodSync(sidecar, 0o600);
  writeFileSync(sidecar, JSON.stringify(marker));
  chmodSync(sidecar, 0o400);
}

function fixture(sourcePathValidationCheck?: () => void) {
  const root = mkdtempSync(join(tmpdir(), "monet-git-md-"));
  const upstream = join(root, "upstream");
  const storage = join(root, "sources");
  execFileSync("git", ["init", "-b", "main", upstream]);
  git(upstream, "config", "user.email", "test@example.com");
  git(upstream, "config", "user.name", "Test");
  writeFileSync(join(upstream, "README.md"), "# One\n\nfirst\n");
  git(upstream, "add", "README.md"); git(upstream, "commit", "-m", "one");
  const canonicalRemote = "https://example.test/acme/docs";
  const localRemoteExec = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
    const rewritten = [...args].map((arg) => arg === canonicalRemote ? upstream : arg)
      .map((arg) => arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg);
    return execFile(file, rewritten, options, callback as never);
  }) as unknown as typeof execFile;
  const core = new MonetCore(join(root, "monet.db"), {
    sourceStorageDir: storage, sourceGit: { execFile: localRemoteExec }, sourcePathValidationCheck,
  });
  const source = core.createSource({
    id: "git-source", type: "git-md", name: "Remote docs", remoteUrl: canonicalRemote, branch: "main",
    circle: "remote-docs", include: ["README.md"], access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] },
    transport: { allowedUrlSchemes: ["https"], allowedHosts: ["example.test"] },
  });
  return {
    root, upstream, storage, canonicalRemote, localRemoteExec, core, source,
    auth: { callerId: "caller", projectId: "project" },
    cleanup: () => { core.close(); makeWritable(root); rmSync(root, { recursive: true, force: true }); },
  };
}

function displaceSourceLock(storage: string, sourceId: string): () => void {
  const lock = join(storage, "git-md", `.lock-${sourceId}`);
  const displaced = `${lock}.displaced`;
  renameSync(lock, displaced);
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    token: "new-owner", heartbeatAt: Date.now(), pid: process.pid, host: "replacement-owner",
  }));
  return () => {
    rmSync(lock, { recursive: true, force: true });
    rmSync(displaced, { recursive: true, force: true });
  };
}

describe("managed git-md remote materialization", () => {
  it("keeps the shared-lock repository primitive internal and rejects trusted materializer keys", () => {
    expect("syncManagedGitRepository" in publicApi).toBe(false);
    const options: GitMdSyncOptions = {
      materializer: {
        // @ts-expect-error engine-owned storage cannot be replaced by a sync caller
        sourceStorageDir: "/alternate",
      },
    };
    expect(options).toBeDefined();
  });

  it("fails closed when git-md authorization, configuration, or removal changes during exhaustive connector path validation", async () => {
    let duringValidation = () => undefined;
    const f = fixture(() => duringValidation());
    try {
      await f.core.syncSource(f.source.id, f.auth);
      const exact = f.core.sourcePath(f.source.id, f.auth);
      let unchangedChecks = 0;
      duringValidation = () => { unchangedChecks += 1; };
      expect(f.core.sourcePath(f.source.id, f.auth)).toEqual(exact);
      expect(unchangedChecks).toBeGreaterThan(1);

      let changed = false;
      duringValidation = () => {
        if (changed) return;
        changed = true;
        f.core.updateSource(f.source.id, { name: "changed during validation" });
      };
      expect(() => f.core.sourcePath(f.source.id, f.auth)).toThrow("source changed during operation");

      let revoked = false;
      duringValidation = () => {
        if (revoked) return;
        revoked = true;
        f.core.updateSource(f.source.id, {
          access: { allowedCallerIds: ["other"], allowedProjectIds: [f.auth.projectId] },
        });
      };
      expect(() => f.core.sourcePath(f.source.id, f.auth)).toThrow("source is unavailable");

      f.core.updateSource(f.source.id, {
        access: { allowedCallerIds: [f.auth.callerId], allowedProjectIds: [f.auth.projectId] },
      });
      let removed = false;
      duringValidation = () => {
        if (removed) return;
        removed = true;
        f.core.removeSource(f.source.id);
      };
      expect(() => f.core.sourcePath(f.source.id, f.auth)).toThrow("source is unavailable");
    } finally { f.cleanup(); }
  });

  it("rejects unowned or writable managed roots before locks or staging and accepts private owned roots", async () => {
    const f = fixture();
    try {
      const typeRoot = join(f.storage, "git-md");
      const sourceRoot = dirname(f.source.localPath);
      mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
      chmodSync(f.storage, 0o700); chmodSync(typeRoot, 0o700); chmodSync(sourceRoot, 0o700);
      const victim = join(f.root, "root-trust-victim");
      mkdirSync(victim); writeFileSync(join(victim, "keep"), "safe");
      const counters = { chmod: 0, rm: 0 };
      const attempt = (safeTreeOps: ReturnType<typeof differentOwnerOps>) => f.core.syncGitMdSource(f.source.id, {
        materializer: { safeTreeOps }, remoteGit: { execFile: f.localRemoteExec, safeTreeOps },
      });
      const ordinaryOps = differentOwnerOps(join(f.root, "not-a-managed-root"), counters);

      chmodSync(f.storage, 0o777);
      await expect(attempt(ordinaryOps)).rejects.toThrow(/storage base has unsafe permissions/);
      chmodSync(f.storage, 0o700);
      chmodSync(typeRoot, 0o775);
      await expect(attempt(ordinaryOps)).rejects.toThrow(/git-md root has unsafe permissions/);
      chmodSync(typeRoot, 0o700);
      chmodSync(sourceRoot, 0o740);
      await expect(attempt(ordinaryOps)).rejects.toThrow(/source root has unsafe permissions/);
      chmodSync(sourceRoot, 0o700);

      if (typeof process.getuid === "function") {
        await expect(attempt(differentOwnerOps(sourceRoot, counters))).rejects.toThrow(/source root has unsafe ownership/);
      }
      expect(counters).toEqual({ chmod: 0, rm: 0 });
      expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");
      expect(readdirSync(typeRoot)).toEqual([f.source.id]);

      await expect(attempt(ordinaryOps)).resolves.toMatchObject({ status: "published" });
      expect(lstatSync(f.storage).mode & 0o777).toBe(0o700);
      expect(lstatSync(typeRoot).mode & 0o777).toBe(0o700);
      expect(lstatSync(sourceRoot).mode & 0o777).toBe(0o700);
      expect(lstatSync(f.source.localPath).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(sourceRoot, "snapshots")).mode & 0o777).toBe(0o700);
      expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");
    } finally { f.cleanup(); }
  });

  it("fences an old lock holder by exact token and inode before its next managed mutation", async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.storage, "git-md"), { recursive: true });
      let postTakeoverMutations = 0;
      await expect(withGitMdMaterializerLock(f.source.id, { sourceStorageDir: f.storage }, async ({ assertOwnership }) => {
        const lock = join(f.storage, "git-md", `.lock-${f.source.id}`);
        const displaced = `${lock}.displaced`;
        renameSync(lock, displaced);
        mkdirSync(lock, { mode: 0o700 });
        writeFileSync(join(lock, "owner.json"), JSON.stringify({
          token: "new-owner", heartbeatAt: Date.now(), pid: process.pid, host: "new-host",
        }));
        assertOwnership();
        postTakeoverMutations += 1;
      })).rejects.toThrow(/lock ownership was lost/);
      expect(postTakeoverMutations).toBe(0);
    } finally { f.cleanup(); }
  });

  it("fences takeover at fetch, materialization, publish/current, and removal boundaries while a new owner converges", async () => {
    // Fetch: the old worker may finish its child process, but cannot promote the repository or begin a run.
    {
      const f = fixture();
      let release: () => void = () => undefined;
      try {
        const takeoverFetch = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
          const rewritten = [...args].map((arg) => arg === f.canonicalRemote ? f.upstream : arg)
            .map((arg) => arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg);
          if (!args.includes("fetch")) return execFile(file, rewritten, options, callback as never);
          const child = execFile(file, rewritten, options, callback as never);
          release = displaceSourceLock(f.storage, f.source.id);
          return child;
        }) as unknown as typeof execFile;
        await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: { execFile: takeoverFetch } }))
          .rejects.toThrow(/lock ownership was lost/);
        expect(f.core.listSourceRuns(f.source.id)).toEqual([]);
        expect(existsSync(f.source.localPath)).toBe(false);
        release(); release = () => undefined;
        await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "published" });
      } finally { release(); f.cleanup(); }
    }

    // Materialization: takeover after blob extraction cannot seal/promote a snapshot or begin a run.
    {
      const f = fixture();
      let release: () => void = () => undefined;
      try {
        await expect(f.core.syncGitMdSource(f.source.id, { materializer: { fault: (point) => {
          if (point === "after-archive") release = displaceSourceLock(f.storage, f.source.id);
        } } })).rejects.toThrow(/lock ownership was lost/);
        expect(f.core.listSourceRuns(f.source.id)).toEqual([]);
        release(); release = () => undefined;
        await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "published" });
      } finally { release(); f.cleanup(); }
    }

    // Durable publish may precede takeover, but current stays absent until the replacement owner authenticates and repairs it.
    {
      const f = fixture();
      let release: () => void = () => undefined;
      try {
        await expect(f.core.syncGitMdSource(f.source.id, { fault: (point) => {
          if (point === "after-publish") release = displaceSourceLock(f.storage, f.source.id);
        } })).rejects.toThrow(/lock ownership was lost/);
        const active = f.core.getSource(f.source.id)!;
        expect(active.activeRunId).toEqual(expect.any(String));
        expect(existsSync(join(f.storage, "git-md", f.source.id, "current"))).toBe(false);
        release(); release = () => undefined;
        await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "noop" });
        expect(f.core.sourcePath(f.source.id, f.auth).revision).toBe(active.activeSnapshotId);
      } finally { release(); f.cleanup(); }
    }

    // Removal takeover after current revocation cannot touch ledger evidence; the replacement owner finishes it exactly once.
    {
      const f = fixture();
      let release: () => void = () => undefined;
      try {
        await f.core.syncGitMdSource(f.source.id);
        const activeRun = f.core.getSource(f.source.id)!.activeRunId!;
        expect(f.core.listSourceChunks(activeRun, true)).toHaveLength(1);
        f.core.removeSource(f.source.id);
        await expect(f.core.syncGitMdSource(f.source.id, { fault: (point) => {
          if (point === "after-remove-current") release = displaceSourceLock(f.storage, f.source.id);
        } })).rejects.toThrow(/lock ownership was lost/);
        expect(f.core.getSourceRemoval(f.source.id)?.state).toBe("retiring");
        expect(f.core.listSourceRemovalItems(f.source.id)[0]?.acknowledgedAt).toBeNull();
        release(); release = () => undefined;
        await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "removed" });
        expect(f.core.listSourceRemovalItems(f.source.id)[0]?.acknowledgedAt).not.toBeNull();
      } finally { release(); f.cleanup(); }
    }
  });

  it("ignores forged trusted materializer keys and never creates an alternate git hierarchy", async () => {
    const f = fixture();
    try {
      const alternate = join(f.root, "alternate-sources");
      const forged = {
        sourceStorageDir: alternate,
        config: { include: ["missing.md"], exclude: [], limits: {} },
        lockStaleMs: 1,
        now: () => Number.MAX_SAFE_INTEGER,
      } as unknown as NonNullable<GitMdSyncOptions["materializer"]>;
      await expect(f.core.syncGitMdSource(f.source.id, { materializer: forged })).resolves.toMatchObject({ status: "published" });
      expect(existsSync(alternate)).toBe(false);
      expect(f.core.getSource(f.source.id)?.localPath).toBe(f.source.localPath);
      expect(readFileSync(join(f.core.sourcePath(f.source.id, f.auth).path, "README.md"), "utf8")).toContain("first");
    } finally { f.cleanup(); }
  });

  it("kills bounded local readers, releases the lock, and retries with a pinned executable", async () => {
    const f = fixture();
    try {
      mkdirSync(f.storage, { recursive: true });
      const oid = await syncManagedGitRepository(f.source, f.storage, { execFile: f.localRemoteExec });
      const hangingGit = join(f.root, "hanging-git");
      writeFileSync(hangingGit, `#!${process.execPath}\nprocess.stderr.write('remote-controlled-secret');setInterval(()=>{},1000);\n`, { mode: 0o700 });
      chmodSync(hangingGit, 0o700);
      const started = Date.now();
      const bounded = { sourceStorageDir: f.storage, localGitTimeoutMs: 30, gitExecutable: hangingGit };
      const failure = await withGitMdMaterializerLock(f.source.id, bounded, () =>
        materializeGitMdCommit(f.source, oid, bounded)).then(() => null, (error: unknown) => error as Error);
      expect(failure?.message).toBe("managed git-md fsck timed out");
      expect(failure?.message).not.toContain("remote-controlled-secret");
      expect(failure?.message.length).toBeLessThan(128);
      expect(Date.now() - started).toBeLessThan(2_000);
      await expect(withGitMdMaterializerLock(f.source.id, { sourceStorageDir: f.storage }, () =>
        materializeGitMdCommit(f.source, oid, { sourceStorageDir: f.storage }))).resolves.toMatchObject({ snapshotId: oid });
    } finally { f.cleanup(); }
  });

  it("uses the injected streaming spawn seam, kills a hanging blob reader, and permits retry", async () => {
    const f = fixture();
    try {
      mkdirSync(f.storage, { recursive: true });
      const oid = await syncManagedGitRepository(f.source, f.storage, { execFile: f.localRemoteExec });
      const hangingChild = join(f.root, "hanging-child");
      writeFileSync(hangingChild, `#!${process.execPath}\nprocess.stderr.write('untrusted blob stderr');setInterval(()=>{},1000);\n`, { mode: 0o700 });
      chmodSync(hangingChild, 0o700);
      let invoked = 0;
      const hangingSpawn = ((file: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
        invoked += 1;
        expect(file).not.toBe("git");
        expect(args).toEqual(expect.arrayContaining(["cat-file", "blob"]));
        return spawn(hangingChild, [], options);
      }) as unknown as typeof spawn;
      const bounded = { sourceStorageDir: f.storage, localGitTimeoutMs: 150, spawn: hangingSpawn };
      const failure = await withGitMdMaterializerLock(f.source.id, bounded, () =>
        materializeGitMdCommit(f.source, oid, bounded)).then(() => null, (error: unknown) => error as Error);
      expect(failure?.message).toBe("Git blob extraction timed out");
      expect(failure?.message).not.toContain("untrusted blob stderr");
      expect(failure?.message.length).toBeLessThan(128);
      expect(invoked).toBe(1);
      await expect(withGitMdMaterializerLock(f.source.id, { sourceStorageDir: f.storage }, () =>
        materializeGitMdCommit(f.source, oid, { sourceStorageDir: f.storage }))).resolves.toMatchObject({ snapshotId: oid });
    } finally { f.cleanup(); }
  });

  it("enforces one deadline across serial blob extraction, releases the lock, and retries", async () => {
    const f = fixture();
    try {
      const first = await f.core.syncSource(f.source.id, f.auth);
      const published = f.core.sourcePath(f.source.id, f.auth).path;
      for (let index = 0; index < 24; index += 1) writeFileSync(join(f.upstream, `slow-${index}.md`), `# Slow ${index}\n\nbody\n`);
      git(f.upstream, "add", "."); git(f.upstream, "commit", "-m", "many blobs");
      f.core.updateSource(f.source.id, { include: ["*.md"] });
      const realGit = realpathSync.native(execFileSync("which", ["git"], { encoding: "utf8" }).trim());
      const slowGit = join(f.root, "slow-git");
      writeFileSync(slowGit, `#!${process.execPath}\nconst {spawn}=require('node:child_process');const args=process.argv.slice(2);const run=()=>{const c=spawn(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});c.on('error',()=>process.exit(74));c.on('close',(n,s)=>process.exit(n??(s?74:0)))};if(args.includes('cat-file')&&args.includes('blob'))setTimeout(run,35);else run();\n`, { mode: 0o700 });
      chmodSync(slowGit, 0o700);
      const started = Date.now();
      await expect(f.core.syncGitMdSource(f.source.id, {
        materializer: { gitExecutable: slowGit, localGitTimeoutMs: 2_000, materializationDeadlineMs: 250 },
      })).rejects.toThrow(/materialization deadline exceeded/);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("first");
      expect(f.core.getSource(f.source.id)?.activeSnapshotId).toBe(first.snapshotId);
      await expect(f.core.syncSource(f.source.id, f.auth)).resolves.toMatchObject({ status: "published" });
      expect(readFileSync(join(f.core.sourcePath(f.source.id, f.auth).path, "slow-23.md"), "utf8")).toContain("body");
    } finally { f.cleanup(); }
  }, 30_000);

  it("uses a bounded noninteractive runner with hostile Git state scrubbed", async () => {
    const prior = process.env.GIT_DIR;
    process.env.GIT_DIR = "/attacker/repository";
    try {
      const fake = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
        expect(file).toBe("git");
        expect(args).toEqual(expect.arrayContaining([
          "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "http.followRedirects=false",
        ]));
        const env = options.env as NodeJS.ProcessEnv;
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
        expect(env.GIT_DIR).toBeUndefined();
        callback(null, "ok\n", "");
      }) as unknown as typeof execFile;
      await expect(runRemoteGit(["version"], "/tmp", { execFile: fake, timeoutMs: 1000, maxOutputBytes: 1024 })).resolves.toBe("ok");
    } finally {
      if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior;
    }
  });

  it("kills the complete remote process group on deadline and releases the source lock within the bound", async () => {
    const f = fixture();
    try {
      const childPidPath = join(f.root, "remote-child.pid");
      let parentPid = 0;
      const hanging = ((_: string, __: readonly string[], options: Record<string, unknown>) => {
        const script = `trap '' TERM; sh -c 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done' sh "$1" & while :; do sleep 1; done`;
        const child = spawn("/bin/sh", ["-c", script, "sh", childPidPath], options);
        parentPid = child.pid!;
        return child;
      }) as unknown as typeof spawn;
      const startedAt = Date.now();
      await expect(withGitMdMaterializerLock("remote-tree-timeout", { sourceStorageDir: f.storage }, async ({ assertOwnership }) =>
        runRemoteGit(["version"], f.root, { spawn: hanging, timeoutMs: 30 }, {}, [], undefined, assertOwnership)))
        .rejects.toThrow(/remote Git timed out/);
      expect(Date.now() - startedAt).toBeLessThan(1000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const grandchildPid = Number(readFileSync(childPidPath, "utf8"));
      const isRunning = (pid: number): boolean => {
        try {
          const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
          return state !== "" && !state.startsWith("Z");
        } catch { return false; }
      };
      for (const pid of [parentPid, grandchildPid]) expect(isRunning(pid)).toBe(false);
      await expect(withGitMdMaterializerLock("remote-tree-timeout", { sourceStorageDir: f.storage }, async () => "reacquired"))
        .resolves.toBe("reacquired");
    } finally { f.cleanup(); }
  });

  it("revokes public authorization during a hung fetch, kills the child, and permits a newly authorized retry", async () => {
    const f = fixture();
    try {
      let fetchStarted!: () => void;
      const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
      let fetchPid = 0;
      let capturedFetchEnv: NodeJS.ProcessEnv | null = null;
      const hangingFetch = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
        if (!args.includes("fetch")) return f.localRemoteExec(file, args, options, callback as never);
        capturedFetchEnv = options.env as NodeJS.ProcessEnv;
        const child = execFile("/bin/sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], options, callback as never);
        fetchPid = child.pid!;
        fetchStarted();
        return child;
      }) as unknown as typeof execFile;
      const internals = f.core as unknown as { sourceGit: RemoteGitOptions };
      internals.sourceGit = {
        execFile: hangingFetch,
        credentialProvider: { get: async () => ({ username: "revoked-user", password: "revoked-secret" }) },
      };
      const pending = f.core.syncSource(f.source.id, f.auth);
      await started;
      f.core.updateSource(f.source.id, { access: { allowedCallerIds: ["other"], allowedProjectIds: ["project"] } });
      await expect(pending).rejects.toThrow(/source is unavailable/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(() => process.kill(fetchPid, 0)).toThrow();
      expect(capturedFetchEnv).not.toBeNull();
      expect(capturedFetchEnv).not.toHaveProperty("MONET_GIT_USERNAME");
      expect(capturedFetchEnv).not.toHaveProperty("MONET_GIT_PASSWORD");
      expect(f.core.resumeSourceRun(f.source.id)).toBeNull();
      expect(readdirSync(join(f.storage, "git-md")).filter((name) => name.startsWith(`.clone.${f.source.id}.`))).toHaveLength(1);
      f.core.updateSource(f.source.id, { access: f.source.access });
      internals.sourceGit = { execFile: f.localRemoteExec };
      await expect(f.core.syncSource(f.source.id, f.auth)).resolves.toMatchObject({ status: "published" });
      expect(readdirSync(join(f.storage, "git-md")).filter((name) => name.startsWith(`.clone.${f.source.id}.`))).toEqual([]);
    } finally { f.cleanup(); }
  });

  it("uses remote-helper-capable fetch with one forced branch refspec and hardened HTTPS credentials", async () => {
    const f = fixture();
    const username = "credential-user";
    const password = "credential-password";
    let fetchCalls = 0;
    let isolatedRoot: string | null = null;
    const inheritedHome = process.env.HOME;
    try {
      const hostileHome = join(f.root, "host-home");
      mkdirSync(hostileHome); writeFileSync(join(hostileHome, ".netrc"), "machine example.test login ambient password canary\n");
      process.env.HOME = hostileHome;
      const inspectingExec = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
        expect(args).not.toContain("fetch-pack");
        if (args.includes("fetch")) {
          fetchCalls += 1;
          expect(file).toBe("/bin/sh");
          expect(args).toEqual(expect.arrayContaining([
            "fetch", "--no-progress", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--force",
            f.canonicalRemote, "+refs/heads/main:refs/monet/candidate",
            "credential.helper=", "credential.useHttpPath=true", "http.followRedirects=false",
            "fetch.unpackLimit=1", "transfer.unpackLimit=1", "protocol.ssh.allow=never",
          ]));
          expect(args.indexOf("fetch")).toBeLessThan(args.indexOf(f.canonicalRemote));
          const env = options.env as NodeJS.ProcessEnv;
          expect(env.GIT_TERMINAL_PROMPT).toBe("0");
          expect(env.GIT_LFS_SKIP_SMUDGE).toBe("1");
          expect(env.GIT_ASKPASS_REQUIRE).toBe("force");
          expect(readFileSync(env.GIT_ASKPASS!, "utf8")).toContain("*Password*");
          expect(env.MONET_GIT_USERNAME).toBe(username);
          expect(env.MONET_GIT_PASSWORD).toBe(password);
          expect(env.HOME).not.toBe(hostileHome);
          expect(readdirSync(env.HOME!)).toEqual([]);
          expect(readdirSync(env.XDG_CONFIG_HOME!)).toEqual([]);
          expect(env.CURL_HOME).toBe(env.HOME);
          expect(env.NETRC).toBe("/dev/null");
          isolatedRoot = dirname(env.HOME!);
        }
        return f.localRemoteExec(file, args, options, callback as never);
      }) as unknown as typeof execFile;
      mkdirSync(f.storage, { recursive: true });
      await expect(syncManagedGitRepository(f.source, f.storage, {
        execFile: inspectingExec,
        credentialProvider: { get: async () => ({ username, password }) },
      })).resolves.toMatch(/^[0-9a-f]{40,64}$/);
      expect(fetchCalls).toBe(1);
      expect(isolatedRoot).not.toBeNull();
      expect(existsSync(isolatedRoot!)).toBe(false);
      expect(existsSync(join(f.source.localPath, "FETCH_HEAD"))).toBe(false);
      expect(existsSync(join(f.source.localPath, "refs", "remotes"))).toBe(false);
      expect(git(f.source.localPath, "rev-parse", "refs/monet/candidate^{commit}")).toBe(git(f.upstream, "rev-parse", "refs/heads/main"));
    } finally {
      if (inheritedHome === undefined) delete process.env.HOME; else process.env.HOME = inheritedHome;
      f.cleanup();
    }
  });

  it("pins the candidate fetched before a remote branch moves and never consults remote HEAD", async () => {
    const f = fixture();
    let moved = false;
    try {
      mkdirSync(f.storage, { recursive: true });
      const fetched = git(f.upstream, "rev-parse", "refs/heads/main");
      const movingExec = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
        const wrapped = (error: Error | null, stdout: string, stderr: string) => {
          if (!error && !moved && args.includes("fetch")) {
            moved = true;
            writeFileSync(join(f.upstream, "README.md"), "# Moved\n\nafter fetch\n");
            git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "move after fetch");
          }
          callback(error, stdout, stderr);
        };
        return f.localRemoteExec(file, args, options, wrapped as never);
      }) as unknown as typeof execFile;
      await expect(syncManagedGitRepository(f.source, f.storage, { execFile: movingExec })).resolves.toBe(fetched);
      expect(moved).toBe(true);
      expect(git(f.source.localPath, "rev-parse", "refs/monet/candidate^{commit}")).toBe(fetched);
      expect(git(f.upstream, "rev-parse", "refs/heads/main")).not.toBe(fetched);
      expect(existsSync(join(f.source.localPath, "refs", "remotes", "origin", "HEAD"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("does not expose ambient host credentials to anonymous HTTPS children", async () => {
    const f = fixture();
    const inheritedHome = process.env.HOME;
    try {
      const hostileHome = join(f.root, "ambient-home");
      mkdirSync(hostileHome);
      writeFileSync(join(hostileHome, ".netrc"), "machine example.test login ambient-user password ambient-secret\n");
      process.env.HOME = hostileHome;
      const inspectingExec = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
        if (args.includes("fetch")) {
          const env = options.env as NodeJS.ProcessEnv;
          expect(env.HOME).not.toBe(hostileHome);
          expect(readdirSync(env.HOME!)).toEqual([]);
          expect(env.GIT_ASKPASS).toBeUndefined();
          expect(env.MONET_GIT_USERNAME).toBeUndefined();
          expect(env.MONET_GIT_PASSWORD).toBeUndefined();
        }
        return f.localRemoteExec(file, args, options, callback as never);
      }) as unknown as typeof execFile;
      mkdirSync(f.storage, { recursive: true });
      await expect(syncManagedGitRepository(f.source, f.storage, { execFile: inspectingExec })).resolves.toMatch(/^[0-9a-f]+$/);
    } finally {
      if (inheritedHome === undefined) delete process.env.HOME; else process.env.HOME = inheritedHome;
      f.cleanup();
    }
  });

  it("passes a fixed noninteractive SSH command without HTTPS credentials", async () => {
    const f = fixture();
    let fetchCalls = 0;
    let providerCalls = 0;
    let privateKnownHosts: string | undefined;
    const inheritedAgent = process.env.SSH_AUTH_SOCK;
    try {
      process.env.SSH_AUTH_SOCK = join(f.root, "agent.sock");
      mkdirSync(f.storage, { recursive: true });
      const source = {
        ...f.source, remoteUrl: "ssh://git@example.test/acme/docs", transport: {
          allowedUrlSchemes: ["ssh" as const], allowedHosts: ["example.test"],
        },
      };
      const knownHosts = join(f.root, "known_hosts");
      const originalTrust = "example.test ssh-ed25519 AAAATEST\n";
      writeFileSync(knownHosts, originalTrust, { mode: 0o600 });
      const trustedKnownHosts = realpathSync.native(knownHosts);
      const originalInode = lstatSync(knownHosts).ino;
      const sshExec = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
        if (args.includes("fetch") || args.includes("ls-remote")) {
          fetchCalls += 1;
          expect(args).toEqual(expect.arrayContaining(["protocol.ssh.allow=always", "protocol.https.allow=never"]));
          const env = options.env as NodeJS.ProcessEnv;
          const match = /-oUserKnownHostsFile='([^']+)'/.exec(env.GIT_SSH_COMMAND!);
          expect(match).not.toBeNull();
          privateKnownHosts = match![1]!;
          expect(privateKnownHosts).not.toBe(trustedKnownHosts);
          expect(dirname(privateKnownHosts)).toBe(env.HOME);
          expect(lstatSync(privateKnownHosts).mode & 0o777).toBe(0o400);
          // A same-inode overwrite of the external trust store after the
          // snapshot must not affect the bytes SSH is about to consume.
          writeFileSync(knownHosts, "example.test ssh-ed25519 BBBATEST\n");
          expect(lstatSync(knownHosts).ino).toBe(originalInode);
          expect(readFileSync(privateKnownHosts, "utf8")).toBe(originalTrust);
          expect(env.GIT_SSH_COMMAND).toBe(`ssh -F /dev/null -oBatchMode=yes -oStrictHostKeyChecking=yes -oUserKnownHostsFile='${privateKnownHosts}' -oGlobalKnownHostsFile=/dev/null -oUpdateHostKeys=no -oClearAllForwardings=yes -oForwardAgent=no -oForwardX11=no -oPermitLocalCommand=no`);
          expect(env.GIT_SSH_VARIANT).toBe("ssh");
          expect(env.SSH_ASKPASS).toBe("/bin/false");
          expect(env.SSH_AUTH_SOCK).toBe(process.env.SSH_AUTH_SOCK);
          expect(env.GIT_ASKPASS).toBeUndefined();
          return callback(new Error("expected SSH stop"), "", "");
        }
        return execFile(file, args, options, callback as never);
      }) as unknown as typeof execFile;
      await expect(syncManagedGitRepository(source, f.storage, {
        execFile: sshExec,
        sshKnownHostsProvider: { get: async () => { providerCalls += 1; return trustedKnownHosts; } },
      })).rejects.toThrow(/expected SSH stop/);
      expect(fetchCalls).toBe(1);
      expect(providerCalls).toBe(1);
      expect(privateKnownHosts).toBeDefined();
      expect(existsSync(privateKnownHosts!)).toBe(false);
    } finally {
      if (inheritedAgent === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = inheritedAgent;
      f.cleanup();
    }
  });

  it("bounds the SSH trust provider before staging, releases its lock, and ignores a late result", async () => {
    const f = fixture();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const knownHosts = join(f.root, "known_hosts");
      writeFileSync(knownHosts, "example.test ssh-ed25519 AAAATEST\n", { mode: 0o600 });
      const source = f.core.createSource({
        id: "ssh-provider-timeout", type: "git-md", name: "SSH docs",
        remoteUrl: "ssh://git@example.test/acme/docs", branch: "main", circle: "remote-docs",
        include: ["README.md"], access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] },
        transport: { allowedUrlSchemes: ["ssh"], allowedHosts: ["example.test"] },
      });
      let rejectProvider!: (error: Error) => void;
      let providerStarted!: () => void;
      const started = new Promise<void>((resolve) => { providerStarted = resolve; });
      const provider = new Promise<string>((_resolve, reject) => { rejectProvider = reject; });
      const pending = f.core.syncGitMdSource(source.id, { remoteGit: {
        timeoutMs: 20,
        sshKnownHostsProvider: { get: async () => { providerStarted(); return provider; } },
      } });
      await started;
      expect(readdirSync(join(f.storage, "git-md")).filter((name) => name.startsWith(`.clone.${source.id}.`))).toEqual([]);
      expect(existsSync(source.localPath)).toBe(false);
      f.core.removeSource(source.id);
      await expect(pending).rejects.toThrow(/active registered git-md source/);

      // The timed-out owner released the per-source lock, so removal can take
      // it immediately; the provider's later value cannot resume setup.
      await expect(f.core.syncGitMdSource(source.id)).resolves.toMatchObject({ status: "removed" });
      rejectProvider(new Error("late opaque provider rejection"));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unhandled).toEqual([]);
      expect(readdirSync(join(f.storage, "git-md")).filter((name) => name.includes(source.id))).toEqual([]);

      const rejected = { ...f.source, remoteUrl: "ssh://git@example.test/acme/docs", transport: {
        allowedUrlSchemes: ["ssh" as const], allowedHosts: ["example.test"],
      } };
      await expect(syncManagedGitRepository(rejected, f.storage, {
        sshKnownHostsProvider: { get: async () => { throw new Error("trust provider rejected"); } },
      })).rejects.toThrow(/^Git SSH known_hosts provider failed$/);
      expect(readdirSync(join(f.storage, "git-md")).filter((name) => name.startsWith(`.clone.${f.source.id}.`))).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      f.cleanup();
    }
  });

  it("contains opaque provider failures at the boundary and in durable status", async () => {
    const f = fixture();
    const opaque = `opaque-provider-token-${"x".repeat(5000)}`;
    try {
      const credentialError = await f.core.syncGitMdSource(f.source.id, { remoteGit: {
        credentialProvider: { get: async () => { throw { opaque }; } },
      } }).then(() => null, (error: unknown) => error as Error);
      expect(credentialError).toBeInstanceOf(Error);
      expect(credentialError!.message).toBe("Git credential provider failed");
      expect(credentialError!.message.length).toBeLessThanOrEqual(1024);
      expect(credentialError!.message).not.toContain(opaque);

      const status = f.core.sourceStatus(f.source.id, f.auth);
      expect(status).toMatchObject({ lastSyncResult: "failed", lastError: "Git credential provider failed" });
      expect(status.lastError!.length).toBeLessThanOrEqual(1024);
      expect(status.lastError).not.toContain(opaque);
      const db = (f.core as unknown as { db: StoragePort }).db;
      const prePin = db.prepare(`SELECT reason FROM source_pre_pin_attempts WHERE source_id=?`).get(f.source.id) as { reason: string };
      const event = db.prepare(`SELECT failure_reason FROM source_attempt_events WHERE source_id=? ORDER BY sequence DESC LIMIT 1`)
        .get(f.source.id) as { failure_reason: string };
      expect(prePin.reason).toBe("Git credential provider failed");
      expect(event.failure_reason).toBe("Git credential provider failed");
      expect(prePin.reason.length).toBeLessThanOrEqual(1024);
      expect(event.failure_reason.length).toBeLessThanOrEqual(1024);
      expect(JSON.stringify({ prePin, event })).not.toContain(opaque);

      const sshSource = {
        ...f.source, remoteUrl: "ssh://git@example.test/acme/docs", transport: {
          allowedUrlSchemes: ["ssh" as const], allowedHosts: ["example.test"],
        },
      };
      const trustError = await syncManagedGitRepository(sshSource, f.storage, {
        sshKnownHostsProvider: { get: async () => { throw new Error(opaque); } },
      }).then(() => null, (error: unknown) => error as Error);
      expect(trustError).toBeInstanceOf(Error);
      expect(trustError!.message).toBe("Git SSH known_hosts provider failed");
      expect(trustError!.message.length).toBeLessThanOrEqual(1024);
      expect(trustError!.message).not.toContain(opaque);
      expect(readdirSync(join(f.storage, "git-md")).filter((name) => name.startsWith(`.clone.${f.source.id}.`))).toEqual([]);
    } finally { f.cleanup(); }
  });

  it("fails SSH closed for missing, symlinked, hardlinked, unsafe, or oversized known_hosts stores and cleans staging", async () => {
    const f = fixture();
    try {
      mkdirSync(f.storage, { recursive: true });
      const source = {
        ...f.source, remoteUrl: "ssh://git@example.test/acme/docs", transport: {
          allowedUrlSchemes: ["ssh" as const], allowedHosts: ["example.test"],
        },
      };
      const knownHosts = join(f.root, "known_hosts");
      await expect(syncManagedGitRepository(source, f.storage, { sshKnownHostsPath: knownHosts }))
        .rejects.toThrow(/known_hosts store is unavailable/);
      writeFileSync(knownHosts, "example.test ssh-ed25519 AAAATEST\n");
      const trustedKnownHosts = realpathSync.native(knownHosts);
      const link = join(f.root, "known_hosts-link");
      symlinkSync(knownHosts, link);
      await expect(syncManagedGitRepository(source, f.storage, { sshKnownHostsPath: link }))
        .rejects.toThrow(/canonical regular file/);

      const hardlink = join(f.root, "known_hosts-hardlink");
      linkSync(knownHosts, hardlink);
      await expect(syncManagedGitRepository(source, f.storage, { sshKnownHostsPath: hardlink }))
        .rejects.toThrow(/canonical regular file/);
      rmSync(hardlink);
      chmodSync(knownHosts, 0o622);
      await expect(syncManagedGitRepository(source, f.storage, { sshKnownHostsPath: trustedKnownHosts }))
        .rejects.toThrow(/unsafe ownership or permissions/);
      chmodSync(knownHosts, 0o600);

      if (typeof process.getuid === "function") {
        const actualUid = process.getuid();
        const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
        Object.defineProperty(process, "getuid", { configurable: true, value: () => actualUid + 1 });
        try {
          await expect(syncManagedGitRepository(source, f.storage, { sshKnownHostsPath: trustedKnownHosts }))
            .rejects.toThrow(/unsafe ownership|unsafe ownership or permissions/);
        } finally { Object.defineProperty(process, "getuid", descriptor!); }
      }

      const oversized = join(f.root, "known_hosts-oversized");
      writeFileSync(oversized, Buffer.alloc(1024 * 1024 + 1, 0x61), { mode: 0o600 });
      await expect(syncManagedGitRepository(source, f.storage, { sshKnownHostsPath: realpathSync.native(oversized) }))
        .rejects.toThrow(/byte limit/);
      const tooManyLines = join(f.root, "known_hosts-lines");
      writeFileSync(tooManyLines, "host key\n".repeat(10_001), { mode: 0o600 });
      await expect(syncManagedGitRepository(source, f.storage, { sshKnownHostsPath: realpathSync.native(tooManyLines) }))
        .rejects.toThrow(/line limit/);
      expect(readdirSync(join(f.storage, "git-md")).filter((name) => name.startsWith(".clone.git-source."))).toEqual([]);
    } finally { f.cleanup(); }
  });

  it("keeps the private SSH trust snapshot authoritative when the external path is replaced", async () => {
    const f = fixture();
    try {
      mkdirSync(f.storage, { recursive: true });
      const source = {
        ...f.source, remoteUrl: "ssh://git@example.test/acme/docs", transport: {
          allowedUrlSchemes: ["ssh" as const], allowedHosts: ["example.test"],
        },
      };
      const knownHosts = join(f.root, "known_hosts");
      writeFileSync(knownHosts, "example.test ssh-ed25519 AAAATEST\n", { mode: 0o600 });
      const trustedKnownHosts = realpathSync.native(knownHosts);

      let fetches = 0;
      const replacingExec = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
        const rewritten = [...args]
          .map((arg) => arg === "ssh://git@example.test/acme/docs" ? f.upstream : arg)
          .map((arg) => arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg);
        if (args.includes("fetch")) {
          fetches += 1;
          return execFile(file, rewritten, options, (error, stdout, stderr) => {
            const replacement = `${knownHosts}.replacement`;
            writeFileSync(replacement, "example.test ssh-ed25519 BBBATEST\n");
            renameSync(replacement, knownHosts);
            callback(error, stdout, stderr);
          });
        }
        return execFile(file, rewritten, options, callback as never);
      }) as unknown as typeof execFile;
      await expect(syncManagedGitRepository(source, f.storage, { execFile: replacingExec, sshKnownHostsPath: trustedKnownHosts }))
        .resolves.toMatch(/^[0-9a-f]+$/);
      expect(fetches).toBe(1);
      expect(readdirSync(join(f.storage, "git-md")).filter((name) => name.startsWith(".clone.git-source."))).toEqual([]);
    } finally { f.cleanup(); }
  });

  it("rejects invalid UTF-8 Git path bytes before staging and preserves the prior publication", async () => {
    const f = fixture();
    try {
      const first = await f.core.syncSource(f.source.id, f.auth);
      const published = f.core.sourcePath(f.source.id, f.auth).path;
      const beforeRuns = f.core.listSourceRuns(f.source.id).length;
      f.core.updateSource(f.source.id, { include: ["**"] });

      const index = join(f.root, "invalid-path.index");
      const env = { ...process.env, GIT_INDEX_FILE: index };
      execFileSync("git", ["read-tree", "HEAD"], { cwd: f.upstream, env });
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: f.upstream, input: "# Invalid\n\nbytes\n", encoding: "utf8",
      }).trim();
      const invalidPath = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x6d, 0x64]);
      execFileSync("git", ["update-index", "-z", "--index-info"], {
        cwd: f.upstream, env,
        input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), invalidPath, Buffer.from([0])]),
      });
      const tree = execFileSync("git", ["write-tree"], { cwd: f.upstream, env, encoding: "utf8" }).trim();
      const parent = git(f.upstream, "rev-parse", "HEAD");
      const commit = execFileSync("git", ["commit-tree", tree, "-p", parent], {
        cwd: f.upstream, input: "invalid path\n", encoding: "utf8",
      }).trim();
      git(f.upstream, "update-ref", "refs/heads/main", commit);

      await expect(f.core.syncGitMdSource(f.source.id)).rejects.toThrow(/invalid UTF-8 pathname/);
      expect(f.core.listSourceRuns(f.source.id)).toHaveLength(beforeRuns);
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("first");
      expect(f.core.getSource(f.source.id)?.activeSnapshotId).toBe(first.snapshotId);
      const snapshots = join(f.storage, "git-md", f.source.id, "snapshots");
      expect(existsSync(snapshots) ? readdirSync(snapshots).some((name) => name.includes(commit)) : false).toBe(false);
    } finally { f.cleanup(); }
  });

  it("cleans clone and askpass artifacts for every credential setup failure", async () => {
    const f = fixture();
    try {
      await f.core.syncSource(f.source.id, f.auth);
      const published = f.core.sourcePath(f.source.id, f.auth).path;
      const askpassBefore = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("monet-askpass-")));
      const envBefore = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("monet-git-env-")));
      const failures = [
        { credentialProvider: { get: async () => { throw new Error("provider rejected"); } } },
        { timeoutMs: 10, credentialProvider: { get: async () => await new Promise<never>(() => undefined) } },
        { credentialProvider: { get: async () => ({ username: "", password: "invalid-secret-value" }) } },
        {
          credentialProvider: { get: async () => ({ username: "valid-user", password: "exact-secret-value" }) },
          credentialHelperFault: () => { throw new Error("helper creation failed"); },
        },
      ] as const;
      for (const remoteGit of failures) {
        await expect(f.core.syncGitMdSource(f.source.id, { remoteGit })).rejects.toThrow();
        expect(readFileSync(join(published, "README.md"), "utf8")).toContain("first");
        expect(readdirSync(join(f.storage, "git-md")).filter((name) => name.startsWith(`.clone.${f.source.id}.`))).toEqual([]);
        expect(readdirSync(tmpdir()).filter((name) => name.startsWith("monet-askpass-") && !askpassBefore.has(name))).toEqual([]);
        expect(readdirSync(tmpdir()).filter((name) => name.startsWith("monet-git-env-") && !envBefore.has(name))).toEqual([]);
      }
      const secret = "exact-secret-value";
      const secretExec = ((_: string, args: readonly string[], ___: Record<string, unknown>, callback: Function) => {
        if (args.includes("fetch")) return callback(new Error(`remote rejected valid-user:${secret}`), "", "");
        return f.localRemoteExec(_, args, ___, callback as never);
      }) as unknown as typeof execFile;
      const redacted = await f.core.syncGitMdSource(f.source.id, { remoteGit: {
        execFile: secretExec, credentialProvider: { get: async () => ({ username: "valid-user", password: secret }) },
      } }).then(() => null, (error: unknown) => error as Error);
      expect(redacted?.message).not.toContain(secret);
      expect(redacted?.message).not.toContain("valid-user");
      expect(f.core.sourceStatus(f.source.id, f.auth).lastError).not.toContain(secret);
      expect(readdirSync(join(f.storage, "git-md")).filter((name) => name.startsWith(`.clone.${f.source.id}.`))).toEqual([]);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith("monet-askpass-") && !askpassBefore.has(name))).toEqual([]);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith("monet-git-env-") && !envBefore.has(name))).toEqual([]);
    } finally { f.cleanup(); }
  });

  it("clones, pins, updates, verifies no-op, exposes a sealed path, and removes locally", async () => {
    const root = mkdtempSync(join(tmpdir(), "monet-git-md-"));
    const upstream = join(root, "upstream");
    const storage = join(root, "sources");
    const db = join(root, "monet.db");
    execFileSync("git", ["init", "-b", "main", upstream]);
    git(upstream, "config", "user.email", "test@example.com");
    git(upstream, "config", "user.name", "Test");
    writeFileSync(join(upstream, "README.md"), "# One\n\nfirst\n");
    git(upstream, "add", "README.md"); git(upstream, "commit", "-m", "one");
    const canonicalRemote = "https://example.test/acme/docs";
    const localRemoteExec = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
      const rewritten = [...args].map((arg) => arg === canonicalRemote ? upstream : arg)
        .map((arg) => arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg);
      execFile(file, rewritten, options, callback as never);
    }) as unknown as typeof execFile;
    const auth = { callerId: "caller", projectId: "project" };
    const core = new MonetCore(db, { sourceStorageDir: storage, sourceGit: { execFile: localRemoteExec } });
    try {
      const source = core.createSource({
        id: "git-source", type: "git-md", name: "Remote docs", remoteUrl: canonicalRemote, branch: "main",
        circle: "remote-docs", include: ["README.md"], access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] },
        transport: { allowedUrlSchemes: ["https"], allowedHosts: ["example.test"] },
      });
      expect(source.localPath).toMatch(/\/sources\/git-md\/git-source\/repository\.git$/);
      expect(existsSync(source.localPath)).toBe(false);
      const failingExec = ((_: string, __: readonly string[], ___: Record<string, unknown>, callback: Function) => {
        callback(new Error("https://user:password@example.test/private"), "", "");
      }) as unknown as typeof execFile;
      await expect(core.syncGitMdSource(source.id, { remoteGit: { execFile: failingExec } })).rejects.toThrow();
      expect(core.sourceStatus(source.id, auth)).toMatchObject({ lastSyncResult: "failed", lastError: expect.not.stringContaining("password") });
      const first = await core.syncSource(source.id, auth);
      expect(first.status).toBe("published");
      expect(readFileSync(join(core.sourcePath(source.id, auth).path, "README.md"), "utf8")).toContain("first");
      await expect(core.syncSource(source.id, auth)).resolves.toMatchObject({ status: "noop" });
      writeFileSync(join(upstream, "README.md"), "# Two\n\nsecond\n");
      git(upstream, "add", "README.md"); git(upstream, "commit", "-m", "two");
      const second = await core.syncSource(source.id, auth);
      expect(second.status).toBe("published");
      expect(second.snapshotId).not.toBe(first.snapshotId);
      expect(readFileSync(join(core.sourcePath(source.id, auth).path, "README.md"), "utf8")).toContain("second");
      core.removeSource(source.id);
      await expect(core.syncGitMdSource(source.id)).resolves.toMatchObject({ status: "removed" });
      expect(existsSync(join(storage, "git-md", source.id))).toBe(false);
    } finally { core.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves an active publication through corrupt, missing, failed, and fenced repository replacement", async () => {
    const f = fixture();
    try {
      await f.core.syncSource(f.source.id, f.auth);
      const published = f.core.sourcePath(f.source.id, f.auth).path;
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("first");

      writeFileSync(join(f.source.localPath, "config"), "[core]\n\tbare = false\n");
      mkdirSync(join(f.source.localPath, "hooks"), { recursive: true });
      writeFileSync(join(f.source.localPath, "hooks", "post-fetch"), "#!/bin/sh\nexit 1\n");
      writeFileSync(join(f.upstream, "README.md"), "# Two\n\nsecond\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "two");
      const failFetch = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
        if (args.includes("fetch") || args.includes("ls-remote")) return callback(new Error("injected fetch failure"), "", "");
        return execFile(file, args, options, callback as never);
      }) as unknown as typeof execFile;
      await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: { execFile: failFetch } })).rejects.toThrow(/fetch failure/);
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("first");

      await expect(f.core.syncSource(f.source.id, f.auth)).resolves.toMatchObject({ status: "published" });
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("second");
      expect(existsSync(join(f.source.localPath, "hooks", "post-fetch"))).toBe(false);

      rmSync(f.source.localPath, { recursive: true, force: true });
      writeFileSync(join(f.upstream, "README.md"), "# Three\n\nthird\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "three");
      await expect(f.core.syncSource(f.source.id, f.auth)).resolves.toMatchObject({ status: "published" });
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("third");

      writeFileSync(join(f.upstream, "README.md"), "# Four\n\nfourth\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "four");
      const syncWithScan = f.core.syncGitMdSource.bind(f.core) as unknown as (
        sourceId: string,
        options: { scan: (input: Parameters<typeof scanSourceSnapshot>[0]) => ReturnType<typeof scanSourceSnapshot> },
      ) => ReturnType<typeof f.core.syncGitMdSource>;
      const partial = await syncWithScan(f.source.id, { scan: (input) => ({
        ...scanSourceSnapshot(input), status: "partial", publishable: false,
        diagnostics: [{ code: "io-error", message: "injected partial scan" }],
      }) });
      expect(partial.status).toBe("partial");
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("third");
      await expect(f.core.syncSource(f.source.id, f.auth)).resolves.toMatchObject({ status: "published" });
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("fourth");

      writeFileSync(join(f.upstream, "README.md"), "# Five\n\nfifth\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "five");
      await expect(f.core.syncGitMdSource(f.source.id, { fault: (point) => {
        if (point === "after-pin") throw new Error("injected fence/crash");
      } })).rejects.toThrow(/fence\/crash/);
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("fourth");
      await expect(f.core.syncSource(f.source.id, f.auth)).resolves.toMatchObject({ status: "published" });
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("fifth");

      const typeRoot = join(f.storage, "git-md");
      mkdirSync(join(typeRoot, `.clone.${f.source.id}.one`), { mode: 0o700 });
      mkdirSync(join(typeRoot, `.repo.${f.source.id}.two`), { mode: 0o700 });
      mkdirSync(join(typeRoot, `.corrupt.${f.source.id}.three`), { mode: 0o700 });
      f.core.removeSource(f.source.id);
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "removed" });
      expect(readdirSync(typeRoot).filter((name) => name.includes(f.source.id))).toEqual([]);
    } finally { f.cleanup(); }
  });

  it("rejects common-dir redirection before Git, preserves publication, and retries after removal", async () => {
    const f = fixture();
    try {
      await f.core.syncSource(f.source.id, f.auth);
      const published = f.core.sourcePath(f.source.id, f.auth).path;
      const external = join(f.root, "external.git");
      execFileSync("git", ["init", "--bare", external]);
      git(external, "config", "core.repositoryformatversion", "1");
      mkdirSync(join(external, "objects", "info"), { recursive: true });
      writeFileSync(join(external, "objects", "info", "alternates"), `${join(f.upstream, ".git", "objects")}\n`);
      writeFileSync(join(f.source.localPath, "commondir"), `${external}\n`);

      writeFileSync(join(f.upstream, "README.md"), "# Redirected\n\nexternal common dir must not win\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "redirect attempt");
      await expect(f.core.syncGitMdSource(f.source.id)).rejects.toThrow(/common-dir redirection/);
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("first");

      rmSync(join(f.source.localPath, "commondir"));
      await expect(f.core.syncSource(f.source.id, f.auth)).resolves.toMatchObject({ status: "published" });
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("external common dir must not win");
    } finally { f.cleanup(); }
  });

  it("isolates prefix-colliding source artifacts and locks, and fails closed on owned symlinks", async () => {
    const f = fixture();
    try {
      const create = (id: string) => f.core.createSource({
        id, type: "git-md" as const, name: id, remoteUrl: f.canonicalRemote, branch: "main",
        circle: `${id}-circle`, include: ["README.md"],
        access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] },
        transport: { allowedUrlSchemes: ["https" as const], allowedHosts: ["example.test"] },
      });
      const a = create("a");
      const ab = create("a-b");
      await f.core.syncGitMdSource(a.id);
      await f.core.syncGitMdSource(ab.id);

      let release!: () => void;
      const barrier = new Promise<void>((resolveBarrier) => { release = resolveBarrier; });
      let held = 0;
      const hold = (id: string) => withGitMdMaterializerLock(id, { sourceStorageDir: f.storage }, async () => {
        held += 1;
        if (held === 2) release();
        await barrier;
      });
      await Promise.all([hold(a.id), hold(ab.id)]);

      const typeRoot = join(f.storage, "git-md");
      const victim = join(f.root, "prefix-victim");
      mkdirSync(victim); writeFileSync(join(victim, "keep"), "safe");
      mkdirSync(join(typeRoot, ".clone.a.owned"), { mode: 0o700 });
      mkdirSync(join(typeRoot, ".clone.a-b.foreign"), { mode: 0o700 });
      symlinkSync(victim, join(typeRoot, ".repo.a-b.foreign"), "dir");

      f.core.removeSource(a.id);
      await expect(f.core.syncGitMdSource(a.id)).resolves.toMatchObject({ status: "removed" });
      expect(existsSync(join(typeRoot, a.id))).toBe(false);
      expect(existsSync(join(typeRoot, ab.id))).toBe(true);
      expect(existsSync(join(typeRoot, ".clone.a-b.foreign"))).toBe(true);
      expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");

      f.core.removeSource(ab.id);
      await expect(f.core.syncGitMdSource(ab.id)).rejects.toThrow(/real (?:direct-child )?directory/);
      expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");
      rmSync(join(typeRoot, ".repo.a-b.foreign"));
      await expect(f.core.syncGitMdSource(ab.id)).resolves.toMatchObject({ status: "removed" });
      expect(existsSync(join(typeRoot, ".clone.a-b.foreign"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("recovers only UUID-suffixed legacy artifacts and rejects ambiguous legacy names without deletion", async () => {
    const f = fixture();
    try {
      await f.core.syncGitMdSource(f.source.id);
      const typeRoot = join(f.storage, "git-md");
      const legacy = join(typeRoot, `.clone-${f.source.id}-123e4567-e89b-42d3-a456-426614174000`);
      const ambiguous = join(typeRoot, `.clone-${f.source.id}-unclear-owner`);
      mkdirSync(legacy, { mode: 0o700 }); mkdirSync(ambiguous, { mode: 0o700 });

      await expect(syncManagedGitRepository(f.core.getSource(f.source.id)!, f.storage, { execFile: f.localRemoteExec }))
        .rejects.toThrow(/ownership is ambiguous/);
      expect(existsSync(legacy)).toBe(true);
      expect(existsSync(ambiguous)).toBe(true);

      rmSync(ambiguous, { recursive: true });
      await expect(syncManagedGitRepository(f.core.getSource(f.source.id)!, f.storage, { execFile: f.localRemoteExec })).resolves.toMatch(/^[0-9a-f]{40,64}$/);
      expect(existsSync(legacy)).toBe(false);
    } finally { f.cleanup(); }
  });

  it("preflights ambiguous repo and corrupt artifacts before any fetch or filesystem cleanup", async () => {
    const f = fixture();
    try {
      await f.core.syncSource(f.source.id, f.auth);
      const typeRoot = join(f.storage, "git-md");
      const published = f.core.sourcePath(f.source.id, f.auth).path;
      const publicationReal = realpathSync.native(published);
      const publicationBody = readFileSync(join(published, "README.md"), "utf8");
      for (const kind of ["repo", "corrupt"] as const) {
        const staleClone = join(typeRoot, `.clone.${f.source.id}.${kind}`);
        const ambiguous = join(typeRoot, `.${kind}-${f.source.id}-unclear-owner`);
        mkdirSync(staleClone, { mode: 0o700 }); writeFileSync(join(staleClone, "keep"), "unchanged"); mkdirSync(ambiguous, { mode: 0o700 });
        const oid = git(f.source.localPath, "rev-parse", "refs/monet/candidate^{commit}");
        const bytes = repositoryBytes(f.source.localPath);
        const digest = repositoryDigest(f.source.localPath);
        let gitCalls = 0;
        const countingExec = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
          gitCalls += 1;
          return f.localRemoteExec(file, args, options, callback as never);
        }) as unknown as typeof execFile;

        await expect(syncManagedGitRepository(f.core.getSource(f.source.id)!, f.storage, { execFile: countingExec }))
          .rejects.toThrow(/ownership is ambiguous/);
        expect(gitCalls).toBe(0);
        expect(readFileSync(join(staleClone, "keep"), "utf8")).toBe("unchanged");
        expect(existsSync(ambiguous)).toBe(true);
        expect(git(f.source.localPath, "rev-parse", "refs/monet/candidate^{commit}")).toBe(oid);
        expect(repositoryBytes(f.source.localPath)).toBe(bytes);
        expect(repositoryDigest(f.source.localPath)).toBe(digest);
        expect(realpathSync.native(published)).toBe(publicationReal);
        expect(readFileSync(join(published, "README.md"), "utf8")).toBe(publicationBody);

        rmSync(ambiguous, { recursive: true });
        await expect(syncManagedGitRepository(f.core.getSource(f.source.id)!, f.storage, { execFile: f.localRemoteExec }))
          .resolves.toMatch(/^[0-9a-f]{40,64}$/);
        expect(existsSync(staleClone)).toBe(false);
      }
    } finally { f.cleanup(); }
  });

  it("preflights every removal artifact before deleting any owned directory", async () => {
    const f = fixture();
    try {
      await f.core.syncSource(f.source.id, f.auth);
      const typeRoot = join(f.storage, "git-md");
      const published = f.core.sourcePath(f.source.id, f.auth).path;
      const publicationBody = readFileSync(join(published, "README.md"), "utf8");
      const owned = join(typeRoot, `.clone.${f.source.id}.must-survive`);
      mkdirSync(owned, { mode: 0o700 }); writeFileSync(join(owned, "keep"), "unchanged");
      const ambiguous = join(typeRoot, `.remove-${f.source.id}-unclear-owner`);
      mkdirSync(ambiguous);
      f.core.removeSource(f.source.id);

      await expect(f.core.syncGitMdSource(f.source.id)).rejects.toThrow(/ownership is ambiguous/);
      expect(readFileSync(join(owned, "keep"), "utf8")).toBe("unchanged");
      expect(existsSync(join(typeRoot, f.source.id))).toBe(true);
      expect(readFileSync(join(published, "README.md"), "utf8")).toBe(publicationBody);

      rmSync(ambiguous, { recursive: true });
      const victim = join(f.root, "removal-victim"); mkdirSync(victim); writeFileSync(join(victim, "keep"), "safe");
      const unsafe = join(typeRoot, `.remove.${f.source.id}.unsafe`); symlinkSync(victim, unsafe, "dir");
      await expect(f.core.syncGitMdSource(f.source.id)).rejects.toThrow(/not a (?:recognized )?real (?:direct-child )?directory/);
      expect(readFileSync(join(owned, "keep"), "utf8")).toBe("unchanged");
      expect(existsSync(join(typeRoot, f.source.id))).toBe(true);
      expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");

      rmSync(unsafe);
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "removed" });
      expect(readdirSync(typeRoot).filter((name) => name.includes(f.source.id))).toEqual([]);
      expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");
    } finally { f.cleanup(); }
  });

  it("durably unlinks auxiliary-only tombstoned artifacts before revoking files", async () => {
    const f = fixture();
    try {
      const typeRoot = join(f.storage, "git-md");
      const auxiliary = join(typeRoot, `.clone.${f.source.id}.orphan`);
      mkdirSync(auxiliary, { recursive: true, mode: 0o700 }); chmodSync(auxiliary, 0o700); writeFileSync(join(auxiliary, "keep"), "owned");
      f.core.removeSource(f.source.id);

      const order: string[] = [];
      const port = f.core as unknown as {
        markSourceRemovalFilesRevoked(sourceId: string): ReturnType<MonetCore["markSourceRemovalFilesRevoked"]>;
      };
      const mark = port.markSourceRemovalFilesRevoked.bind(port);
      port.markSourceRemovalFilesRevoked = (sourceId: string) => { order.push("mark-files-revoked"); return mark(sourceId); };

      await expect(f.core.syncGitMdSource(f.source.id, {
        materializer: { safeTreeOps: { fsyncPath: (path) => order.push(`fsync:${path}`) } },
        fault: (point) => { if (point === "before-remove-complete") throw new Error("crash after files revoked"); },
      })).rejects.toThrow(/crash after files revoked/);
      expect(order).toEqual([`fsync:${realpathSync.native(typeRoot)}`, "mark-files-revoked"]);
      expect(existsSync(auxiliary)).toBe(false);
      expect(f.core.getSourceRemoval(f.source.id)).toMatchObject({ state: "files-revoked" });

      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "removed" });
      expect(f.core.getSourceRemoval(f.source.id)).toMatchObject({ state: "complete" });
    } finally { f.cleanup(); }
  });

  it("rejects unsafe removal quarantines, then drains plural crash artifacts without following links", async () => {
    const f = fixture();
    try {
      await f.core.syncSource(f.source.id, f.auth);
      const typeRoot = join(f.storage, "git-md");
      const victim = join(f.root, "victim");
      mkdirSync(victim);
      writeFileSync(join(victim, "keep.txt"), "do not traverse\n");
      const unsafe = join(typeRoot, `.remove.${f.source.id}.unsafe`);
      symlinkSync(victim, unsafe, "dir");

      f.core.removeSource(f.source.id);
      await expect(f.core.syncGitMdSource(f.source.id)).rejects.toThrow(/not a real (?:direct-child )?directory/);
      expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("do not traverse\n");
      rmSync(unsafe);

      const firstRemoval = join(typeRoot, `.remove.${f.source.id}.first`);
      const secondRemoval = join(typeRoot, `.remove.${f.source.id}.second`);
      mkdirSync(join(firstRemoval, "snapshots"), { recursive: true, mode: 0o700 }); chmodSync(firstRemoval, 0o700);
      mkdirSync(join(secondRemoval, "snapshots"), { recursive: true, mode: 0o700 }); chmodSync(secondRemoval, 0o700);
      symlinkSync(victim, join(firstRemoval, "repository.git"), "dir");
      symlinkSync(victim, join(secondRemoval, `.materialize-${"a".repeat(40)}-interrupted`), "dir");
      mkdirSync(join(typeRoot, `.clone.${f.source.id}.one`), { mode: 0o700 });
      mkdirSync(join(typeRoot, `.repo.${f.source.id}.two`), { mode: 0o700 });
      mkdirSync(join(typeRoot, `.corrupt.${f.source.id}.three`), { mode: 0o700 });

      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "removed" });
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "removed" });
      expect(readdirSync(typeRoot).filter((name) => name.includes(f.source.id))).toEqual([]);
      expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("do not traverse\n");
    } finally { f.cleanup(); }
  });

  it("repairs graft and loose or packed replacement-ref poisoning without applying replacements", async () => {
    const f = fixture();
    try {
      const first = await f.core.syncSource(f.source.id, f.auth);
      if (!first.snapshotId) throw new Error("expected initial git-md snapshot");
      const firstSnapshot = first.snapshotId;
      const published = f.core.sourcePath(f.source.id, f.auth).path;
      writeFileSync(join(f.upstream, "README.md"), "malicious replacement tree\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "malicious replacement");
      const maliciousReplacement = git(f.upstream, "rev-parse", "HEAD");
      expect(git(f.upstream, "rev-parse", `${maliciousReplacement}^{tree}`)).not.toBe(git(f.upstream, "rev-parse", `${firstSnapshot}^{tree}`));
      git(f.source.localPath, "fetch", f.upstream, maliciousReplacement);
      git(f.upstream, "reset", "--hard", firstSnapshot);
      const poison = (): void => {
        mkdirSync(join(f.source.localPath, "refs", "replace"), { recursive: true });
        writeFileSync(join(f.source.localPath, "refs", "replace", firstSnapshot), `${maliciousReplacement}\n`);
        mkdirSync(join(f.source.localPath, "info"), { recursive: true });
        writeFileSync(join(f.source.localPath, "info", "grafts"), `${firstSnapshot}\n`);
      };
      poison();
      writeFileSync(join(f.upstream, "README.md"), "loose replacement must not win\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "loose");
      await f.core.syncSource(f.source.id, f.auth);
      expect(readFileSync(join(published, "README.md"), "utf8")).toBe("loose replacement must not win\n");
      expect(existsSync(join(f.source.localPath, "refs", "replace"))).toBe(false);

      const current = git(f.upstream, "rev-parse", "HEAD");
      expect(git(f.upstream, "rev-parse", `${current}^{tree}`)).not.toBe(git(f.upstream, "rev-parse", `${firstSnapshot}^{tree}`));
      writeFileSync(join(f.source.localPath, "packed-refs"), `# pack-refs with: peeled\n${firstSnapshot} refs/replace/${current}\n`);
      writeFileSync(join(f.upstream, "README.md"), "packed replacement must not win\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "packed");
      await f.core.syncSource(f.source.id, f.auth);
      expect(readFileSync(join(published, "README.md"), "utf8")).toBe("packed replacement must not win\n");
      const packed = join(f.source.localPath, "packed-refs");
      expect(!existsSync(packed) || !readFileSync(packed, "utf8").includes("refs/replace/")).toBe(true);
    } finally { f.cleanup(); }
  });

  for (const mutation of ["transport", "include"] as const) {
    it(`fences a direct sync when ${mutation} changes during fetch`, async () => {
      const f = fixture();
      let mutated = false;
      try {
        const mutatingExec = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
          if (!mutated && args.includes("fetch")) {
            mutated = true;
            if (mutation === "transport") f.core.updateSource(f.source.id, {
              transport: { allowedUrlSchemes: ["https"], allowedHosts: ["example.test", "mirror.example.test"] },
            });
            else f.core.updateSource(f.source.id, { include: ["README.md", "docs/**/*.md"] });
          }
          const rewritten = [...args].map((arg) => arg === f.canonicalRemote ? f.upstream : arg)
            .map((arg) => arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg);
          return execFile(file, rewritten, options, callback as never);
        }) as unknown as typeof execFile;
        await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: { execFile: mutatingExec } })).rejects.toThrow(/changed during remote synchronization/);
        expect(f.core.resumeSourceRun(f.source.id)).toBeNull();
        await expect(f.core.syncSource(f.source.id, f.auth)).resolves.toMatchObject({ status: "published" });
      } finally { f.cleanup(); }
    });
  }

  it("bounds staging writes, cleans interrupted fetches, and converges after force-push churn", async () => {
    const f = fixture();
    try {
      await f.core.syncSource(f.source.id, f.auth);
      const published = f.core.sourcePath(f.source.id, f.auth).path;
      writeFileSync(join(f.source.localPath, "oversize-junk"), randomBytes(256 * 1024));
      writeFileSync(join(f.upstream, "README.md"), "repaired over-quota active repository\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "repair active repository");
      await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: { maxRepositoryBytes: 128 * 1024 } })).resolves.toMatchObject({ status: "published" });
      expect(existsSync(join(f.source.localPath, "oversize-junk"))).toBe(false);
      const activeOidBeforeQuotaFailure = git(f.source.localPath, "rev-parse", "refs/monet/candidate^{commit}");
      const activeBytesBeforeQuotaFailure = repositoryBytes(f.source.localPath);
      const publicationBeforeQuotaFailure = realpathSync.native(published);
      const bodyBeforeQuotaFailure = readFileSync(join(published, "README.md"), "utf8");

      writeFileSync(join(f.upstream, "large.md"), randomBytes(512 * 1024));
      git(f.upstream, "add", "large.md"); git(f.upstream, "commit", "-m", "large");
      const observed: Array<{ bytes: number; limit: number; exceeded: boolean }> = [];
      const staging: Array<{ bytes: number; limit: number; exceeded: boolean }> = [];
        await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: {
        maxRepositoryBytes: 64 * 1024,
        onPackBytes: (bytes, limit, exceeded) => observed.push({ bytes, limit, exceeded }),
        onStagingBytes: (bytes, limit, exceeded) => staging.push({ bytes, limit, exceeded }),
      } })).rejects.toThrow(/quota/);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ exceeded: true });
      expect(observed[0]!.bytes).toBe(observed[0]!.limit);
      expect(observed[0]!.limit).toBeLessThan(64 * 1024);
      expect(staging).toHaveLength(1);
      expect(staging[0]!.bytes).toBeLessThanOrEqual(64 * 1024);
      expect(staging[0]).toMatchObject({ limit: 64 * 1024, exceeded: false });
      expect(git(f.source.localPath, "rev-parse", "refs/monet/candidate^{commit}")).toBe(activeOidBeforeQuotaFailure);
      expect(repositoryBytes(f.source.localPath)).toBe(activeBytesBeforeQuotaFailure);
      expect(realpathSync.native(published)).toBe(publicationBeforeQuotaFailure);
      expect(readFileSync(join(published, "README.md"), "utf8")).toBe(bodyBeforeQuotaFailure);
      expect(readdirSync(join(f.storage, "git-md")).filter((name) => /^\.(?:clone|repo|corrupt)-/.test(name))).toEqual([]);

      await f.core.syncSource(f.source.id, f.auth);
      const repositorySizes: number[] = [];
      for (let index = 0; index < 3; index += 1) {
        git(f.upstream, "reset", "--hard", "HEAD~1");
        writeFileSync(join(f.upstream, "README.md"), `force ${index}\n`);
        git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", `force-${index}`);
        await f.core.syncSource(f.source.id, f.auth);
        expect(readFileSync(join(published, "README.md"), "utf8")).toBe(`force ${index}\n`);
        expect(readdirSync(join(f.storage, "git-md")).filter((name) => /^\.(?:clone|repo|corrupt)-/.test(name))).toEqual([]);
        repositorySizes.push(repositoryBytes(f.source.localPath));
      }
      expect(Math.max(...repositorySizes)).toBeLessThan(256 * 1024);
      expect(Math.max(...repositorySizes) - Math.min(...repositorySizes)).toBeLessThan(32 * 1024);
    } finally { f.cleanup(); }
  });

  it("keeps peak aggregate staging bytes within quota for a highly compressible oversized remote object", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.upstream, "compressible.bin"), "A".repeat(2 * 1024 * 1024));
      git(f.upstream, "add", "compressible.bin"); git(f.upstream, "commit", "-m", "compressible remote payload");
      const staging: Array<{ bytes: number; limit: number; exceeded: boolean }> = [];
      await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: {
        maxRepositoryBytes: 64 * 1024,
        onStagingBytes: (bytes, limit, exceeded) => staging.push({ bytes, limit, exceeded }),
      } })).resolves.toMatchObject({ status: "published" });
      expect(staging).toHaveLength(1);
      expect(staging[0]!.bytes).toBeLessThanOrEqual(64 * 1024);
      expect(staging[0]).toMatchObject({ limit: 64 * 1024, exceeded: false });
      expect(repositoryBytes(f.source.localPath)).toBeLessThanOrEqual(64 * 1024);
    } finally { f.cleanup(); }
  });

  it("materializes exact blobs independently of export-ignore and export-subst attributes", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.upstream, ".gitattributes"), "README.md export-ignore\ntemplate.md export-subst\n");
      writeFileSync(join(f.upstream, "template.md"), "literal $Format:%H$ marker\n");
      git(f.upstream, "add", ".gitattributes", "template.md"); git(f.upstream, "commit", "-m", "archive attributes");
      f.core.updateSource(f.source.id, { include: ["README.md", "template.md"] });
      await f.core.syncSource(f.source.id, f.auth);
      const published = f.core.sourcePath(f.source.id, f.auth).path;
      expect(readFileSync(join(published, "README.md"), "utf8")).toContain("first");
      expect(readFileSync(join(published, "template.md"), "utf8")).toBe("literal $Format:%H$ marker\n");
    } finally { f.cleanup(); }
  });

  it("atomically rejects a source mutation at begin-run without creating a run", async () => {
    const f = fixture();
    try {
      const internals = f.core as unknown as {
        db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
        sourceLedger: { beginRunFault?: () => void };
      };
      internals.sourceLedger.beginRunFault = () => {
        internals.sourceLedger.beginRunFault = undefined;
        internals.db.prepare(`UPDATE knowledge_sources SET config_version=config_version+1,lease_fence=lease_fence+1 WHERE id=?`).run(f.source.id);
      };
      await expect(f.core.syncSource(f.source.id, f.auth)).rejects.toThrow(/fence is stale/);
      expect(f.core.listSourceRuns(f.source.id)).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  it("rejects poisoned refs, hardlinked objects, and same-size selected-object corruption", async () => {
    const f = fixture();
    try {
      const first = await f.core.syncSource(f.source.id, f.auth);
      if (!first.snapshotId) throw new Error("missing snapshot");
      const victim = join(f.root, "victim"); mkdirSync(victim);
      const candidate = join(f.source.localPath, "refs", "monet", "candidate");
      rmSync(candidate); symlinkSync(join(victim, "ref"), candidate);
      expect(() => validateManagedGitRepository(f.source.localPath)).toThrow(/symlink/);
      rmSync(candidate); writeFileSync(candidate, `${first.snapshotId}\n`);

      const pack = readdirSync(join(f.source.localPath, "objects", "pack")).find((name) => name.endsWith(".pack"))!;
      const packPath = join(f.source.localPath, "objects", "pack", pack);
      const linked = join(f.root, "linked-pack"); linkSync(packPath, linked);
      expect(() => validateManagedGitRepository(f.source.localPath)).toThrow(/hardlinked/);
      rmSync(linked);

      const blob = git(f.source.localPath, "ls-tree", first.snapshotId, "README.md").split(/\s+/)[2]!;
      const packBytes = readFileSync(packPath);
      const looseObjects = join(f.root, "loose-objects"); mkdirSync(looseObjects);
      execFileSync("git", ["unpack-objects", "-r"], { input: packBytes, env: { ...process.env, GIT_OBJECT_DIRECTORY: looseObjects } });
      rmSync(join(f.source.localPath, "objects"), { recursive: true });
      mkdirSync(join(looseObjects, "info")); mkdirSync(join(looseObjects, "pack"));
      renameSync(looseObjects, join(f.source.localPath, "objects"));
      const loose = join(f.source.localPath, "objects", blob.slice(0, 2), blob.slice(2));
      const corrupted = readFileSync(loose); corrupted[Math.floor(corrupted.length / 2)]! ^= 1; chmodSync(loose, 0o600); writeFileSync(loose, corrupted);
      const sealed = realpathSync.native(f.core.sourcePath(f.source.id, f.auth).path); makeWritable(sealed); rmSync(sealed, { recursive: true }); rmSync(`${sealed}.complete.json`);
      await expect(materializeGitMdCommit(f.source, first.snapshotId, { sourceStorageDir: f.storage })).rejects.toThrow();
    } finally { f.cleanup(); }
  });

  it("streams Markdown larger than one MiB and scrubs inherited managed Git state", async () => {
    const f = fixture();
    const poison = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_ASKPASS", "HTTPS_PROXY"];
    const prior = new Map(poison.map((key) => [key, process.env[key]]));
    try {
      writeFileSync(join(f.upstream, "large.md"), `# Large\n\n${"x".repeat(1536 * 1024)}\n`);
      git(f.upstream, "add", "large.md"); git(f.upstream, "commit", "-m", "large markdown");
      f.core.updateSource(f.source.id, { include: ["README.md", "large.md"] });
      mkdirSync(join(f.storage, "git-md"), { recursive: true });
      for (const key of poison) process.env[key] = join(f.root, "attacker");
      const source = f.core.getSource(f.source.id)!;
      const oid = await syncManagedGitRepository(source, f.storage, { execFile: f.localRemoteExec });
      const materialized = await materializeGitMdCommit(source, oid, { sourceStorageDir: f.storage });
      expect(readFileSync(join(materialized.snapshotPath, "large.md"), "utf8").length).toBeGreaterThan(1024 * 1024);
    } finally {
      for (const [key, value] of prior) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      f.cleanup();
    }
  }, 30_000);

  it("rejects unsafe artifact tokens before mkdir and preserves unrelated victims", async () => {
    for (const token of ["", "../escape", "/absolute", "a/b", "a\\b"] as const) {
      const f = fixture();
      try {
        const victim = join(f.root, "victim"); mkdirSync(victim); writeFileSync(join(victim, "keep"), "safe");
        await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: { token: () => token } })).rejects.toThrow(/token/);
        expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");
        expect(readdirSync(join(f.storage, "git-md")).filter((name) => name.startsWith(".clone."))).toEqual([]);
      } finally { f.cleanup(); }
    }
  });

  it("orders a later pre-pin failure after success even when the wall clock moves backwards", async () => {
    const f = fixture();
    const originalNow = Date.now;
    try {
      Date.now = () => 1000;
      await f.core.syncSource(f.source.id, f.auth);
      Date.now = () => 900;
      const failingExec = ((_: string, __: readonly string[], ___: Record<string, unknown>, callback: Function) => callback(new Error("https://user:password@example.test/private"), "", "")) as unknown as typeof execFile;
      await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: { execFile: failingExec } })).rejects.toThrow();
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({ lastSyncResult: "failed", lastAttemptAt: 900 });
      expect(f.core.sourceStatus(f.source.id, f.auth).lastError).not.toContain("password");
    } finally { Date.now = originalNow; f.cleanup(); }
  });

  it("records direct unchanged retries as durable success and survives a crash after verification", async () => {
    const f = fixture();
    const originalNow = Date.now;
    try {
      Date.now = () => 1000;
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "published" });
      const runCount = f.core.listSourceRuns(f.source.id).length;

      Date.now = () => 2000;
      const failingExec = ((_: string, __: readonly string[], ___: Record<string, unknown>, callback: Function) => {
        callback(new Error("https://user:password@example.test/private"), "", "");
      }) as unknown as typeof execFile;
      await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: { execFile: failingExec } })).rejects.toThrow();
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "failed", freshness: "stale", lastAttemptAt: 2000,
      });

      Date.now = () => 3000;
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "noop", runId: null });
      const recovered = f.core.sourceStatus(f.source.id, f.auth);
      expect(recovered).toMatchObject({
        lastSyncResult: "success", freshness: "fresh", lastAttemptAt: 3000, lastSuccessfulSyncAt: 3000,
      });
      expect(recovered).not.toHaveProperty("lastError");
      expect(f.core.listSourceRuns(f.source.id)).toHaveLength(runCount);

      const internals = f.core as unknown as { db: {
        prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> };
      } };
      expect(internals.db.prepare(`SELECT COUNT(*) AS count FROM source_pre_pin_attempts WHERE source_id=?`).get(f.source.id)).toEqual({ count: 0 });
      expect(internals.db.prepare(`SELECT COUNT(*) AS count FROM source_verification_checks WHERE source_id=?`).get(f.source.id)).toEqual({ count: 1 });
      expect(internals.db.prepare(`SELECT kind,failure_reason FROM source_attempt_events WHERE source_id=? ORDER BY sequence DESC LIMIT 1`).get(f.source.id))
        .toEqual({ kind: "verification", failure_reason: null });

      Date.now = () => 4000;
      await expect(f.core.syncGitMdSource(f.source.id, { fault: (point) => {
        if (point === "after-noop-verification") throw new Error("crash after verification");
      } })).rejects.toThrow(/crash after verification/);
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "success", freshness: "fresh", lastAttemptAt: 4000, lastSuccessfulSyncAt: 4000,
      });

      Date.now = () => 5000;
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "noop", runId: null });
      expect(f.core.listSourceRuns(f.source.id)).toHaveLength(runCount);
      expect(internals.db.prepare(`SELECT COUNT(*) AS count FROM source_verification_checks WHERE source_id=?`).get(f.source.id)).toEqual({ count: 1 });
      expect(internals.db.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events WHERE source_id=?`).get(f.source.id)).toEqual({ count: 6 });
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "success", freshness: "fresh", lastAttemptAt: 5000, lastSuccessfulSyncAt: 5000,
      });
    } finally { Date.now = originalNow; f.cleanup(); }
  });

  it("keeps a pre-pin failure authoritative across an after-pin crash until a retry starts", async () => {
    const f = fixture();
    try {
      const failingExec = ((_: string, __: readonly string[], ___: Record<string, unknown>, callback: Function) => {
        callback(new Error("https://user:password@example.test/private"), "", "");
      }) as unknown as typeof execFile;
      await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: { execFile: failingExec } })).rejects.toThrow();
      const failed = f.core.sourceStatus(f.source.id, f.auth);
      expect(failed).toMatchObject({ lastSyncResult: "failed", lastError: expect.not.stringContaining("password") });

      await expect(f.core.syncGitMdSource(f.source.id, {
        remoteGit: { execFile: f.localRemoteExec },
        fault: (point) => { if (point === "after-pin") throw new Error("crash after pin"); },
      })).rejects.toThrow(/crash after pin/);
      expect(f.core.listSourceRuns(f.source.id)).toEqual([]);
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "failed", lastAttemptAt: failed.lastAttemptAt, lastError: failed.lastError,
      });

      const internals = f.core as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } };
      internals.db.prepare(`DELETE FROM source_pre_pin_attempts WHERE source_id=?`).run(f.source.id);
      internals.db.prepare(`UPDATE source_attempt_events SET failure_reason=NULL WHERE source_id=?`).run(f.source.id);
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "failed", lastError: "source pre-pin attempt failed",
      });

      await expect(f.core.syncSource(f.source.id, f.auth)).resolves.toMatchObject({ status: "published" });
      expect(f.core.sourceStatus(f.source.id, f.auth).lastSyncResult).toBe("success");
    } finally { f.cleanup(); }
  });

  it("rejects a rewritten just-published variant before moving the prior stable current", async () => {
    const f = fixture();
    try {
      const first = await f.core.syncGitMdSource(f.source.id);
      const current = join(f.storage, "git-md", f.source.id, "current");
      const priorTarget = readlinkSync(current);
      writeFileSync(join(f.upstream, "README.md"), "# Two\n\nsecond\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "two");
      await expect(f.core.syncGitMdSource(f.source.id, { fault: (point) => {
        if (point !== "after-publish") return;
        const active = f.core.getSource(f.source.id)!;
        const variant = `${active.activeSnapshotId!}-${active.activeIngestConfigHash!.slice(-64)}`;
        rewriteSealedSnapshot(join(f.storage, "git-md", f.source.id, "snapshots", variant), "README.md", "# Poison\n\nrewritten\n");
      } })).rejects.toThrow(/durable ledger/);
      expect(readlinkSync(current)).toBe(priorTarget);
      expect(priorTarget).toContain(first.snapshotId!);
      expect(() => f.core.sourcePath(f.source.id, f.auth)).toThrow();
    } finally { f.cleanup(); }
  });

  it("abandons an unrecoverable write-free pinned run after repository loss and force-pushes to the fetched head", async () => {
    const f = fixture();
    try {
      await f.core.syncGitMdSource(f.source.id);
      writeFileSync(join(f.upstream, "README.md"), "# Dropped\n\nold pinned head\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "dropped");
      const dropped = git(f.upstream, "rev-parse", "HEAD");
      await expect(f.core.syncGitMdSource(f.source.id, {
        fault: (point) => { if (point === "after-begin") throw new Error("crash after begin"); },
      })).rejects.toThrow(/crash after begin/);
      expect(f.core.resumeSourceRun(f.source.id)?.snapshotId).toBe(dropped);
      rmSync(f.source.localPath, { recursive: true, force: true });

      git(f.upstream, "checkout", "--orphan", "replacement");
      git(f.upstream, "rm", "-rf", ".");
      writeFileSync(join(f.upstream, "README.md"), "# Replacement\n\nnew reachable head\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "replacement");
      git(f.upstream, "branch", "-M", "main");
      const replacement = git(f.upstream, "rev-parse", "HEAD");

      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "published", snapshotId: replacement });
      const runs = f.core.listSourceRuns(f.source.id);
      expect(runs.find((run) => run.snapshotId === dropped)).toMatchObject({ state: "aborted", result: "failed" });
      expect(f.core.getSource(f.source.id)?.activeSnapshotId).toBe(replacement);
      expect(f.core.listSourceChunks(f.core.getSource(f.source.id)!.activeRunId!, true)).toHaveLength(1);
      expect(readFileSync(join(f.core.sourcePath(f.source.id, f.auth).path, "README.md"), "utf8")).toContain("new reachable head");
    } finally { f.cleanup(); }
  });

  it("converges an interrupted replacement back to the active head through authenticated no-op recovery", async () => {
    const f = fixture();
    try {
      await f.core.syncGitMdSource(f.source.id);
      const activeHead = f.core.getSource(f.source.id)!.activeSnapshotId!;
      const activeRunId = f.core.getSource(f.source.id)!.activeRunId!;
      const interruptAtNewHead = async (label: string) => {
        writeFileSync(join(f.upstream, "README.md"), `# ${label}\n\ninterrupted replacement\n`);
        git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", label);
        const abandonedHead = git(f.upstream, "rev-parse", "HEAD");
        await expect(f.core.syncGitMdSource(f.source.id, { fault: (point) => {
          if (point === "after-begin") throw new Error(`crash ${label}`);
        } })).rejects.toThrow(`crash ${label}`);
        const abandoned = f.core.resumeSourceRun(f.source.id)!;
        expect(abandoned).toMatchObject({ snapshotId: abandonedHead, state: "scanning" });
        expect(f.core.listSourceFiles(abandoned.id)).toEqual([]);
        expect(f.core.listSourceChunks(abandoned.id)).toEqual([]);
        rmSync(f.source.localPath, { recursive: true, force: true });
        git(f.upstream, "reset", "--hard", activeHead);
        return abandoned;
      };

      const firstAbandoned = await interruptAtNewHead("replacement-a");
      rmSync(join(f.storage, "git-md", f.source.id, "current"));
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({
        status: "noop", snapshotId: activeHead, runId: null,
      });
      expect(f.core.getSourceRun(firstAbandoned.id)).toMatchObject({ state: "aborted", result: "failed" });
      expect(f.core.listSourceCleanupItems(firstAbandoned.id)).toEqual([]);
      expect(f.core.resumeSourceRun(f.source.id)).toBeNull();
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "success", freshness: "fresh", indexedRevision: activeHead,
      });
      expect(f.core.sourceStatus(f.source.id, f.auth)).not.toHaveProperty("lastError");
      expect(f.core.sourcePath(f.source.id, f.auth).revision).toBe(activeHead);

      const crashAbandoned = await interruptAtNewHead("replacement-b");
      await expect(f.core.syncGitMdSource(f.source.id, { fault: (point) => {
        if (point === "after-noop-verification") throw new Error("crash after recovered verification");
      } })).rejects.toThrow(/crash after recovered verification/);
      expect(f.core.getSourceRun(crashAbandoned.id)).toMatchObject({ state: "aborted", result: "failed" });
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "success", freshness: "fresh", indexedRevision: activeHead,
      });
      expect(f.core.sourceStatus(f.source.id, f.auth)).not.toHaveProperty("lastError");
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "noop", snapshotId: activeHead, runId: null });
      expect(f.core.listSourceRuns(f.source.id).filter((run) => run.snapshotId === activeHead)).toHaveLength(1);
      expect(f.core.getSource(f.source.id)?.activeRunId).toBe(activeRunId);
      expect(f.core.resumeSourceRun(f.source.id)).toBeNull();
    } finally { f.cleanup(); }
  });

  it("repairs a published current pointer before unavailable credentials or fetch and later noops", async () => {
    const f = fixture();
    try {
      await expect(f.core.syncGitMdSource(f.source.id, {
        fault: (point) => { if (point === "after-publish") throw new Error("crash after durable publish"); },
      })).rejects.toThrow(/crash after durable publish/);
      const active = f.core.getSource(f.source.id)!;
      expect(active).toMatchObject({
        activeRunId: expect.any(String), activeSnapshotId: expect.any(String), activeIngestConfigHash: expect.any(String),
      });
      expect(f.core.resumeSourceRun(f.source.id)).toBeNull();
      const current = join(f.storage, "git-md", f.source.id, "current");
      expect(existsSync(current)).toBe(false);
      expect(() => f.core.sourcePath(f.source.id, f.auth)).toThrow();
      rmSync(f.source.localPath, { recursive: true, force: true });

      let credentialCalls = 0;
      await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: {
        credentialProvider: { get: async () => {
          credentialCalls += 1;
          expect(readFileSync(join(f.core.sourcePath(f.source.id, f.auth).path, "README.md"), "utf8")).toBe("# One\n\nfirst\n");
          throw new Error("credentials unavailable");
        } },
      } })).rejects.toThrow(/^Git credential provider failed$/);
      expect(credentialCalls).toBe(1);
      expect(readFileSync(join(f.core.sourcePath(f.source.id, f.auth).path, "README.md"), "utf8")).toBe("# One\n\nfirst\n");
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({ lastSyncResult: "failed", freshness: "stale" });

      let fetchCalls = 0;
      const failingFetch = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
        expect(readFileSync(join(f.core.sourcePath(f.source.id, f.auth).path, "README.md"), "utf8")).toBe("# One\n\nfirst\n");
        if (args.includes("fetch")) {
          fetchCalls += 1;
          callback(new Error("fetch unavailable"), "", "");
          return undefined;
        }
        return f.localRemoteExec(file, args, options, callback as never);
      }) as unknown as typeof execFile;
      await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: { execFile: failingFetch } })).rejects.toThrow(/fetch unavailable/);
      expect(fetchCalls).toBe(1);
      expect(readFileSync(join(f.core.sourcePath(f.source.id, f.auth).path, "README.md"), "utf8")).toBe("# One\n\nfirst\n");
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "failed", freshness: "stale", lastError: expect.stringContaining("fetch unavailable"),
      });

      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "noop", runId: null });
      expect(existsSync(f.source.localPath)).toBe(true);
      expect(readFileSync(join(f.core.sourcePath(f.source.id, f.auth).path, "README.md"), "utf8")).toBe("# One\n\nfirst\n");
    } finally { f.cleanup(); }
  });

  it("does not repair current across a concurrent git-md config and lease-fence change", async () => {
    const f = fixture();
    try {
      await expect(f.core.syncGitMdSource(f.source.id, {
        fault: (point) => { if (point === "after-publish") throw new Error("crash after durable publish"); },
      })).rejects.toThrow(/crash after durable publish/);
      const current = join(f.storage, "git-md", f.source.id, "current");
      const before = f.core.getSource(f.source.id)!;
      let changed = false;
      await expect(f.core.syncGitMdSource(f.source.id, { materializer: { fault: (point) => {
        if (point === "before-current-swap" && !changed) {
          changed = true;
          f.core.updateSource(f.source.id, { include: ["README.md", "SECOND.md"] });
        }
      } } })).rejects.toThrow(/changed during remote synchronization/);
      const after = f.core.getSource(f.source.id)!;
      expect(changed).toBe(true);
      expect(after.configVersion).toBe(before.configVersion + 1);
      expect(after.leaseFence).toBe(before.leaseFence + 1);
      expect(existsSync(current)).toBe(false);
      expect(() => f.core.sourcePath(f.source.id, f.auth)).toThrow();

      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "published" });
      expect(f.core.sourcePath(f.source.id, f.auth).revision).toBe(after.activeSnapshotId);
    } finally { f.cleanup(); }
  });

  it("records an invalid sealed active repair as failed before credentials and clears it after retry", async () => {
    const f = fixture();
    try {
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "published" });
      const active = f.core.getSource(f.source.id)!;
      const variant = `${active.activeSnapshotId!}-${active.activeIngestConfigHash!.slice(-64)}`;
      const snapshot = join(f.storage, "git-md", f.source.id, "snapshots", variant);
      const marker = `${snapshot}.complete.json`;
      const markerBytes = readFileSync(marker);
      rmSync(marker);
      rmSync(join(f.storage, "git-md", f.source.id, "current"));
      rmSync(f.source.localPath, { recursive: true, force: true });
      let credentialCalls = 0;
      const primary = await f.core.syncGitMdSource(f.source.id, { remoteGit: { credentialProvider: { get: async () => {
        credentialCalls += 1;
        return null;
      } } } }).then(() => null, (error: unknown) => error as Error);
      expect(primary).toBeInstanceOf(Error);
      expect(credentialCalls).toBe(0);
      expect(existsSync(join(f.storage, "git-md", f.source.id, "current"))).toBe(false);
      expect(() => f.core.sourcePath(f.source.id, f.auth)).toThrow();
      const failed = f.core.sourceStatus(f.source.id, f.auth);
      expect(failed).toMatchObject({ lastSyncResult: "failed", freshness: "stale", lastError: expect.any(String) });
      expect(failed.lastError).not.toContain(f.storage);

      writeFileSync(marker, markerBytes, { mode: 0o400 });
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "noop", runId: null });
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({ lastSyncResult: "success", freshness: "fresh" });
      expect(f.core.sourceStatus(f.source.id, f.auth)).not.toHaveProperty("lastError");
    } finally { f.cleanup(); }
  });

  it("preserves the active-repair error when the failure receipt fence changes", async () => {
    const f = fixture();
    try {
      await f.core.syncGitMdSource(f.source.id);
      const active = f.core.getSource(f.source.id)!;
      const variant = `${active.activeSnapshotId!}-${active.activeIngestConfigHash!.slice(-64)}`;
      rmSync(join(f.storage, "git-md", f.source.id, "snapshots", `${variant}.complete.json`));
      rmSync(join(f.storage, "git-md", f.source.id, "current"));
      const original = f.core.recordSourcePrePinFailure.bind(f.core);
      f.core.recordSourcePrePinFailure = ((input) => {
        f.core.updateSource(f.source.id, { include: ["README.md", "SECOND.md"] });
        return original(input);
      }) as typeof f.core.recordSourcePrePinFailure;
      const error = await f.core.syncGitMdSource(f.source.id).then(() => null, (reason: unknown) => reason as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).not.toMatch(/pre-pin attempt fence is stale/);
      expect(error!.message).toMatch(/ENOENT|unavailable|snapshot|manifest/i);
    } finally { f.cleanup(); }
  });

  it("authenticates rewritten cached variants against Git before reuse", async () => {
    const f = fixture();
    try {
      mkdirSync(f.storage, { recursive: true });
      const oid = await syncManagedGitRepository(f.source, f.storage, { execFile: f.localRemoteExec });
      const cached = await materializeGitMdCommit(f.source, oid, { sourceStorageDir: f.storage });
      rewriteSealedSnapshot(cached.snapshotPath, "README.md", "# Forged\n\nrewritten cache\n");
      await expect(materializeGitMdCommit(f.source, oid, { sourceStorageDir: f.storage }))
        .rejects.toThrow(/does not match (its Git blob|Git)/);
    } finally { f.cleanup(); }
  });

  it("authenticates active and offline repaired snapshots against the durable ledger", async () => {
    for (const corruptLedger of [false, true]) {
      const f = fixture();
      try {
        await f.core.syncSource(f.source.id, f.auth);
        const active = f.core.getSource(f.source.id)!;
        const snapshot = f.core.sourcePath(f.source.id, f.auth).snapshotPath;
        if (corruptLedger) {
          const internals = f.core as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } };
          internals.db.prepare(`UPDATE source_files SET content_hash=? WHERE run_id=? AND relative_path=?`)
            .run(`monet-src-content/v1:sha256:${"0".repeat(64)}`, active.activeRunId, "README.md");
        } else rewriteSealedSnapshot(snapshot, "README.md", "# Forged\n\noffline cache\n");
        expect(() => f.core.sourcePath(f.source.id, f.auth)).toThrow(/ledger|manifest|content|corrupt/);
        rmSync(join(f.storage, "git-md", f.source.id, "current"));
        rmSync(f.source.localPath, { recursive: true, force: true });
        let credentialCalls = 0;
        await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: { credentialProvider: { get: async () => {
          credentialCalls += 1; return null;
        } } } })).rejects.toThrow(/ledger|manifest|content|corrupt/);
        expect(credentialCalls).toBe(0);
        expect(existsSync(join(f.storage, "git-md", f.source.id, "current"))).toBe(false);
      } finally { f.cleanup(); }
    }
  });

  it("rejects a symlinked snapshots root for sync, current repair, and removal without touching its victim", async () => {
    for (const operation of ["sync", "repair", "remove"] as const) {
      const f = fixture();
      try {
        if (operation !== "sync") {
          if (operation === "repair") {
            await expect(f.core.syncGitMdSource(f.source.id, { fault: (point) => {
              if (point === "after-publish") throw new Error("published");
            } })).rejects.toThrow(/published/);
          } else await f.core.syncSource(f.source.id, f.auth);
        }
        const sourceRoot = join(f.storage, "git-md", f.source.id);
        mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
        const snapshots = join(sourceRoot, "snapshots");
        if (existsSync(snapshots)) { makeWritable(snapshots); rmSync(snapshots, { recursive: true }); }
        const victim = join(f.root, `snapshot-victim-${operation}`);
        mkdirSync(victim); writeFileSync(join(victim, "keep"), "safe");
        symlinkSync(victim, snapshots, "dir");
        if (operation === "remove") {
          f.core.removeSource(f.source.id);
          await expect(f.core.syncGitMdSource(f.source.id)).rejects.toThrow(/snapshots|canonical|direct-child/);
        } else await expect(f.core.syncGitMdSource(f.source.id)).rejects.toThrow(/snapshots|canonical|direct-child/);
        expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");
        expect(readdirSync(victim)).toEqual(["keep"]);
      } finally { f.cleanup(); }
    }
  });

  it("refetches Git evidence before publishing a resumed rename after repository loss", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.upstream, "a.md"), "# Stable\n\nidentity\n");
      git(f.upstream, "add", "a.md"); git(f.upstream, "commit", "-m", "add a");
      f.core.updateSource(f.source.id, { include: ["*.md"] });
      await f.core.syncSource(f.source.id, f.auth);
      git(f.upstream, "mv", "a.md", "b.md"); git(f.upstream, "commit", "-m", "rename");
      await expect(f.core.syncGitMdSource(f.source.id, { fault: (point) => {
        if (point === "after-begin") throw new Error("crash after begin");
      } })).rejects.toThrow(/crash after begin/);
      rmSync(f.source.localPath, { recursive: true, force: true });
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "published" });
      expect(readFileSync(join(f.core.sourcePath(f.source.id, f.auth).path, "b.md"), "utf8")).toContain("identity");
      expect(existsSync(f.source.localPath)).toBe(true);
      await expect(f.core.syncSource(f.source.id, f.auth)).resolves.toMatchObject({ status: "noop" });
      expect(existsSync(f.source.localPath)).toBe(true);
    } finally { f.cleanup(); }
  });

  it("supports a real SHA-256 remote without downgrading its managed repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "monet-git-md-sha256-"));
    const upstream = join(root, "upstream");
    const storage = join(root, "sources");
    try {
      try { execFileSync("git", ["init", "--object-format=sha256", "-b", "main", upstream]); }
      catch { return; } // Capability-gated for older system Git builds.
      git(upstream, "config", "user.email", "test@example.com");
      git(upstream, "config", "user.name", "Test");
      writeFileSync(join(upstream, "README.md"), "# SHA-256\n\nformat-aware\n");
      git(upstream, "add", "README.md"); git(upstream, "commit", "-m", "sha256");
      const remote = "https://sha256.example.test/acme/docs";
      const localRemoteExec = ((file: string, args: readonly string[], options: Record<string, unknown>, callback: Function) => {
        const rewritten = [...args].map((arg) => arg === remote ? upstream : arg)
          .map((arg) => arg === "protocol.file.allow=never" ? "protocol.file.allow=always" : arg);
        return execFile(file, rewritten, options, callback as never);
      }) as unknown as typeof execFile;
      const core = new MonetCore(join(root, "monet.db"), { sourceStorageDir: storage, sourceGit: { execFile: localRemoteExec } });
      try {
        const source = core.createSource({
          id: "sha256-source", type: "git-md", name: "SHA-256 docs", remoteUrl: remote, branch: "main",
          circle: "remote-docs", include: ["README.md"],
          access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] },
          transport: { allowedUrlSchemes: ["https"], allowedHosts: ["sha256.example.test"] },
        });
        const result = await core.syncGitMdSource(source.id);
        expect(result.snapshotId).toMatch(/^[0-9a-f]{64}$/);
        expect(readFileSync(join(source.localPath, "config"), "utf8")).toContain("objectformat = sha256");
        expect(() => validateManagedGitRepository(source.localPath)).not.toThrow();
        expect(readFileSync(join(core.sourcePath(source.id, { callerId: "caller", projectId: "project" }).path, "README.md"), "utf8"))
          .toContain("format-aware");
      } finally { core.close(); }
    } finally { makeWritable(root); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("refetches a structurally valid repository that lacks a write-free resumed pin", async () => {
    const f = fixture();
    try {
      await f.core.syncGitMdSource(f.source.id);
      writeFileSync(join(f.upstream, "README.md"), "# Dropped\n\nold pin\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "dropped");
      const dropped = git(f.upstream, "rev-parse", "HEAD");
      await expect(f.core.syncGitMdSource(f.source.id, { fault: (point) => {
        if (point === "after-begin") throw new Error("crash after begin");
      } })).rejects.toThrow(/crash after begin/);
      const oldRun = f.core.resumeSourceRun(f.source.id)!;
      expect(oldRun.snapshotId).toBe(dropped);
      expect(f.core.listSourceFiles(oldRun.id)).toEqual([]);
      expect(f.core.listSourceChunks(oldRun.id)).toEqual([]);

      git(f.upstream, "checkout", "--orphan", "replacement-valid");
      git(f.upstream, "rm", "-rf", ".");
      writeFileSync(join(f.upstream, "README.md"), "# Replacement\n\nvalid repository, disjoint objects\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "replacement");
      git(f.upstream, "branch", "-M", "main");
      const replacement = git(f.upstream, "rev-parse", "HEAD");
      await syncManagedGitRepository(f.core.getSource(f.source.id)!, f.storage, { execFile: f.localRemoteExec });
      expect(() => validateManagedGitRepository(f.source.localPath)).not.toThrow();
      expect(() => git(f.source.localPath, "cat-file", "-e", `${dropped}^{commit}`)).toThrow();

      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "published", snapshotId: replacement });
      expect(f.core.listSourceRuns(f.source.id).filter((run) => run.snapshotId === replacement)).toHaveLength(1);
      expect(f.core.getSource(f.source.id)?.activeSnapshotId).toBe(replacement);
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({ lastSyncResult: "success", indexedRevision: replacement });
      expect(f.core.resumeSourceRun(f.source.id)).toBeNull();
    } finally { f.cleanup(); }
  });

  it("rejects injected nested filesystem boundaries before sync, removal, or recovery mutation", async () => {
    // Interrupted materialization sweep.
    {
      const f = fixture();
      try {
        await f.core.syncGitMdSource(f.source.id);
        const staging = join(f.storage, "git-md", f.source.id, `.materialize-${f.core.getSource(f.source.id)!.activeSnapshotId}-stale`);
        const mounted = join(staging, "mounted");
        mkdirSync(mounted, { recursive: true, mode: 0o700 }); writeFileSync(join(mounted, "keep"), "safe");
        const counters = { chmod: 0, rm: 0 };
        await expect(materializeGitMdCommit(f.core.getSource(f.source.id)!, f.core.getSource(f.source.id)!.activeSnapshotId!, {
          sourceStorageDir: f.storage, safeTreeOps: differentDeviceOps(realpathSync.native(mounted), counters),
        }))
          .rejects.toThrow(/filesystem boundary/);
        expect(counters).toEqual({ chmod: 0, rm: 0 });
        expect(readFileSync(join(mounted, "keep"), "utf8")).toBe("safe");
      } finally { f.cleanup(); }
    }
    // Stale clone recovery.
    {
      const f = fixture();
      try {
        const clone = join(f.storage, "git-md", `.clone.${f.source.id}.stale`);
        const mounted = join(clone, "mounted");
        mkdirSync(mounted, { recursive: true, mode: 0o700 }); chmodSync(clone, 0o700); writeFileSync(join(mounted, "keep"), "safe");
        const counters = { chmod: 0, rm: 0 };
        await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: { safeTreeOps: differentDeviceOps(realpathSync.native(mounted), counters) } }))
          .rejects.toThrow(/filesystem boundary/);
        expect(counters).toEqual({ chmod: 0, rm: 0 });
        expect(readFileSync(join(mounted, "keep"), "utf8")).toBe("safe");
      } finally { f.cleanup(); }
    }
    // Source-removal quarantine.
    {
      const f = fixture();
      try {
        await f.core.syncGitMdSource(f.source.id);
        const source = f.core.getSource(f.source.id)!;
        const variant = `${source.activeSnapshotId!}-${source.activeIngestConfigHash!.slice(-64)}`;
        const snapshot = join(f.storage, "git-md", source.id, "snapshots", variant);
        const sourcePath = f.core.sourcePath(source.id, f.auth);
        const current = join(f.storage, "git-md", source.id, "current");
        chmodSync(snapshot, 0o700);
        const mounted = join(snapshot, "mounted");
        const victim = join(f.root, "removal-victim");
        mkdirSync(mounted); mkdirSync(victim); writeFileSync(join(victim, "keep"), "safe");
        symlinkSync(victim, join(mounted, "victim"), "dir");
        f.core.removeSource(source.id);
        const tombstoned = f.core.getSource(source.id, { includeTombstoned: true })!;
        const activeRun = f.core.getSourceRun(source.activeRunId!)!;
        const manifest = f.core.getSourcePublishedManifest(
          source.id, source.activeRunId!, source.activeSnapshotId!, source.activeIngestConfigHash!,
        );
        const bindings = f.core.listSourceChunks(source.activeRunId!, true);
        const concepts = sourceProjection(f.core, bindings);
        const removal = f.core.getSourceRemoval(source.id);
        const removalItems = f.core.listSourceRemovalItems(source.id);
        const currentEntry = lstatSync(current);
        const currentIdentity = {
          dev: currentEntry.dev, ino: currentEntry.ino, mode: currentEntry.mode, size: currentEntry.size,
        };
        const currentTarget = readlinkSync(current);
        const snapshotDigest = noFollowTreeDigest(sourcePath.snapshotPath);
        const marker = readFileSync(`${sourcePath.snapshotPath}.complete.json`);
        const counters = { chmod: 0, rm: 0 };
        await expect(f.core.syncGitMdSource(source.id, { materializer: { safeTreeOps: differentDeviceOps(realpathSync.native(mounted), counters) } }))
          .rejects.toThrow(/filesystem boundary/);

        const currentAfter = lstatSync(current);
        expect({ dev: currentAfter.dev, ino: currentAfter.ino, mode: currentAfter.mode, size: currentAfter.size }).toEqual(currentIdentity);
        expect(readlinkSync(current)).toBe(currentTarget);
        expect(realpathSync.native(current)).toBe(sourcePath.snapshotPath);
        expect(noFollowTreeDigest(sourcePath.snapshotPath)).toBe(snapshotDigest);
        expect(readFileSync(`${sourcePath.snapshotPath}.complete.json`)).toEqual(marker);
        expect(f.core.getSource(source.id, { includeTombstoned: true })).toEqual(tombstoned);
        expect(f.core.getSourceRun(source.activeRunId!)).toEqual(activeRun);
        expect(f.core.getSourcePublishedManifest(
          source.id, source.activeRunId!, source.activeSnapshotId!, source.activeIngestConfigHash!,
        )).toEqual(manifest);
        expect(f.core.listSourceChunks(source.activeRunId!, true)).toEqual(bindings);
        expect(sourceProjection(f.core, bindings)).toEqual(concepts);
        expect(f.core.getSourceRemoval(source.id)).toEqual(removal);
        expect(f.core.listSourceRemovalItems(source.id)).toEqual(removalItems);
        // The only removal is the now-safe source lock release; the poisoned
        // source tree itself remains completely untouched.
        expect(counters).toEqual({ chmod: 0, rm: 1 });
        expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");

        await expect(f.core.syncGitMdSource(source.id)).resolves.toMatchObject({ status: "removed" });
        expect(f.core.getSourceRemoval(source.id)).toMatchObject({ state: "complete" });
        expect(f.core.listSourceRemovalItems(source.id).every((item) => item.acknowledgedAt !== null)).toBe(true);
        expect(readFileSync(join(victim, "keep"), "utf8")).toBe("safe");
      } finally { f.cleanup(); }
    }
  });

  it("uses a monotonic aggregate deadline during recursive repository validation and releases the lock", async () => {
    const f = fixture();
    const originalNow = Date.now;
    try {
      await f.core.syncGitMdSource(f.source.id);
      let wall = 10_000;
      Date.now = () => --wall;
      let monotonic = 0;
      await expect(f.core.syncGitMdSource(f.source.id, { materializer: {
        materializationDeadlineMs: 8,
        monotonicNow: () => monotonic++,
      } })).rejects.toThrow(/materialization deadline exceeded/);
      await expect(withGitMdMaterializerLock(f.source.id, { sourceStorageDir: f.storage }, async () => "reacquired"))
        .resolves.toBe("reacquired");
      expect(wall).toBeLessThan(10_000); // Lock fencing may read it; deadline convergence does not depend on its direction.
    } finally { Date.now = originalNow; f.cleanup(); }
  });

  it("records failed resumed-run invocations and a newer same-run terminal success", async () => {
    const f = fixture();
    const originalNow = Date.now;
    try {
      Date.now = () => 1000;
      await f.core.syncGitMdSource(f.source.id);
      writeFileSync(join(f.upstream, "README.md"), "# Two\n\nresume me\n");
      git(f.upstream, "add", "README.md"); git(f.upstream, "commit", "-m", "two");
      await expect(f.core.syncGitMdSource(f.source.id, { fault: (point) => {
        if (point === "after-begin") throw new Error("crash after durable run");
      } })).rejects.toThrow(/crash after durable run/);
      const run = f.core.resumeSourceRun(f.source.id)!;
      rmSync(f.source.localPath, { recursive: true, force: true });

      Date.now = () => 2000;
      const opaqueProviderText = `credential: secret-value-${"z".repeat(5000)}`;
      await expect(f.core.syncGitMdSource(f.source.id, { remoteGit: {
        credentialProvider: { get: async () => { throw new Error(opaqueProviderText); } },
      } })).rejects.toThrow(/^Git credential provider failed$/);
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "failed", freshness: "stale", lastAttemptAt: 2000,
        lastError: "Git credential provider failed",
      });
      const internals = f.core as unknown as { db: { prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> } } };
      const failed = internals.db.prepare(`SELECT sequence,kind,run_id,failure_reason,invocation_result,config_version,lease_fence FROM source_attempt_events
        WHERE source_id=? ORDER BY sequence DESC LIMIT 1`).get(f.source.id);
      expect(failed).toMatchObject({
        kind: "invocation", run_id: run.id, invocation_result: "failed", failure_reason: "Git credential provider failed",
        config_version: run.configVersion, lease_fence: run.leaseFence,
      });
      expect(String(failed.failure_reason).length).toBeLessThanOrEqual(1024);
      expect(JSON.stringify(failed)).not.toContain(opaqueProviderText);

      Date.now = () => 3000;
      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "published", runId: run.id });
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "success", freshness: "fresh", lastAttemptAt: 3000,
      });
      expect(internals.db.prepare(`SELECT sequence,kind,run_id,failure_reason,invocation_result FROM source_attempt_events
        WHERE source_id=? ORDER BY sequence DESC LIMIT 1`).get(f.source.id)).toMatchObject({
        kind: "invocation", run_id: run.id, invocation_result: "success", failure_reason: null,
      });
    } finally { Date.now = originalNow; f.cleanup(); }
  });

  it("records a sanitized invocation failure when a newly-created run cannot scan, then supersedes it on retry", async () => {
    const f = fixture();
    try {
      await expect(syncGitMdSourceCoordinator(f.core, f.source.id, {
        sourceStorageDir: f.storage,
        remoteGit: { execFile: f.localRemoteExec },
        scan: () => { throw new Error("scan https://user:secret@example.test/private failed"); },
      })).rejects.toThrow(/scan .* failed/);
      const run = f.core.resumeSourceRun(f.source.id)!;
      expect(run).toMatchObject({ state: "scanning", result: null });
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "failed", freshness: "unknown", lastError: expect.not.stringContaining("secret"),
      });
      const db = (f.core as unknown as { db: StoragePort }).db;
      expect(db.prepare(`SELECT kind,run_id,invocation_result,failure_reason,config_version,lease_fence
        FROM source_attempt_events WHERE source_id=? ORDER BY sequence DESC LIMIT 1`).get(f.source.id)).toMatchObject({
        kind: "invocation", run_id: run.id, invocation_result: "failed",
        failure_reason: expect.not.stringContaining("secret"), config_version: run.configVersion, lease_fence: run.leaseFence,
      });

      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "published", runId: run.id });
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({ lastSyncResult: "success", freshness: "fresh" });
      expect(db.prepare(`SELECT kind,run_id,invocation_result FROM source_attempt_events
        WHERE source_id=? ORDER BY sequence DESC LIMIT 1`).get(f.source.id)).toEqual({
        kind: "invocation", run_id: run.id, invocation_result: "success",
      });
    } finally { f.cleanup(); }
  });

  it("keeps a published run successful while a pointer crash makes the invocation latest-failed", async () => {
    const f = fixture();
    try {
      await expect(f.core.syncGitMdSource(f.source.id, { materializer: { fault: (point) => {
        if (point === "after-current-swap") throw new Error("pointer publication crashed");
      } } })).rejects.toThrow(/pointer publication crashed/);
      const run = f.core.listSourceRuns(f.source.id)[0]!;
      expect(run).toMatchObject({ result: "success" });
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({
        lastSyncResult: "failed", freshness: "stale", lastError: "pointer publication crashed",
      });
      const db = (f.core as unknown as { db: StoragePort }).db;
      expect(db.prepare(`SELECT kind,run_id,invocation_result,failure_reason FROM source_attempt_events
        WHERE source_id=? ORDER BY sequence DESC LIMIT 1`).get(f.source.id)).toEqual({
        kind: "invocation", run_id: run.id, invocation_result: "failed", failure_reason: "pointer publication crashed",
      });

      await expect(f.core.syncGitMdSource(f.source.id)).resolves.toMatchObject({ status: "noop" });
      expect(f.core.sourceStatus(f.source.id, f.auth)).toMatchObject({ lastSyncResult: "success", freshness: "fresh" });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM source_attempt_events
        WHERE source_id=? AND kind='invocation' AND invocation_result='failed'`).get(f.source.id)).toEqual({ count: 1 });
      expect(db.prepare(`SELECT kind FROM source_attempt_events WHERE source_id=? ORDER BY sequence DESC LIMIT 1`).get(f.source.id))
        .toEqual({ kind: "verification" });
    } finally { f.cleanup(); }
  });

  it("sweeps all exact stale materialization variants and fails closed on prefix collisions", async () => {
    const f = fixture();
    try {
      await f.core.syncGitMdSource(f.source.id);
      const source = f.core.getSource(f.source.id)!;
      const variants = [
        `${source.activeSnapshotId!}-${source.activeIngestConfigHash!.slice(-64)}`,
        `${"a".repeat(40)}-${"b".repeat(64)}`,
      ];
      const snapshots = join(f.storage, "git-md", source.id, "snapshots");
      for (const [index, variant] of variants.entries()) {
        mkdirSync(join(snapshots, `.tree-${variant}-stale${index}`));
        writeFileSync(join(snapshots, `.complete-${variant}-stale${index}.json`), "{}");
        mkdirSync(join(f.storage, "git-md", source.id, `.materialize-${variant.split("-")[0]}-stale${index}`));
      }
      await f.core.syncGitMdSource(f.source.id);
      expect(readdirSync(snapshots).filter((name) => name.startsWith(".tree-") || name.startsWith(".complete-"))).toEqual([]);
      expect(readdirSync(join(f.storage, "git-md", source.id)).filter((name) => name.startsWith(".materialize-"))).toEqual([]);

      const exact = join(snapshots, `.tree-${variants[1]}-preserve`);
      const ambiguous = join(snapshots, `.tree-${variants[1]}-bad.token`);
      mkdirSync(exact); mkdirSync(ambiguous);
      await expect(f.core.syncGitMdSource(f.source.id)).rejects.toThrow(/ownership is ambiguous/);
      expect(existsSync(exact)).toBe(true);
      expect(existsSync(ambiguous)).toBe(true);
    } finally { f.cleanup(); }
  });

  it("bounds high-volume verification and failure history while preserving order across reopen", async () => {
    const f = fixture();
    let reopened: MonetCore | null = null;
    try {
      await f.core.syncSource(f.source.id, f.auth);
      const active = f.core.getSource(f.source.id)!;
      if (!active.activeRunId || !active.activeSnapshotId || !active.activeIngestConfigHash) throw new Error("missing active tuple");
      for (let index = 0; index <= 140; index += 1) {
        if (index % 2 === 0) f.core.recordSourcePrePinFailure({
          sourceId: active.id, reason: `immutable-failure-${index}`,
          configVersion: active.configVersion, leaseFence: active.leaseFence,
        });
        else f.core.recordSourceVerification({
          sourceId: active.id, runId: active.activeRunId, snapshotId: active.activeSnapshotId,
          ingestConfigHash: active.activeIngestConfigHash,
          configVersion: active.configVersion, leaseFence: active.leaseFence,
        });
      }
      const dbView = (core: MonetCore) => (core as unknown as { db: {
        prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> };
      } }).db;
      expect(dbView(f.core).prepare(`SELECT COUNT(*) AS count,MIN(sequence) AS minimum,MAX(sequence) AS maximum
        FROM source_attempt_events WHERE source_id=?`).get(active.id)).toEqual({ count: 128, minimum: 16, maximum: 143 });
      expect(f.core.sourceStatus(active.id, f.auth)).toMatchObject({
        lastSyncResult: "failed", lastError: "immutable-failure-140",
      });

      f.core.close();
      reopened = new MonetCore(join(f.root, "monet.db"), { sourceStorageDir: f.storage });
      expect(dbView(reopened).prepare(`SELECT COUNT(*) AS count,MIN(sequence) AS minimum,MAX(sequence) AS maximum
        FROM source_attempt_events WHERE source_id=?`).get(active.id)).toEqual({ count: 128, minimum: 16, maximum: 143 });
      expect(reopened.sourceStatus(active.id, f.auth)).toMatchObject({
        lastSyncResult: "failed", lastError: "immutable-failure-140",
      });
      reopened.recordSourceVerification({
        sourceId: active.id, runId: active.activeRunId, snapshotId: active.activeSnapshotId,
        ingestConfigHash: active.activeIngestConfigHash,
        configVersion: active.configVersion, leaseFence: active.leaseFence,
      });
      expect(dbView(reopened).prepare(`SELECT COUNT(*) AS count,MIN(sequence) AS minimum,MAX(sequence) AS maximum
        FROM source_attempt_events WHERE source_id=?`).get(active.id)).toEqual({ count: 128, minimum: 17, maximum: 144 });
      expect(reopened.sourceStatus(active.id, f.auth).lastSyncResult).toBe("success");
    } finally {
      reopened?.close();
      makeWritable(f.root);
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
