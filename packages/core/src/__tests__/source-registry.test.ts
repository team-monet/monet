import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MonetCore } from "../engine";
import type { CreateGitMdSource, CreateRepoMdSource } from "../source-types";
import type { StoragePort } from "../storage";

function repoInput(localPath: string, overrides: Partial<CreateRepoMdSource> = {}): CreateRepoMdSource {
  return {
    id: "repo-source",
    type: "repo-md",
    name: "Repository docs",
    repositoryIdentity: "github.com/Acme/Docs.git/",
    localPath,
    circle: "acme-docs",
    include: ["docs/**/*.md", "README.md"],
    exclude: ["vendor/**"],
    repoMappings: [{ repo: "https://github.com/Acme/App.git", paths: ["docs/**"] }],
    access: { allowedCallerIds: ["caller-a"], allowedProjectIds: ["project-a"] },
    writeBack: "none",
    refresh: { mode: "manual" },
    ...overrides,
  };
}

function gitInput(overrides: Partial<CreateGitMdSource> = {}): CreateGitMdSource {
  return {
    id: "git-source",
    type: "git-md",
    name: "Remote docs",
    remoteUrl: "HTTPS://GitHub.com/Acme/Docs.git/",
    branch: "main",
    circle: "remote-docs",
    include: ["README.md", "docs/**/*.md"],
    exclude: [],
    access: { allowedCallerIds: ["caller-a"], allowedProjectIds: ["project-a"] },
    transport: { allowedUrlSchemes: ["https"], allowedHosts: ["GITHUB.COM"] },
    writeBack: "none",
    refresh: { mode: "interval", intervalSeconds: 300 },
    ...overrides,
  };
}

describe("source registry schema and persistence", () => {
  it("migrates a v6 database through the v9 source-ledger schema and reopens idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-registry-migrate-"));
    const dbPath = join(dir, "monet.db");
    try {
      const staged = new MonetCore(dbPath);
      const stagedDb = (staged as unknown as { db: StoragePort }).db;
      stagedDb.exec("DROP TABLE knowledge_sources");
      stagedDb.pragma("user_version = 6");
      staged.close();

      const migrated = new MonetCore(dbPath);
      const migratedDb = (migrated as unknown as { db: StoragePort }).db;
      expect(migratedDb.pragma("user_version", { simple: true })).toBe(9);
      const columns = migratedDb.prepare("PRAGMA table_info(knowledge_sources)").all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "local_path_key")).toBe(true);
      const indexes = migratedDb.prepare("PRAGMA index_list(knowledge_sources)").all() as Array<{ name: string; partial: number }>;
      expect(indexes).toContainEqual(expect.objectContaining({ name: "uq_knowledge_sources_active_local_path_key", partial: 1 }));
      for (const [table, expected] of [
        ["concepts", ["sync_revision", "sync_writer"]],
        ["circle_aliases", ["updated_at", "sync_revision", "sync_writer"]],
        ["contradictions", ["updated_at", "sync_revision", "sync_writer"]],
        ["first_block", ["updated_at", "sync_revision", "sync_writer", "deleted_at"]],
        ["sessions", ["updated_at", "sync_revision", "sync_writer"]],
        ["memory_edge", ["legacy_count", "sync_updated_at"]],
        ["concept_tombstones", ["updated_at"]],
        ["concept_restorations", ["updated_at"]],
      ] as const) {
        const names = (migratedDb.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
        expect(names).toEqual(expect.arrayContaining([...expected]));
      }
      expect(migratedDb.prepare("PRAGMA table_info(memory_edge_components)").all()).not.toEqual([]);
      const deviceId = (migratedDb.prepare("SELECT device_id FROM sync_meta WHERE singleton = 1").get() as { device_id: string }).device_id;
      migrated.close();

      const reopened = new MonetCore(dbPath);
      const reopenedDb = (reopened as unknown as { db: StoragePort }).db;
      expect(reopenedDb.pragma("user_version", { simple: true })).toBe(9);
      expect((reopenedDb.prepare("SELECT device_id FROM sync_meta WHERE singleton = 1").get() as { device_id: string }).device_id).toBe(deviceId);
      expect(reopened.listSources()).toEqual([]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves graph-disabled migration ordering on a fresh database", () => {
    const core = new MonetCore(":memory:", { graphEnabled: false });
    try {
      const db = (core as unknown as { db: StoragePort }).db;
      expect(db.pragma("user_version", { simple: true })).toBe(0);
      expect((db.prepare("PRAGMA table_info(knowledge_sources)").all() as unknown[]).length).toBeGreaterThan(0);
    } finally {
      core.close();
    }
  });

  it("persists normalized repo-md and git-md sources without creating a git checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-registry-persist-"));
    const dbPath = join(dir, "monet.db");
    const sourceDir = join(dir, "managed-sources");
    try {
      const core = new MonetCore(dbPath, { sourceStorageDir: sourceDir });
      const repo = core.createSource(repoInput(join(dir, "repo", "..", "repo")));
      const git = core.createSource(gitInput());
      const canonicalDir = realpathSync.native(dir);
      expect(repo).toMatchObject({
        repositoryIdentity: "github.com/acme/docs",
        localPath: join(canonicalDir, "repo"),
        configVersion: 1,
        appliedConfigVersion: null,
        leaseFence: 1,
        status: "pending-initial-sync",
      });
      expect(git).toMatchObject({
        repositoryIdentity: "github.com/acme/docs",
        remoteUrl: "https://github.com/acme/docs",
        localPath: join(canonicalDir, "managed-sources", "git-source"),
        branch: "main",
        transport: { allowedUrlSchemes: ["https"], allowedHosts: ["github.com"] },
      });
      expect(existsSync(git.localPath)).toBe(false);
      core.close();

      const reopened = new MonetCore(dbPath, { sourceStorageDir: sourceDir });
      expect(reopened.getSource("repo-source")).toEqual(repo);
      expect(reopened.getSource("git-source")).toEqual(git);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("source registry validation", () => {
  it("uses portable lowercase source IDs that are safe URI authorities and managed path components", () => {
    const core = new MonetCore(":memory:");
    try {
      const source = core.createSource(repoInput("/tmp/repo", { id: "registry-source-1" }));
      const uri = new URL(`source://${source.id}/docs/readme.md`);
      expect(uri.protocol).toBe("source:");
      expect(uri.hostname).toBe(source.id);
      for (const id of ["has:colon", "CaseAlias", "case_alias", "case.alias", "con", "COM1", "-leading", "trailing-", " spaced "]) {
        expect(() => core.createSource(repoInput(`/tmp/${id.replaceAll("/", "-")}`, { id }))).toThrow(/lowercase portable/);
      }
      const badGenerator = new MonetCore(":memory:", { idGen: () => "Generated:Unsafe" });
      try {
        expect(() => badGenerator.createSource(repoInput("/tmp/generated", { id: undefined }))).toThrow(/lowercase portable/);
      } finally {
        badGenerator.close();
      }
    } finally {
      core.close();
    }
  });

  it("requires a canonical circle and default-deny ACLs", () => {
    const core = new MonetCore(":memory:");
    try {
      expect(() => core.createSource(repoInput("/tmp/repo", { circle: "  " }))).toThrow(/circle/);
      expect(() => core.createSource(repoInput("/tmp/repo", {
        access: { allowedCallerIds: [], allowedProjectIds: ["project-a"] },
      }))).toThrow(/allowedCallerIds.*nonempty/);
      expect(() => core.createSource(repoInput("/tmp/repo", {
        access: { allowedCallerIds: ["caller-a"], allowedProjectIds: [] },
      }))).toThrow(/allowedProjectIds.*nonempty/);
      expect(core.listSources()).toEqual([]);
    } finally {
      core.close();
    }
  });

  it("validates repo roots, arrays, write-back, and interval refresh", () => {
    const core = new MonetCore(":memory:");
    try {
      expect(() => core.createSource(repoInput("relative/repo"))).toThrow(/absolute path/);
      expect(() => core.createSource(repoInput("/tmp/repo", { include: [""] }))).toThrow(/include\[0\]/);
      expect(() => core.createSource(repoInput("/tmp/repo", { writeBack: "pull-request" }))).toThrow(/repo-md writeBack/);
      expect(() => core.createSource(repoInput("/tmp/repo", {
        refresh: { mode: "interval", intervalSeconds: 0 },
      }))).toThrow(/finite positive integer/);
      expect(() => core.createSource(repoInput("/tmp/repo", {
        refresh: { mode: "interval", intervalSeconds: Number.POSITIVE_INFINITY },
      }))).toThrow(/finite positive integer/);
      expect(() => core.createSource(repoInput("/tmp/repo", {
        refresh: { mode: "interval", intervalSeconds: 1.5 },
      }))).toThrow(/finite positive integer/);
      expect(() => core.createSource(repoInput("/tmp/repo", {
        refresh: { mode: "manual", intervalSeconds: 5 },
      }))).toThrow(/only for interval mode/);
    } finally {
      core.close();
    }
  });

  it("rejects repo roots equal to or beneath Monet-owned source storage, including symlink aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-overlap-"));
    const managed = join(dir, "managed");
    const outside = join(dir, "outside");
    mkdirSync(managed, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const core = new MonetCore(":memory:", { sourceStorageDir: managed });
    try {
      expect(() => core.createSource(repoInput(managed, { id: "exact-managed" }))).toThrow(/must not overlap/);
      expect(() => core.createSource(repoInput(join(managed, "nested"), { id: "beneath-managed" }))).toThrow(/must not overlap/);
      const git = core.createSource(gitInput({ id: "owned-git-path" }));
      expect(() => core.createSource(repoInput(git.localPath, { id: "git-path-as-repo" }))).toThrow(/must not overlap/);

      if (process.platform !== "win32") {
        const managedAlias = join(outside, "managed-alias");
        symlinkSync(managed, managedAlias, "dir");
        expect(() => core.createSource(repoInput(join(managedAlias, "nested"), { id: "symlink-managed" }))).toThrow(/must not overlap/);

        const repoTarget = join(outside, "repo-target");
        mkdirSync(repoTarget);
        const repoAlias = join(dir, "repo-alias");
        symlinkSync(repoTarget, repoAlias, "dir");
        const repo = core.createSource(repoInput(repoAlias, { id: "canonical-repo" }));
        expect(repo.localPath).toBe(realpathSync.native(repoTarget));
      }
    } finally {
      core.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a repo root containing project-local .monet/sources and durably reserves that subtree", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-project-local-"));
    const repo = join(dir, "project");
    const managed = join(repo, ".monet", "sources");
    mkdirSync(repo, { recursive: true });
    const core = new MonetCore(":memory:", { sourceStorageDir: managed });
    try {
      const created = core.createSource(repoInput(repo, {
        id: "project-local-source",
        exclude: ["vendor/**"],
      }));
      expect(created.exclude).toEqual([".monet/sources/**", "vendor/**"]);

      const cleared = core.updateSource(created.id, { exclude: [] });
      expect(cleared.exclude).toEqual([".monet/sources/**"]);
      const renamed = core.updateSource(created.id, { name: "Still reserved" });
      expect(renamed.exclude).toEqual([".monet/sources/**"]);
    } finally {
      core.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses active canonical path ownership and releases repo paths when a source is tombstoned", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-path-owner-"));
    const repo = join(dir, "CaseSensitiveRepo");
    mkdirSync(repo);
    const alias = join(dir, "repo-alias");
    if (process.platform !== "win32") symlinkSync(repo, alias, "dir");
    const core = new MonetCore(":memory:", { sourceStorageDir: join(dir, "managed") });
    try {
      const first = core.createSource(repoInput(repo, { id: "first-owner" }));
      expect(() => core.createSource(repoInput(repo.toLowerCase(), { id: "case-alias-owner" }))).toThrow(/active source id/);
      if (process.platform !== "win32") {
        expect(() => core.createSource(repoInput(alias, { id: "symlink-alias-owner" }))).toThrow(/active source id/);
      }

      core.removeSource(first.id);
      const replacement = core.createSource(repoInput(repo, { id: "replacement-owner" }));
      expect(replacement.localPath).toBe(first.localPath);
      expect(core.listSources({ includeTombstoned: true }).map((source) => source.id)).toEqual(["first-owner", "replacement-owner"]);
    } finally {
      core.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts supported POSIX globs and rejects unsafe or unreasonable source-relative patterns", () => {
    const core = new MonetCore(":memory:");
    try {
      const valid = core.createSource(repoInput("/tmp/pattern-repo", {
        id: "valid-patterns",
        include: ["**/*.md", "README.md", ".github/**/*.md"],
        exclude: ["vendor/**/*.md"],
        repoMappings: [{ repo: "github.com/acme/app", paths: ["docs/**/*.md"] }],
      }));
      expect(valid.include).toEqual(["**/*.md", ".github/**/*.md", "README.md"]);

      const invalidPatterns = [
        "/absolute.md",
        "../secret.md",
        "docs/../secret.md",
        "docs\\..\\secret.md",
        "nul\0.md",
        "control\u0001.md",
        "./README.md",
        "docs//README.md",
        " README.md ",
        "docs/{safe,../secret}.md",
        "docs/@(one|two).md",
        "!docs/private.md",
        "[.][.]/secret.md",
        "??/secret.md",
        `${"a".repeat(513)}.md`,
      ];
      for (const pattern of invalidPatterns) {
        expect(() => core.createSource(repoInput("/tmp/invalid-pattern", {
          id: "invalid-pattern",
          include: [pattern],
        }))).toThrow(/pattern|source-relative|traversal|backslash|control|characters|unsupported|syntax/);
      }
      expect(() => core.createSource(repoInput("/tmp/too-many-patterns", {
        id: "too-many-patterns",
        include: Array.from({ length: 257 }, (_, index) => `docs/${index}.md`),
      }))).toThrow(/at most 256/);
      expect(() => core.createSource(repoInput("/tmp/mapping-traversal", {
        id: "mapping-traversal",
        repoMappings: [{ repo: "github.com/acme/app", paths: ["../secret.md"] }],
      }))).toThrow(/traversal/);
    } finally {
      core.close();
    }
  });

  it("rejects credential-bearing/remotely disallowed URLs and invalid branches/transports", () => {
    const core = new MonetCore(":memory:");
    try {
      expect(() => core.createSource(gitInput({ remoteUrl: "https://user:super-secret@github.com/acme/docs.git" }))).toThrow(
        /embedded credentials/,
      );
      expect(() => core.createSource(gitInput({ remoteUrl: "file:///tmp/docs" }))).toThrow(/scheme/);
      expect(() => core.createSource(gitInput({ branch: "bad..branch" }))).toThrow(/valid explicit Git branch/);
      expect(() => core.createSource(gitInput({ branch: "-main" }))).toThrow(/valid explicit Git branch/);
      expect(() => core.createSource(gitInput({ branch: "HEAD" }))).toThrow(/valid explicit Git branch/);
      expect(() => core.createSource(gitInput({ branch: "feature/.hidden" }))).toThrow(/valid explicit Git branch/);
      expect(() => core.createSource(gitInput({ branch: "feature.lock" }))).toThrow(/valid explicit Git branch/);
      expect(() => core.createSource(gitInput({ branch: " main " }))).toThrow(/valid explicit Git branch/);
      expect(() => core.createSource(gitInput({ remoteUrl: "https://github.com/acme/docs/tree/main" }))).toThrow(/exactly owner\/repository/);
      expect(() => core.createSource(gitInput({
        remoteUrl: "ssh://git@github.com/acme/docs/tree/main",
        transport: { allowedUrlSchemes: ["ssh"], allowedHosts: ["github.com"] },
      }))).toThrow(/exactly owner\/repository/);
      expect(() => core.createSource(gitInput({
        transport: { allowedUrlSchemes: [], allowedHosts: ["github.com"] },
      }))).toThrow(/allowedUrlSchemes.*nonempty/);
      expect(() => core.createSource(gitInput({
        transport: { allowedUrlSchemes: ["https"], allowedHosts: [] },
      }))).toThrow(/allowedHosts.*nonempty/);
      expect(() => core.createSource(gitInput({
        transport: { allowedUrlSchemes: ["ssh"], allowedHosts: ["github.com"] },
      }))).toThrow(/not allowed/);
      expect(() => core.createSource(gitInput({
        remoteUrl: "https://gitlab.com/acme/docs",
        transport: { allowedUrlSchemes: ["https"], allowedHosts: ["gitlab.com"] },
        writeBack: "pull-request",
      }))).toThrow(/only.*GitHub/);
      expect(core.listSources()).toEqual([]);
    } finally {
      core.close();
    }
  });

  it("keeps non-GitHub transport-policy hosts workable without accepting GitHub web paths", () => {
    const core = new MonetCore(":memory:");
    try {
      const source = core.createSource(gitInput({
        id: "self-hosted-git",
        remoteUrl: "https://git.example.test/groups/acme/docs.git",
        transport: { allowedUrlSchemes: ["https"], allowedHosts: ["git.example.test"] },
      }));
      expect(source.remoteUrl).toBe("https://git.example.test/groups/acme/docs");
    } finally {
      core.close();
    }
  });

  it("accepts a credential-free SSH username while stripping it from repository identity", () => {
    const core = new MonetCore(":memory:");
    try {
      const source = core.createSource(gitInput({
        remoteUrl: "ssh://git@GitHub.com/Acme/Docs.git",
        transport: { allowedUrlSchemes: ["ssh"], allowedHosts: ["github.com"] },
      }));
      expect(source.remoteUrl).toBe("ssh://git@github.com/acme/docs");
      expect(source.repositoryIdentity).toBe("github.com/acme/docs");
    } finally {
      core.close();
    }
  });
});

describe("source registry lifecycle and authorization", () => {
  it("blocks registry-only source circles from rename and merge without stranding later updates", async () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(repoInput("/tmp/rename-source", { id: "rename-source", circle: "rename-from" }));
      expect(() => core.renameCircle("rename-from", "rename-to")).toThrow(/registered sources/);
      const afterRenameBlock = core.updateSource("rename-source", { name: "Still updateable after rename block" });
      expect(afterRenameBlock).toMatchObject({ circle: "rename-from", configVersion: 2 });

      core.createSource(repoInput("/tmp/merge-source", { id: "merge-source", circle: "merge-from" }));
      await core.store("Destination fact.", { circle: "merge-to" });
      await expect(core.mergeCircle("merge-from", "merge-to")).rejects.toThrow(/registered sources/);
      const afterMergeBlock = core.updateSource("merge-source", { name: "Still updateable after merge block" });
      expect(afterMergeBlock).toMatchObject({ circle: "merge-from", configVersion: 2 });
      core.removeSource("merge-source");
      await expect(core.mergeCircle("merge-from", "merge-to")).rejects.toThrow(/registered sources/);

      core.createSource(repoInput("/tmp/merge-destination", { id: "merge-destination", circle: "protected-destination" }));
      await core.store("Source fact.", { circle: "ordinary-source" });
      await expect(core.mergeCircle("ordinary-source", "protected-destination")).rejects.toThrow(/registered sources/);

      core.removeSource("rename-source");
      expect(() => core.renameCircle("rename-from", "rename-to")).toThrow(/registered sources/);
    } finally {
      core.close();
    }
  });

  it("canonicalizes source circles against aliases committed by another open connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-source-circle-lock-"));
    const dbPath = join(dir, "monet.db");
    const first = new MonetCore(dbPath);
    const waiting = new MonetCore(dbPath);
    try {
      await first.store("Circle identity anchor.", { circle: "old-circle" });
      first.renameCircle("old-circle", "new-circle");

      const source = waiting.createSource(repoInput(join(dir, "repo"), {
        id: "post-rename-source",
        circle: "old-circle",
      }));
      expect(source.circle).toBe("new-circle");
      expect(() => first.renameCircle("new-circle", "later-circle")).toThrow(/registered sources/);
      expect(waiting.updateSource(source.id, { name: "Not stranded" }).circle).toBe("new-circle");
    } finally {
      waiting.close();
      first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes arrays deterministically, increments config/fence on change, and preserves exact no-ops", () => {
    const core = new MonetCore(":memory:");
    try {
      const created = core.createSource(repoInput("/tmp/repo", {
        include: ["z/**", "a/**", "z/**"],
        access: { allowedCallerIds: ["caller-b", "caller-a", "caller-a"], allowedProjectIds: ["project-b", "project-a"] },
        repoMappings: [
          { repo: "github.com/Acme/App.git", paths: ["z/**"] },
          { repo: "https://github.com/acme/app", paths: ["a/**"] },
        ],
      }));
      expect(created.include).toEqual(["a/**", "z/**"]);
      expect(created.access.allowedCallerIds).toEqual(["caller-a", "caller-b"]);
      expect(created.repoMappings).toEqual([{ repo: "github.com/acme/app", paths: ["a/**", "z/**"] }]);

      const noop = core.updateSource(created.id, {
        include: ["z/**", "a/**"],
        access: { allowedCallerIds: ["caller-b", "caller-a"], allowedProjectIds: ["project-a", "project-b"] },
      });
      expect(noop.configVersion).toBe(1);
      expect(noop.leaseFence).toBe(1);

      const changed = core.updateSource(created.id, { name: "Renamed docs" });
      expect(changed.configVersion).toBe(2);
      expect(changed.leaseFence).toBe(2);
      expect(changed.appliedConfigVersion).toBeNull();
      expect(changed.status).toBe("pending-initial-sync");
    } finally {
      core.close();
    }
  });

  it("rejects every source identity mutation", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(gitInput());
      for (const patch of [
        { id: "new-id" },
        { type: "repo-md" as const },
        { repositoryIdentity: "github.com/acme/other" },
        { remoteUrl: "https://github.com/acme/other" },
        { localPath: "/tmp/other" },
        { branch: "other" },
        { circle: "other" },
      ]) {
        expect(() => core.updateSource("git-source", patch)).toThrow(/source-identity-immutable/);
      }
      expect(core.getSource("git-source")!.configVersion).toBe(1);
    } finally {
      core.close();
    }
  });

  it("lists deterministically, defaults to active-only, and tombstones idempotently with a permanent id fence", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(repoInput("/tmp/z", { id: "z-source" }));
      core.createSource(repoInput("/tmp/a", { id: "a-source" }));
      expect(core.listSources().map((source) => source.id)).toEqual(["a-source", "z-source"]);

      const removed = core.removeSource("a-source")!;
      expect(removed).toMatchObject({ lifecycle: "tombstoned", status: "tombstoned", leaseFence: 2, configVersion: 1 });
      expect(core.removeSource("a-source")).toEqual(removed);
      expect(core.getSource("a-source")).toBeNull();
      expect(core.getSource("a-source", { includeTombstoned: true })).toEqual(removed);
      expect(core.listSources().map((source) => source.id)).toEqual(["z-source"]);
      expect(core.listSources({ includeTombstoned: true }).map((source) => source.id)).toEqual(["a-source", "z-source"]);
      expect(() => core.createSource(repoInput("/tmp/reused", { id: "a-source" }))).toThrow(/permanently tombstoned/);
      expect(core.removeSource("missing-source")).toBeNull();
    } finally {
      core.close();
    }
  });

  it("authorizes only exact caller AND project membership; repo mappings never authorize", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(repoInput("/tmp/repo", {
        repoMappings: [{ repo: "opaque-project-id" }],
        access: { allowedCallerIds: ["caller-a"], allowedProjectIds: ["project-a"] },
      }));
      expect(core.authorizeSource("repo-source", "caller-a", "project-a")).toBe(true);
      expect(core.authorizeSource("repo-source", { callerId: "caller-a", projectId: "project-a" })).toBe(true);
      expect(core.authorizeSource("repo-source", "caller-b", "project-a")).toBe(false);
      expect(core.authorizeSource("repo-source", "caller-a", "project-b")).toBe(false);
      expect(core.authorizeSource("repo-source", "opaque-project-id", "opaque-project-id")).toBe(false);
      core.removeSource("repo-source");
      expect(core.authorizeSource("repo-source", "caller-a", "project-a")).toBe(false);
    } finally {
      core.close();
    }
  });

  it("derives active and pending-replacement from the activation seam", () => {
    const core = new MonetCore(":memory:");
    try {
      core.createSource(repoInput("/tmp/repo"));
      const db = (core as unknown as { db: StoragePort }).db;
      db.prepare("UPDATE knowledge_sources SET applied_config_version = config_version WHERE id = ?").run("repo-source");
      expect(core.getSource("repo-source")!.status).toBe("active");
      const changed = core.updateSource("repo-source", { name: "Replacement config" });
      expect(changed).toMatchObject({ configVersion: 2, appliedConfigVersion: 1, status: "pending-replacement" });
    } finally {
      core.close();
    }
  });

  it("never includes registry rows in generic exportDelta/graftRows", () => {
    const source = new MonetCore(":memory:");
    const replica = new MonetCore(":memory:");
    try {
      source.createSource(repoInput("/tmp/repo", { id: "registry-only-source" }));
      const payload = source.exportDelta(0);
      expect(JSON.stringify(payload)).not.toContain("registry-only-source");
      replica.graftRows(payload);
      expect(replica.listSources({ includeTombstoned: true })).toEqual([]);
    } finally {
      source.close();
      replica.close();
    }
  });
});
