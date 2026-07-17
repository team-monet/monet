import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<string> {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      lines.push(values.map(String).join(" "));
    });
    const program = new Command().name("monet");
    registerSourceCommands(program, dependencies);
    try {
      await program.parseAsync(["node", "monet", ...args]);
      return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    } finally {
      log.mockRestore();
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

    expect(output).toContain("Status: pending-initial-sync");
    expect(output).toContain(`Local path: ${canonicalProjectDir}`);
    expect(output).toContain("Content sync: not run");
    expect(output).toContain("Server identity: caller test-caller · project test-project-id");
    const source = inspect((core) => core.listSources()[0]);
    expect(source).toMatchObject({
      type: "repo-md",
      name: "Project docs",
      circle: "derived-project-circle",
      localPath: canonicalProjectDir,
      access: { allowedCallerIds: ["caller-a"], allowedProjectIds: ["project-a"] },
      include: ["README.md", "docs/**/*.md"],
    });
    expect(dependencies.deriveCircle).toHaveBeenCalledWith(canonicalProjectDir);
    // The server identity is derived from the INVOCATION project dir (dependencies.projectDir()),
    // not the repo-md source's own root — those two can differ (e.g. a custom --path).
    expect(dependencies.deriveProjectId).toHaveBeenCalledWith(projectDir);
    expect(closeCount).toBe(1);
  });

  it("derives a repo-md default circle from the resolved custom --path root", async () => {
    const customRoot = join(dir, "shared-docs");
    mkdirSync(customRoot);
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
    expect(dependencies.deriveCircle).toHaveBeenCalledWith(canonicalCustomRoot);
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
    expect(table).toMatch(/^ID\s+NAME\s+TYPE\s+CIRCLE\s+STATUS\s+LOCAL PATH/m);
    expect(table).toContain("LOCAL PATH");
    expect(table).toContain(created.id);

    const json = await run(["source", "list", "--json"]);
    expect(json).toBe(`${JSON.stringify([created], null, 2)}\n`);
    expect(await run(["source", "show", created.id, "--path-only"])).toBe(`${realpathSync.native(projectDir)}\n`);

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
    expect(plain).toContain("Server identity: caller test-caller · project test-project-id");
    expect(plain).toContain("Callers:    caller-a");
    expect(plain).toContain("Projects:   project-a");
    expect(dependencies.deriveProjectId).toHaveBeenCalledWith(projectDir);

    // --json is a documented "stable JSON" contract (see README) — must stay exactly the
    // KnowledgeSource object, with no identity line mixed in.
    const json = await run(["source", "show", created.id, "--json"]);
    expect(json).toBe(`${JSON.stringify(created, null, 2)}\n`);
    expect(json).not.toContain("Server identity");

    // --path-only is documented to print exactly the absolute local path — same guarantee.
    const pathOnly = await run(["source", "show", created.id, "--path-only"]);
    expect(pathOnly).toBe(`${realpathSync.native(projectDir)}\n`);
    expect(pathOnly).not.toContain("Server identity");
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
    expect(output).toContain("Status: tombstoned");
    expect(output).toContain("Local path was not deleted");
    expect(inspect((core) => core.listSources())).toEqual([]);
    expect(inspect((core) => core.listSources({ includeTombstoned: true }))[0].status).toBe("tombstoned");
    expect(() => mkdirSync(projectDir, { recursive: true })).not.toThrow();
    expect(closeCount).toBe(3);
  });
});
