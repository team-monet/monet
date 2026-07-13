import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectRepoMdRenames, extractGitArchive, materializeRepoMdHead, pointRepoMdCurrent,
  withRepoMdMaterializerLock,
} from "../source-materializer";
import type { KnowledgeSource } from "../source-types";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function renameDiffExec(output: Buffer | string, error?: Error): typeof import("node:child_process").execFile {
  return ((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: Buffer, stderr: Buffer) => void;
    callback(error ?? null, Buffer.isBuffer(output) ? output : Buffer.from(output), Buffer.alloc(0));
    return {};
  }) as unknown as typeof import("node:child_process").execFile;
}

function fixture(): { root: string; repo: string; storage: string; source: KnowledgeSource; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "monet-materializer-"));
  const repo = join(root, "repo");
  const storage = join(root, "managed");
  execFileSync("git", ["init", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "committed bytes\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  const source: KnowledgeSource = {
    id: "repo-source", type: "repo-md", name: "repo", repositoryIdentity: "repo", localPath: repo,
    circle: "repo-source", autoDetect: false, include: ["README.md"], exclude: [], repoMappings: [],
    access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] }, writeBack: "none",
    refresh: { mode: "manual" }, configVersion: 1, appliedConfigVersion: null,
    activeRunId: null, activeSnapshotId: null, activeIngestConfigHash: null, leaseFence: 1,
    lifecycle: "active", status: "pending-initial-sync", createdAt: 1, updatedAt: 1, tombstonedAt: null,
  };
  const makeWritable = (path: string): void => {
    try {
      const stats = lstatSync(path);
      if (!stats.isDirectory()) { chmodSync(path, 0o600); return; }
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) makeWritable(join(path, entry));
    } catch { /* test cleanup */ }
  };
  return { root, repo, storage, source, cleanup: () => { makeWritable(root); rmSync(root, { recursive: true, force: true }); } };
}

function tarEntry(name: string, type: string, body = Buffer.alloc(0), link = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000600\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

describe("repo-md committed-HEAD materializer", () => {
  it("parses bounded NUL-framed rename evidence and preserves literal path characters", async () => {
    const oldOid = "a".repeat(40); const newOid = "b".repeat(40);
    const from = "docs/old name-[x].md"; const to = "docs/new name-$x.md";
    const result = await detectRepoMdRenames("/tmp", oldOid, newOid, new Set([from]), new Set([to]), {
      execFile: renameDiffExec(Buffer.from(`R087\0${from}\0${to}\0`)),
    });
    expect([...result]).toEqual([[from, to]]);
  });

  it("fails closed on malformed, duplicate, copy, oversized, and nonselected rename evidence", async () => {
    const oldOid = "a".repeat(40); const newOid = "b".repeat(40);
    const selectedOld = new Set(["a.md", "b.md"]); const selectedNew = new Set(["x.md", "y.md"]);
    for (const output of [
      "R100\0a.md\0x.md", // missing terminal NUL
      "R100\0a.md\0x.md\0R099\0a.md\0y.md\0", // duplicate source
      "R100\0a.md\0x.md\0R099\0b.md\0x.md\0", // duplicate destination
      "Rbad\0a.md\0x.md\0",
    ]) {
      expect(await detectRepoMdRenames("/tmp", oldOid, newOid, selectedOld, selectedNew, {
        execFile: renameDiffExec(output),
      })).toEqual(new Map());
    }
    expect(await detectRepoMdRenames("/tmp", oldOid, newOid, selectedOld, selectedNew, {
      execFile: renameDiffExec("C100\0a.md\0x.md\0"),
    })).toEqual(new Map());
    expect(await detectRepoMdRenames("/tmp", oldOid, newOid, selectedOld, selectedNew, {
      execFile: renameDiffExec("R100\0other.md\0x.md\0"),
    })).toEqual(new Map());
    expect(await detectRepoMdRenames("/tmp", oldOid, newOid, selectedOld, selectedNew, {
      execFile: renameDiffExec("R100\0a.md\0x.md\0"), maxOutputBytes: 4,
    })).toEqual(new Map());
  });

  it("pins exact committed HEAD and excludes dirty worktree bytes", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, "README.md"), "dirty bytes\n");
      writeFileSync(join(f.repo, "UNTRACKED.md"), "untracked\n");
      const result = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage });
      expect(result.snapshotId).toBe(git(f.repo, "rev-parse", "HEAD"));
      expect(readFileSync(join(result.snapshotPath, "README.md"), "utf8")).toBe("committed bytes\n");
      expect(() => readFileSync(join(result.snapshotPath, "UNTRACKED.md"))).toThrow();
      pointRepoMdCurrent(f.source.id, result.snapshotId, result.configHash, { sourceStorageDir: f.storage });
      expect(resolve(dirname(result.currentPath), readlinkSync(result.currentPath))).toBe(result.snapshotPath);
      expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe("dirty bytes\n");
    } finally { f.cleanup(); }
  });

  it("filters the pinned tree before archive and enforces selected resource budgets", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, "HUGE.bin"), Buffer.alloc(5 * 1024 * 1024, 7));
      git(f.repo, "add", "HUGE.bin"); git(f.repo, "commit", "-m", "huge unrelated binary");
      const selected = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage, maxArchiveBytes: 128 * 1024 });
      expect(readFileSync(join(selected.snapshotPath, "README.md"), "utf8")).toBe("committed bytes\n");
      expect(() => readFileSync(join(selected.snapshotPath, "HUGE.bin"))).toThrow();

      const selectedHuge = { ...f.source, include: ["HUGE.bin"] };
      await expect(materializeRepoMdHead(selectedHuge, {
        sourceStorageDir: join(f.root, "other-managed"),
        config: {
          autoDetect: false, include: ["HUGE.bin"], exclude: [],
          limits: { maxEntries: 10, maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024, maxParseMs: 1000, maxChunkBytes: 100, maxChunks: 10 },
        },
      })).rejects.toThrow(/file limit/);
    } finally { f.cleanup(); }
  });

  it("supports bounded raw-byte PAX records for long multibyte paths", async () => {
    const f = fixture();
    try {
      const longPath = `${"知识".repeat(24)}-${"é".repeat(40)}.md`;
      writeFileSync(join(f.repo, longPath), "multibyte path\n");
      git(f.repo, "add", longPath); git(f.repo, "commit", "-m", "long utf8 path");
      const source = { ...f.source, include: ["**/*.md", "*.md"] };
      const result = await materializeRepoMdHead(source, { sourceStorageDir: f.storage });
      expect(readFileSync(join(result.snapshotPath, longPath), "utf8")).toBe("multibyte path\n");
    } finally { f.cleanup(); }
  });

  it("passes enumerated Git filenames as literal archive pathspecs", async () => {
    const f = fixture();
    try {
      const hostile = ["[x].md", "*.md", ":(glob).md", ":(exclude).md"];
      for (const name of hostile) writeFileSync(join(f.repo, name), `${name}\n`);
      writeFileSync(join(f.repo, "DECOY.md"), "must stay excluded\n");
      git(f.repo, "--literal-pathspecs", "add", "--", ...hostile, "DECOY.md");
      git(f.repo, "commit", "-m", "literal pathspec fixtures");
      const source = { ...f.source, include: ["*.md"], exclude: ["README.md", "DECOY.md"] };
      const result = await materializeRepoMdHead(source, { sourceStorageDir: f.storage });
      expect(readdirSync(result.snapshotPath).sort()).toEqual([...hostile].sort());
      for (const name of hostile) expect(readFileSync(join(result.snapshotPath, name), "utf8")).toBe(`${name}\n`);
      expect(existsSync(join(result.snapshotPath, "README.md"))).toBe(false);
      expect(existsSync(join(result.snapshotPath, "DECOY.md"))).toBe(false);
    } finally { f.cleanup(); }
  });

  it("seals snapshots, validates exact-OID reuse, and rejects tampering", async () => {
    const f = fixture();
    try {
      const first = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage });
      const file = join(first.snapshotPath, "README.md");
      expect(statSync(first.snapshotPath).mode & 0o222).toBe(0);
      expect(statSync(file).mode & 0o222).toBe(0);
      expect(() => writeFileSync(file, "tamper")).toThrow();
      const reused = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage });
      expect(reused.snapshotPath).toBe(first.snapshotPath);
      chmodSync(file, 0o600);
      writeFileSync(file, "tampered bytes");
      await expect(materializeRepoMdHead(f.source, { sourceStorageDir: f.storage })).rejects.toThrow(/sealed|tampered/);
    } finally { f.cleanup(); }
  });

  it("keys immutable variants by OID and effective config while keeping scanner roots metadata-free", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.repo, "EXTRA.md"), "extra committed bytes\n");
      git(f.repo, "add", "EXTRA.md"); git(f.repo, "commit", "-m", "extra");
      const readmeOnly = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage });
      const broad = await materializeRepoMdHead({ ...f.source, include: ["**"] }, { sourceStorageDir: f.storage });
      expect(broad.snapshotId).toBe(readmeOnly.snapshotId);
      expect(broad.configHash).not.toBe(readmeOnly.configHash);
      expect(broad.snapshotPath).not.toBe(readmeOnly.snapshotPath);
      expect(readdirSync(readmeOnly.snapshotPath)).toEqual(["README.md"]);
      expect(readdirSync(broad.snapshotPath).sort()).toEqual(["EXTRA.md", "README.md"]);
      expect(existsSync(`${readmeOnly.snapshotPath}.complete.json`)).toBe(true);
      expect(existsSync(`${broad.snapshotPath}.complete.json`)).toBe(true);
      const reused = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage });
      expect(reused.snapshotPath).toBe(readmeOnly.snapshotPath);
      pointRepoMdCurrent(f.source.id, broad.snapshotId, broad.configHash, { sourceStorageDir: f.storage });
      expect(resolve(dirname(broad.currentPath), readlinkSync(broad.currentPath))).toBe(broad.snapshotPath);
    } finally { f.cleanup(); }
  });

  it("requires both variant halves and enforces the external manifest's exact tree closure", async () => {
    for (const mutation of ["sidecar-only", "extra", "directory", "missing", "marker"] as const) {
      const f = fixture();
      try {
        const first = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage });
        const sidecar = `${first.snapshotPath}.complete.json`;
        if (mutation === "sidecar-only") {
          const makeWritable = (path: string): void => {
            const stats = lstatSync(path);
            if (stats.isDirectory()) {
              chmodSync(path, 0o700);
              for (const child of readdirSync(path)) makeWritable(join(path, child));
            } else chmodSync(path, 0o600);
          };
          makeWritable(first.snapshotPath);
          rmSync(first.snapshotPath, { recursive: true });
          const repaired = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage });
          expect(repaired.snapshotPath).toBe(first.snapshotPath);
          expect(existsSync(sidecar)).toBe(true);
          continue;
        }
        if (mutation === "extra") {
          chmodSync(first.snapshotPath, 0o700);
          writeFileSync(join(first.snapshotPath, "EXTRA.md"), "not in git\n", { mode: 0o400 });
          chmodSync(first.snapshotPath, 0o500);
        } else if (mutation === "directory") {
          chmodSync(first.snapshotPath, 0o700);
          mkdirSync(join(first.snapshotPath, "not-in-git"), { mode: 0o500 });
          chmodSync(first.snapshotPath, 0o500);
        } else if (mutation === "missing") {
          chmodSync(first.snapshotPath, 0o700);
          unlinkSync(join(first.snapshotPath, "README.md"));
          chmodSync(first.snapshotPath, 0o500);
        } else {
          const marker = JSON.parse(readFileSync(sidecar, "utf8")) as { configHash: string };
          chmodSync(sidecar, 0o600);
          writeFileSync(sidecar, JSON.stringify({
            ...marker, configHash: `${marker.configHash.slice(0, -1)}${marker.configHash.endsWith("0") ? "1" : "0"}`,
          }));
          chmodSync(sidecar, 0o400);
        }
        await expect(materializeRepoMdHead(f.source, { sourceStorageDir: f.storage })).rejects.toThrow(/tampered|directory|incomplete|marker/);
        if (mutation === "directory") {
          rmSync(sidecar);
          const rebuilt = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage });
          expect(readdirSync(rebuilt.snapshotPath)).toEqual(["README.md"]);
          expect(existsSync(`${rebuilt.snapshotPath}.complete.json`)).toBe(true);
        }
      } finally { f.cleanup(); }
    }
  });

  for (const faultPoint of [
    "before-snapshot-rename", "after-snapshot-rename", "before-sidecar-rename", "after-sidecar-rename",
  ] as const) {
    it(`recovers an interrupted sealed variant at ${faultPoint}`, async () => {
      const f = fixture();
      try {
        let observedSealedRoot = false;
        await expect(materializeRepoMdHead(f.source, {
          sourceStorageDir: f.storage,
          fault: (point) => {
            if (point !== faultPoint) return;
            const snapshots = join(f.storage, "repo-md", f.source.id, "snapshots");
            const treeName = readdirSync(snapshots).find((name) =>
              faultPoint === "before-snapshot-rename" ? name.startsWith(".tree-") : !name.startsWith("."),
            );
            if (treeName && !treeName.endsWith(".json")) {
              observedSealedRoot = (statSync(join(snapshots, treeName)).mode & 0o222) === 0;
            }
            throw new Error(`fault:${faultPoint}`);
          },
        })).rejects.toThrow(`fault:${faultPoint}`);
        expect(observedSealedRoot).toBe(true);

        const repaired = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage });
        expect(statSync(repaired.snapshotPath).mode & 0o222).toBe(0);
        expect(existsSync(`${repaired.snapshotPath}.complete.json`)).toBe(true);
        expect(readdirSync(repaired.snapshotPath)).toEqual(["README.md"]);
        expect(readFileSync(join(repaired.snapshotPath, "README.md"), "utf8")).toBe("committed bytes\n");
      } finally { f.cleanup(); }
    });
  }

  it("keeps prior snapshot/current atomic across extraction and swap faults", async () => {
    const f = fixture();
    try {
      const first = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage });
      pointRepoMdCurrent(f.source.id, first.snapshotId, first.configHash, { sourceStorageDir: f.storage });
      writeFileSync(join(f.repo, "README.md"), "second\n");
      git(f.repo, "add", "README.md"); git(f.repo, "commit", "-m", "second");
      await expect(materializeRepoMdHead(f.source, {
        sourceStorageDir: f.storage,
        fault: (point) => { if (point === "before-snapshot-rename") throw new Error("fault"); },
      })).rejects.toThrow("fault");
      expect(resolve(dirname(first.currentPath), readlinkSync(first.currentPath))).toBe(first.snapshotPath);
      const second = await materializeRepoMdHead(f.source, { sourceStorageDir: f.storage });
      expect(() => pointRepoMdCurrent(f.source.id, second.snapshotId, second.configHash, {
        sourceStorageDir: f.storage,
        fault: (point) => { if (point === "before-current-swap") throw new Error("swap fault"); },
      })).toThrow("swap fault");
      expect(resolve(dirname(first.currentPath), readlinkSync(first.currentPath))).toBe(first.snapshotPath);
    } finally { f.cleanup(); }
  });

  it("rejects archive traversal, symlink, hardlink, and device entries", () => {
    const f = fixture();
    try {
      for (const [name, type] of [["../escape", "0"], ["link", "2"], ["hard", "1"], ["device", "3"]]) {
        const tar = join(f.root, `${type}.tar`);
        writeFileSync(tar, Buffer.concat([tarEntry(name, type), Buffer.alloc(1024)]));
        expect(() => extractGitArchive(tar, join(f.root, `out-${type}`))).toThrow(/unsafe|traversal|unsupported/);
      }
      expect(() => readFileSync(join(f.root, "escape"))).toThrow();
    } finally { f.cleanup(); }
  });

  it("rejects committed Git symlinks and serializes ownership-token locks with stale takeover", async () => {
    const f = fixture();
    try {
      symlinkSync("README.md", join(f.repo, "LINK.md"));
      git(f.repo, "add", "LINK.md"); git(f.repo, "commit", "-m", "symlink");
      await expect(materializeRepoMdHead({ ...f.source, include: ["*.md"] }, { sourceStorageDir: f.storage })).rejects.toThrow(/not a regular/);

      let now = 0;
      let release!: () => void;
      const held = new Promise<void>((resolvePromise) => { release = resolvePromise; });
      const first = withRepoMdMaterializerLock(f.source.id, { sourceStorageDir: f.storage, now: () => now, lockStaleMs: 10 }, async () => held);
      now = 100;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      const liveLock = join(f.storage, "repo-md", `.lock-${f.source.id}`);
      expect(JSON.parse(readFileSync(join(liveLock, "owner.json"), "utf8"))).toMatchObject({ heartbeatAt: 100, pid: process.pid });
      now = 1000;
      await expect(withRepoMdMaterializerLock(f.source.id, { sourceStorageDir: f.storage, now: () => now, lockStaleMs: 10 }, async () => undefined)).rejects.toThrow(/locked/);
      release(); await first;
      const lock = liveLock;
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ token: "dead-owner", heartbeatAt: 0, pid: 999999, host: hostname() }));
      await expect(withRepoMdMaterializerLock(f.source.id, {
        sourceStorageDir: f.storage, now: () => now, lockStaleMs: 10,
      }, async () => "taken")).resolves.toBe("taken");
    } finally { f.cleanup(); }
  });
});
