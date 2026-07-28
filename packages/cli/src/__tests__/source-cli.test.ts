import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { MonetCore } from "@team-monet/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerSourceCommands,
  SourceCliError,
  type SourceCliDependencies,
  type SourceCore,
} from "../source-cli";

describe("source CLI", () => {
  let dir: string;
  let projectDir: string;
  let dbPath: string;
  let sourceStorageDir: string;
  let closeCount: number;
  let dependencies: SourceCliDependencies;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monet-source-cli-"));
    projectDir = join(dir, "project");
    dbPath = join(dir, "store", "monet.db");
    sourceStorageDir = join(dir, "store", "sources");
    mkdirSync(projectDir, { recursive: true });
    initGitRepository(projectDir);
    mkdirSync(join(dir, "store"), { recursive: true });
    closeCount = 0;
    dependencies = {
      openCore(): SourceCore {
        const core = new MonetCore(dbPath, { sourceStorageDir });
        return {
          createSource: core.createSource.bind(core),
          updateSource: core.updateSource.bind(core),
          listSources: core.listSources.bind(core),
          getSource: core.getSource.bind(core),
          removeSource: core.removeSource.bind(core),
          close() {
            closeCount += 1;
            core.close();
          },
        };
      },
      deriveCircle: vi.fn(() => "derived-project-circle"),
      deriveCallerId: vi.fn(() => "test-caller"),
      deriveProjectId: vi.fn(() => "test-project-id"),
      projectDir: () => projectDir,
      dbPath: () => dbPath,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      stdout.push(values.map(String).join(" "));
    });
    const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      stderr.push(values.map(String).join(" "));
    });
    const program = new Command().name("monet");
    registerSourceCommands(program, dependencies);
    try {
      await program.parseAsync(["node", "monet", ...args]);
      return {
        stdout: stdout.length === 0 ? "" : `${stdout.join("\n")}\n`,
        stderr: stderr.length === 0 ? "" : `${stderr.join("\n")}\n`,
      };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  function inspect<T>(read: (core: MonetCore) => T): T {
    const core = new MonetCore(dbPath, { sourceStorageDir });
    try {
      return read(core);
    } finally {
      core.close();
    }
  }

  function initGitRepository(root: string, commit = true): void {
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "source-cli@example.test"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Source CLI Test"]);
    if (commit) {
      writeFileSync(join(root, "README.md"), "# Source CLI fixture\n");
      execFileSync("git", ["-C", root, "add", "README.md"]);
      execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "fixture"]);
    }
  }

  it("infers an existing local Git root, name, and current server ACL without syncing", async () => {
    const repository = join(projectDir, "my-vault");
    initGitRepository(repository);
    writeFileSync(join(repository, "draft.md"), "not committed\n");

    const output = await run([
      "source", "add", "./my-vault",
      "--include", "README.md",
      "--exclude", "generated/**",
    ]);

    const registered = inspect((core) => core.listSources()[0]);
    expect(registered).toMatchObject({
      type: "repo-md",
      name: "my-vault",
      localPath: realpathSync.native(repository),
      access: { allowedCallerIds: ["test-caller"], allowedProjectIds: ["test-project-id"] },
      include: ["README.md"],
      exclude: ["generated/**"],
      status: "pending-initial-sync",
    });
    expect(output.stdout).toContain(`Registered source: ${registered.id}`);
    expect(output.stdout).toContain("Type: repo-md");
    expect(output.stdout).toContain(`Origin: ${realpathSync.native(repository)}`);
    expect(output.stdout).toContain("Committed HEAD: required; sync excludes working-tree changes");
    expect(output.stdout).toContain("ACL callers: test-caller");
    expect(output.stdout).toContain("ACL projects: test-project-id");
    expect(output.stdout).toContain("Content sync: not run");
    expect(output.stdout).toContain(`MCP source_sync with {"sourceId":"${registered.id}"}`);
    expect(output.stdout).toContain("Server identity: caller test-caller · project test-project-id");
  });

  it("infers and canonicalizes a strict SCP SSH remote with exact transport defaults", async () => {
    const output = await run([
      "source", "add", "git@github.com:org/docs.git",
      "--branch", "main",
    ]);

    const registered = inspect((core) => core.listSources()[0]);
    expect(registered).toMatchObject({
      type: "git-md",
      name: "docs",
      remoteUrl: "ssh://git@github.com/org/docs",
      branch: "main",
      access: { allowedCallerIds: ["test-caller"], allowedProjectIds: ["test-project-id"] },
      transport: { allowedUrlSchemes: ["ssh"], allowedHosts: ["github.com"] },
      include: ["**/*.md"],
      autoDetect: false,
      status: "pending-initial-sync",
    });
    expect(output.stdout).toContain("Origin: ssh://git@github.com/org/docs");
    expect(output.stdout).toContain("Transport schemes: ssh");
    expect(output.stdout).toContain("Transport hosts: github.com");
    expect(output.stdout).toContain("Content sync: not run");
  });

  it("defaults inferred local selection to Markdown and lets explicit include replace it", async () => {
    const defaultRepository = join(projectDir, "default-selection");
    const explicitRepository = join(projectDir, "explicit-selection");
    initGitRepository(defaultRepository);
    initGitRepository(explicitRepository);

    await run(["source", "add", "./default-selection"]);
    await run(["source", "add", "./explicit-selection", "--include", "README.md"]);

    // Keyed by name, not array position: both sources register within the same timestamp
    // granularity, so listSources() returns them in an unstable order.
    const byName = new Map(inspect((core) => core.listSources()).map((source) => [source.name, source]));
    expect(byName.get("default-selection")).toMatchObject({ include: ["**/*.md"], autoDetect: false });
    expect(byName.get("explicit-selection")).toMatchObject({ include: ["README.md"], autoDetect: false });
  });

  it("infers HTTPS remote details and accepts an explicit name and exact ACL/transport overrides", async () => {
    await run([
      "source", "add", "https://github.com/acme/docs.git",
      "--branch", "stable",
      "--name", "Team docs",
      "--allow-caller", "caller-a",
      "--allow-caller", "caller-b",
      "--allow-project", "project-a",
      "--allow-scheme", "https",
      "--allow-host", "GITHUB.COM",
    ]);

    expect(inspect((core) => core.listSources()[0])).toMatchObject({
      type: "git-md",
      name: "Team docs",
      remoteUrl: "https://github.com/acme/docs",
      branch: "stable",
      access: { allowedCallerIds: ["caller-a", "caller-b"], allowedProjectIds: ["project-a"] },
      transport: { allowedUrlSchemes: ["https"], allowedHosts: ["github.com"] },
      include: ["**/*.md"],
      autoDetect: false,
    });
  });

  it("rejects local inferred origins that are not the exact Git root with a committed HEAD", async () => {
    const plainDirectory = join(dir, "plain");
    mkdirSync(plainDirectory);
    await expect(run(["source", "add", plainDirectory])).rejects.toEqual(
      expect.objectContaining<Partial<SourceCliError>>({ message: expect.stringContaining("not a Git worktree") }),
    );

    const emptyRepository = join(projectDir, "empty-repo");
    initGitRepository(emptyRepository, false);
    await expect(run(["source", "add", "./empty-repo"])).rejects.toEqual(
      expect.objectContaining<Partial<SourceCliError>>({ message: expect.stringContaining("committed HEAD") }),
    );

    const repository = join(projectDir, "rooted-repo");
    initGitRepository(repository);
    mkdirSync(join(repository, "docs"));
    await expect(run(["source", "add", "./rooted-repo/docs"])).rejects.toEqual(
      expect.objectContaining<Partial<SourceCliError>>({ message: expect.stringContaining("must be the Git worktree root") }),
    );
    expect(closeCount).toBe(0);
    expect(inspect((core) => core.listSources())).toEqual([]);
  });

  it("rejects unsupported, credential-bearing, and ambiguous remote forms", async () => {
    const cases = [
      ["ftp://github.com/org/docs.git", "scheme must be https or ssh"],
      ["https://user:secret@github.com/org/docs.git", "must not contain embedded credentials"],
      ["github.com:org/docs.git", "ambiguous remote origin"],
      ["git@@github.com:org/docs.git", "use an explicit ssh:// URL"],
      ["git@github.com:", "use an explicit ssh:// URL"],
      ["git@github..com:org/docs.git", "use an explicit ssh:// URL"],
      ["deploy@gitlab.com:org/docs.git", "use an explicit ssh:// URL"],
      ["git@github.com:org/docs/extra.git", "use an explicit ssh:// URL"],
    ] as const;
    for (const [origin, message] of cases) {
      await expect(run(["source", "add", origin, "--branch", "main"])).rejects.toEqual(
        expect.objectContaining<Partial<SourceCliError>>({ message: expect.stringContaining(message) }),
      );
    }
  });

  it("accepts explicit non-GitHub ssh URLs while keeping SCP shorthand GitHub-only", async () => {
    await run([
      "source", "add", "ssh://deploy@gitlab.example.com/org/docs.git", "--branch", "main",
    ]);
    expect(inspect((core) => core.listSources()[0])).toMatchObject({
      type: "git-md",
      remoteUrl: "ssh://deploy@gitlab.example.com/org/docs",
      transport: { allowedUrlSchemes: ["ssh"], allowedHosts: ["gitlab.example.com"] },
    });
  });

  it("requires a remote branch and prevents inferred transport widening", async () => {
    await expect(run(["source", "add", "git@github.com:org/docs.git"])).rejects.toEqual(
      expect.objectContaining<Partial<SourceCliError>>({ message: "remote Git origin requires --branch" }),
    );
    await expect(run([
      "source", "add", "https://github.com/org/docs.git", "--branch", "main",
      "--allow-scheme", "https", "--allow-scheme", "ssh",
    ])).rejects.toEqual(
      expect.objectContaining<Partial<SourceCliError>>({ message: expect.stringContaining("exact https scheme") }),
    );
    await expect(run([
      "source", "add", "https://github.com/org/docs.git", "--branch", "main",
      "--allow-host", "github.com", "--allow-host", "example.com",
    ])).rejects.toEqual(
      expect.objectContaining<Partial<SourceCliError>>({ message: expect.stringContaining("exact github.com host") }),
    );
  });

  it("keeps inferred local and remote acquisition flags separate", async () => {
    const repository = join(projectDir, "local-repo");
    initGitRepository(repository);
    await expect(run(["source", "add", "./local-repo", "--branch", "main"])).rejects.toEqual(
      expect.objectContaining<Partial<SourceCliError>>({ message: expect.stringContaining("local inferred origins") }),
    );
    await expect(run([
      "source", "add", "https://github.com/org/docs.git", "--branch", "main", "--path", "./local-repo",
    ])).rejects.toEqual(
      expect.objectContaining<Partial<SourceCliError>>({ message: "remote inferred origins do not accept --path" }),
    );
  });

  it("prefers existing local Git paths containing remote-like punctuation", async () => {
    const atRepository = join(projectDir, "docs@local");
    const colonRepository = join(projectDir, "docs:local");
    initGitRepository(atRepository);
    initGitRepository(colonRepository);

    await run(["source", "add", "./docs@local"]);
    await run(["source", "add", "./docs:local"]);

    const registered = inspect((core) => core.listSources());
    expect(registered.map((source) => source.localPath).sort()).toEqual([
      realpathSync.native(atRepository),
      realpathSync.native(colonRepository),
    ].sort());
    expect(registered.every((source) => source.type === "repo-md")).toBe(true);
  });

  it("rejects terminal control characters in every source-name path before registration", async () => {
    const localWithControl = join(projectDir, "bad\u001bname");
    initGitRepository(localWithControl);
    const cases = [
      ["source", "add", "https://github.com/org/bad%1Bname.git", "--branch", "main"],
      ["source", "add", "https://github.com/org/docs.git", "--branch", "main", "--name", "bad\u0007name"],
      ["source", "add", "./bad\u001bname"],
      [
        "source", "add", "bad\u0085name", "--type", "repo-md",
        "--allow-caller", "caller-a", "--allow-project", "project-a",
      ],
    ];
    for (const args of cases) {
      await expect(run(args)).rejects.toEqual(expect.objectContaining<Partial<SourceCliError>>({
        message: "source name must not contain terminal control characters",
      }));
    }
    expect(inspect((core) => core.listSources())).toEqual([]);
  });

  it("preserves legacy --type validation instead of applying inferred defaults", async () => {
    await expect(run(["source", "add", "Project docs", "--type", "repo-md"])).rejects.toEqual(
      expect.objectContaining<Partial<SourceCliError>>({
        message: "legacy --type syntax requires at least one --allow-caller",
      }),
    );
  });

  it("rejects an invalid legacy repo-md path before creating a registration", async () => {
    const plainDirectory = join(dir, "legacy-plain");
    mkdirSync(plainDirectory);
    await expect(run([
      "source", "add", "Legacy docs", "--type", "repo-md", "--path", "../legacy-plain",
      "--allow-caller", "caller-a", "--allow-project", "project-a",
    ])).rejects.toEqual(expect.objectContaining<Partial<SourceCliError>>({
      message: expect.stringContaining("not a Git worktree"),
    }));
    expect(closeCount).toBe(0);
  });

  it("adds repo-md at the resolved project path with required default-deny ACLs", async () => {
    const canonicalProjectDir = realpathSync.native(projectDir);
    const output = await run([
      "source", "add", "Project docs",
      "--type", "repo-md",
      "--include", "README.md",
      "--include", "docs/**/*.md",
      "--allow-caller", "caller-a",
      "--allow-project", "project-a",
    ]);

    expect(output.stderr).toBe(`store: ${dbPath}\n`);
    expect(output.stdout).toContain("Status: pending-initial-sync");
    expect(output.stdout).toContain(`Local path: ${canonicalProjectDir}`);
    expect(output.stdout).toContain("Content sync: not run");
    expect(output.stdout).toContain("Server identity: caller test-caller · project test-project-id");
    const source = inspect((core) => core.listSources()[0]);
    expect(source).toMatchObject({
      type: "repo-md",
      name: "Project docs",
      circle: "derived-project-circle",
      localPath: canonicalProjectDir,
      access: { allowedCallerIds: ["caller-a"], allowedProjectIds: ["project-a"] },
      include: ["README.md", "docs/**/*.md"],
    });
    // P1-2 (Codex round 3 on PR #42): identity=canonicalProjectDir (the worktree, here the SAME
    // dir as the invoking project since no --path override), storeDir=projectDir (the invoking
    // project's own store — where createSource below actually writes). See circle.ts's own
    // deriveCircle for the full matrix; source-cli.ts's own two worktree call sites for the fix.
    expect(dependencies.deriveCircle).toHaveBeenCalledWith(canonicalProjectDir, { storeDir: projectDir });
    // The server identity is derived from the INVOCATION project dir (dependencies.projectDir()),
    // not the repo-md source's own root — those two can differ (e.g. a custom --path).
    expect(dependencies.deriveProjectId).toHaveBeenCalledWith(projectDir);
    expect(closeCount).toBe(1);
  });

  it("defaults add to hourly refresh and prints the first-sync behavior", async () => {
    const output = await run([
      "source", "add", "Project docs", "--type", "repo-md",
      "--allow-caller", "caller-a", "--allow-project", "project-a",
    ]);

    expect(output.stdout).toContain("refresh: every 60m (first sync runs when a server is up — `monet start`)");
    expect(inspect((core) => core.listSources()[0].refresh)).toEqual({
      mode: "interval",
      intervalSeconds: 3600,
    });
    expect(inspect((core) => core.listSources()[0])).toMatchObject({ include: [], autoDetect: false });
  });

  it("uses the hourly default when add explicitly selects interval refresh", async () => {
    const output = await run([
      "source", "add", "Interval docs", "--type", "repo-md", "--refresh", "interval",
      "--allow-caller", "caller-a", "--allow-project", "project-a",
    ]);

    expect(output.stdout).toContain("refresh: every 60m (first sync runs when a server is up — `monet start`)");
    expect(inspect((core) => core.listSources()[0].refresh)).toEqual({
      mode: "interval",
      intervalSeconds: 3600,
    });
  });

  it("keeps explicit manual refresh available", async () => {
    const output = await run([
      "source", "add", "Manual docs", "--type", "repo-md", "--refresh", "manual",
      "--allow-caller", "caller-a", "--allow-project", "project-a",
    ]);

    expect(output.stdout).toContain("refresh: manual (sync only when explicitly requested)");
    expect(inspect((core) => core.listSources()[0].refresh)).toEqual({ mode: "manual" });
  });

  it("preserves update interval reuse and manual-to-interval validation", async () => {
    await run([
      "source", "add", "Project docs", "--type", "repo-md",
      "--refresh", "interval", "--interval-seconds", "1800",
      "--allow-caller", "caller-a", "--allow-project", "project-a",
    ]);
    const created = inspect((core) => core.listSources()[0]);

    await run(["source", "update", created.id, "--refresh", "interval"]);
    expect(inspect((core) => core.getSource(created.id)!.refresh)).toEqual({
      mode: "interval",
      intervalSeconds: 1800,
    });

    await run(["source", "update", created.id, "--refresh", "manual"]);
    await expect(run(["source", "update", created.id, "--refresh", "interval"])).rejects.toEqual(
      expect.objectContaining<Partial<SourceCliError>>({
        message: "--refresh interval requires --interval-seconds",
      }),
    );
  });

  it("derives a repo-md default circle from the resolved custom --path root", async () => {
    const customRoot = join(dir, "shared-docs");
    initGitRepository(customRoot);
    const canonicalCustomRoot = realpathSync.native(customRoot);
    await run([
      "source", "add", "Shared docs",
      "--type", "repo-md",
      "--path", "../shared-docs",
      "--allow-caller", "caller-a",
      "--allow-project", "project-a",
    ]);

    const source = inspect((core) => core.listSources()[0]);
    expect(source.localPath).toBe(canonicalCustomRoot);
    expect(source.circle).toBe("derived-project-circle");
    // P1-2 (Codex round 3 on PR #42): identity=canonicalCustomRoot (the WORKTREE — a genuinely
    // DIFFERENT directory than the invoking project here, via --path), storeDir=projectDir (the
    // invoking project's own store) — the exact divergence this fix exists for: the circle name
    // is resolved from the worktree's own git identity, but consulted against the store
    // createSource actually writes into.
    expect(dependencies.deriveCircle).toHaveBeenCalledWith(canonicalCustomRoot, { storeDir: projectDir });
  });

  it("adds git-md with an explicit transport policy but does not create its allocated path", async () => {
    await run([
      "source", "add", "Remote docs",
      "--type", "git-md",
      "--circle", "shared-docs",
      "--remote", "https://github.com/acme/docs.git",
      "--branch", "main",
      "--allow-scheme", "https",
      "--allow-host", "github.com",
      "--allow-caller", "caller-a",
      "--allow-project", "project-a",
    ]);

    const source = inspect((core) => core.listSources()[0]);
    expect(source).toMatchObject({
      type: "git-md",
      remoteUrl: "https://github.com/acme/docs",
      branch: "main",
      transport: { allowedUrlSchemes: ["https"], allowedHosts: ["github.com"] },
      status: "pending-initial-sync",
    });
    expect(source.localPath).toBe(
      join(realpathSync.native(join(dir, "store")), "sources", "git-md", source.id, "repository.git"),
    );
    expect(existsSync(source.localPath)).toBe(false);
    expect(closeCount).toBe(1);
  });

  it("derives git-md circle from the invocation project when --circle is omitted", async () => {
    await run([
      "source", "add", "Remote docs",
      "--type", "git-md",
      "--remote", "https://github.com/acme/docs.git",
      "--branch", "main",
      "--allow-scheme", "https",
      "--allow-host", "github.com",
      "--allow-caller", "caller-a",
      "--allow-project", "project-a",
    ]);

    const source = inspect((core) => core.listSources()[0]);
    expect(source.circle).toBe("derived-project-circle");
    expect(dependencies.deriveCircle).toHaveBeenCalledWith(projectDir);
  });

  it("lists, shows path-only, and replaces only mutable configuration", async () => {
    await run([
      "source", "add", "Project docs", "--type", "repo-md",
      "--exclude", "vendor/**",
      "--allow-caller", "caller-a", "--allow-project", "project-a",
    ]);
    const created = inspect((core) => core.listSources()[0]);

    const table = await run(["source", "list"]);
    expect(table.stderr).toBe(`store: ${dbPath}\n`);
    expect(table.stdout).toMatch(/^ID\s+NAME\s+TYPE\s+CIRCLE\s+STATUS\s+LOCAL PATH/m);
    expect(table.stdout).toContain("LOCAL PATH");
    expect(table.stdout).toContain(created.id);

    const json = await run(["source", "list", "--json"]);
    expect(json.stderr).toBe(`store: ${dbPath}\n`);
    expect(json.stdout).toBe(`${JSON.stringify([created], null, 2)}\n`);
    expect((await run(["source", "show", created.id, "--path-only"])).stdout)
      .toBe(`${realpathSync.native(projectDir)}\n`);

    await run([
      "source", "update", created.id,
      "--name", "Renamed docs",
      "--include", "handbook/**/*.md",
      "--clear-excludes",
      "--allow-caller", "caller-b",
    ]);
    const updated = inspect((core) => core.getSource(created.id)!);
    expect(updated).toMatchObject({
      name: "Renamed docs",
      include: ["handbook/**/*.md"],
      exclude: [],
      access: { allowedCallerIds: ["caller-b"], allowedProjectIds: ["project-a"] },
      configVersion: 2,
    });
    expect(closeCount).toBe(5);
  });

  it("show prints the server identity alongside the ACLs it must be compared against, but --json and --path-only stay exact", async () => {
    await run([
      "source", "add", "Project docs", "--type", "repo-md",
      "--allow-caller", "caller-a", "--allow-project", "project-a",
    ]);
    const created = inspect((core) => core.listSources()[0]);

    const plain = await run(["source", "show", created.id]);
    expect(plain.stdout).toContain("Server identity: caller test-caller · project test-project-id");
    expect(plain.stdout).toContain("Callers:    caller-a");
    expect(plain.stdout).toContain("Projects:   project-a");
    expect(dependencies.deriveProjectId).toHaveBeenCalledWith(projectDir);

    // Machine-oriented variants keep stdout payload-only; store visibility is on stderr.
    const json = await run(["source", "show", created.id, "--json"]);
    expect(json.stdout).toBe(`${JSON.stringify(created, null, 2)}\n`);
    expect(json.stderr).toBe(`store: ${dbPath}\n`);
    expect(json.stdout).not.toContain("Server identity");

    const pathOnly = await run(["source", "show", created.id, "--path-only"]);
    expect(pathOnly.stdout).toBe(`${realpathSync.native(projectDir)}\n`);
    expect(pathOnly.stderr).toBe(`store: ${dbPath}\n`);
    expect(pathOnly.stdout).not.toContain("Server identity");
  });

  it("rejects empty updates, closes on errors, and tombstones without deleting repo paths", async () => {
    await run([
      "source", "add", "Project docs", "--type", "repo-md",
      "--allow-caller", "caller-a", "--allow-project", "project-a",
    ]);
    const created = inspect((core) => core.listSources()[0]);

    await expect(run(["source", "update", created.id])).rejects.toEqual(
      expect.objectContaining<Partial<SourceCliError>>({ message: "no mutable source fields were provided" }),
    );
    expect(closeCount).toBe(2);

    const output = await run(["source", "remove", created.id, "--yes"]);
    expect(output.stdout).toContain("Status: tombstoned");
    expect(output.stdout).toContain("Local path was not deleted");
    expect(inspect((core) => core.listSources())).toEqual([]);
    expect(inspect((core) => core.listSources({ includeTombstoned: true }))[0].status).toBe("tombstoned");
    expect(() => mkdirSync(projectDir, { recursive: true })).not.toThrow();
    expect(closeCount).toBe(3);
  });
});
