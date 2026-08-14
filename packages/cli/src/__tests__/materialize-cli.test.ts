import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { Command } from "commander";
import Database from "better-sqlite3";
import { MonetCore, type SkeletonBody } from "@team-monet/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MaterializeCliError,
  MaterializeDestinationAliasError,
  MaterializeMarkerCollisionError,
  MaterializeRegistryConflictError,
  readMaterializeManifest,
  registerMaterializeCommands,
  renderSkeletonBlock,
  type MaterializeCliDependencies,
  type MaterializeRegistryManifest,
  type MaterializeSkeletonCore,
} from "../materialize-cli";

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type FakeMember = SkeletonBody;

function fakeCore(membersByCircle: Record<string, FakeMember[]> = {}): MaterializeSkeletonCore {
  return {
    skeletonBodies: vi.fn((circle = "default") => membersByCircle[circle] ?? []),
    close: vi.fn(),
  };
}

function member(
  conceptId: string,
  species: "principle" | "preference",
  body: string,
  breadth: "global" | "local",
): FakeMember {
  return { conceptId, species, body, breadth };
}

function fixture(core: MaterializeSkeletonCore = fakeCore()) {
  const root = mkdtempSync(join(tmpdir(), "monet-materialize-"));
  const projectDir = join(root, "project");
  const storeHome = join(root, "store");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(storeHome, { recursive: true });
  fs.writeFileSync(join(storeHome, "monet.db"), "fixture", "utf8");
  const exits: number[] = [];
  const deps: MaterializeCliDependencies = {
    projectDir: () => projectDir,
    storeHome: () => storeHome,
    dbPath: () => join(storeHome, "monet.db"),
    openCore: vi.fn(() => core),
    now: () => Date.parse("2026-08-02T01:02:03.004Z"),
    setExitCode: (code) => exits.push(code),
  };
  return { root, projectDir, storeHome, manifestPath: join(storeHome, "materialize.json"), core, deps, exits };
}

async function run(
  args: string[],
  deps: MaterializeCliDependencies,
): Promise<{ stdout: string; stderr: string; error?: unknown }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => stdout.push(values.map(String).join(" ")));
  const errorLog = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => stderr.push(values.map(String).join(" ")));
  let error: unknown;
  try {
    const program = new Command().name("monet").exitOverride();
    registerMaterializeCommands(program, deps);
    await program.parseAsync(["node", "monet", ...args]);
  } catch (caught) {
    error = caught;
  } finally {
    log.mockRestore();
    errorLog.mockRestore();
  }
  return {
    stdout: stdout.length > 0 ? `${stdout.join("\n")}\n` : "",
    stderr: stderr.length > 0 ? `${stderr.join("\n")}\n` : "",
    ...(error === undefined ? {} : { error }),
  };
}

function writeManifest(filePath: string, manifest: MaterializeRegistryManifest): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function blockFrom(fileText: string): string {
  const start = fileText.indexOf("<!-- BEGIN monet:skeleton");
  const endMarker = "<!-- END monet:skeleton -->";
  const end = fileText.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("test fixture has no skeleton block");
  return fileText.slice(start, end + endMarker.length);
}

describe("materialize CLI", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("registers absolute surfaces, refuses duplicates, enforces exactly one scope, and removes without touching files", async () => {
    const f = fixture();
    roots.push(f.root);
    const surface = join(f.projectDir, "CLAUDE.md");
    fs.writeFileSync(surface, "untouched", "utf8");

    const added = await run(["materialize", "add", "CLAUDE.md", "--global"], f.deps);
    expect(added.error).toBeUndefined();
    expect(readMaterializeManifest(f.manifestPath)).toEqual({
      surfaces: [{ path: surface, scope: "global" }],
      materialized: {},
    });

    const duplicate = await run(["materialize", "add", "CLAUDE.md", "--circle", "project"], f.deps);
    expect(duplicate.error).toBeInstanceOf(MaterializeCliError);
    expect((duplicate.error as Error).message).toContain("already registered");

    for (const invalid of [
      ["materialize", "add", "other.md"],
      ["materialize", "add", "other.md", "--global", "--circle", "project"],
    ]) {
      const result = await run(invalid, f.deps);
      expect(result.error).toBeInstanceOf(MaterializeCliError);
      expect((result.error as Error).message).toContain("exactly one");
    }

    const wildcard = await run(["materialize", "add", "other.md", "--circle", "*"], f.deps);
    expect(wildcard.error).toBeInstanceOf(MaterializeCliError);
    expect((wildcard.error as Error).message).toContain("reserved global-breadth marker");
    expect((wildcard.error as Error).message).toContain("--global");

    for (const markerCircle of ["team<!-- BEGIN monet:skeleton", "team<!-- END monet:skeleton -->"]) {
      const collision = await run(["materialize", "add", "other.md", "--circle", markerCircle], f.deps);
      expect(collision.error).toBeInstanceOf(MaterializeMarkerCollisionError);
      expect((collision.error as Error).message).toContain("marker collision in circle scope");
      expect((collision.error as Error).message).toContain(JSON.stringify(markerCircle));
    }

    const removed = await run(["materialize", "remove", "CLAUDE.md"], f.deps);
    expect(removed.error).toBeUndefined();
    expect(readMaterializeManifest(f.manifestPath)).toEqual({ surfaces: [], materialized: {} });
    expect(fs.readFileSync(surface, "utf8")).toBe("untouched");
  });

  it("refuses a hand-edited wildcard-circle registry row per surface and continues valid rows", async () => {
    const core = fakeCore({ project: [member("p", "principle", "Valid principle.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const wildcard = join(f.root, "wildcard.md");
    const valid = join(f.root, "valid.md");
    writeManifest(f.manifestPath, {
      surfaces: [
        { path: wildcard, scope: { circle: "*" } },
        { path: valid, scope: { circle: "project" } },
      ],
      materialized: {},
    });

    const result = await run(["materialize"], f.deps);
    expect(result.error).toBeUndefined();
    expect(f.exits).toEqual([1]);
    expect(result.stderr).toContain(wildcard);
    expect(result.stderr).toContain("reserved global-breadth marker");
    expect(result.stderr).toContain("--global");
    expect(fs.existsSync(wildcard)).toBe(false);
    expect(fs.readFileSync(valid, "utf8")).toContain("Valid principle.");
    expect(readMaterializeManifest(f.manifestPath).surfaces).toEqual([
      expect.objectContaining({ path: wildcard, scope: { circle: "*" } }),
      { path: valid, scope: { circle: "project" } },
    ]);
  });

  it("refuses a missing-leaf alias at add by canonicalizing its nearest existing ancestor", async () => {
    const f = fixture();
    roots.push(f.root);
    const realParent = join(f.projectDir, "real");
    const aliasParent = join(f.projectDir, "alias");
    fs.mkdirSync(realParent);
    fs.symlinkSync(realParent, aliasParent);
    const real = join(realParent, "new.md");
    const alias = join(aliasParent, "new.md");

    const added = await run(["materialize", "add", real, "--circle", "project"], f.deps);
    expect(added.error).toBeUndefined();
    const refused = await run(["materialize", "add", alias, "--global"], f.deps);

    expect(refused.error).toBeInstanceOf(MaterializeDestinationAliasError);
    expect((refused.error as Error).message).toContain(JSON.stringify(real));
    expect((refused.error as Error).message).toContain(JSON.stringify(alias));
    expect(fs.existsSync(real)).toBe(false);
    expect(readMaterializeManifest(f.manifestPath).surfaces).toEqual([
      { path: real, scope: { circle: "project" } },
    ]);
  });

  it("allows unrelated missing-leaf surfaces to register", async () => {
    const f = fixture();
    roots.push(f.root);
    const first = join(f.projectDir, "one", "new.md");
    const second = join(f.projectDir, "two", "new.md");

    expect((await run(["materialize", "add", first, "--circle", "project"], f.deps)).error).toBeUndefined();
    expect((await run(["materialize", "add", second, "--global"], f.deps)).error).toBeUndefined();
    expect(readMaterializeManifest(f.manifestPath).surfaces.map((surface) => surface.path)).toEqual([first, second]);
  });

  it("refuses a real-path/symlink duplicate at add and names both paths", async () => {
    const f = fixture();
    roots.push(f.root);
    const real = join(f.projectDir, "real.md");
    const alias = join(f.projectDir, "alias.md");
    fs.writeFileSync(real, "Standing text.\n", "utf8");
    fs.symlinkSync(real, alias);

    const added = await run(["materialize", "add", real, "--circle", "project"], f.deps);
    expect(added.error).toBeUndefined();
    const refused = await run(["materialize", "add", alias, "--global"], f.deps);

    expect(refused.error).toBeInstanceOf(MaterializeDestinationAliasError);
    expect((refused.error as Error).message).toContain("same-destination aliases");
    expect((refused.error as Error).message).toContain(JSON.stringify(real));
    expect((refused.error as Error).message).toContain(JSON.stringify(alias));
    expect(readMaterializeManifest(f.manifestPath).surfaces).toEqual([
      { path: real, scope: { circle: "project" } },
    ]);
  });

  it("refuses every missing-leaf alias in a hand-edited registry at run/list and continues an unrelated surface", async () => {
    const core = fakeCore({ project: [member("p", "principle", "Valid principle.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const realParent = join(f.root, "real");
    const aliasParent = join(f.root, "alias");
    fs.mkdirSync(realParent);
    fs.symlinkSync(realParent, aliasParent);
    const real = join(realParent, "new.md");
    const alias = join(aliasParent, "new.md");
    const good = join(f.root, "good.md");
    writeManifest(f.manifestPath, {
      surfaces: [
        { path: real, scope: { circle: "project" } },
        { path: alias, scope: "global" },
        { path: good, scope: { circle: "project" } },
      ],
      materialized: {},
    });

    const result = await run(["materialize"], f.deps);

    expect(result.error).toBeUndefined();
    expect(f.exits).toEqual([1]);
    expect(result.stderr).toContain(JSON.stringify(real));
    expect(result.stderr).toContain(JSON.stringify(alias));
    expect(fs.existsSync(real)).toBe(false);
    expect(fs.readFileSync(good, "utf8")).toContain("Valid principle.");

    f.exits.length = 0;
    const listed = await run(["materialize", "list"], f.deps);
    expect(listed.error).toBeUndefined();
    expect(f.exits).toEqual([1, 1]);
    expect(listed.stderr).toContain(`monet materialize list: ${real}:`);
    expect(listed.stderr).toContain(`monet materialize list: ${alias}:`);
    expect(listed.stdout).toBe(`fresh\tcircle:project\t${good}\n`);
  });

  it("refuses every same-destination alias in a hand-edited registry and continues an unrelated surface", async () => {
    const core = fakeCore({ project: [member("p", "principle", "Valid principle.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const real = join(f.root, "real.md");
    const alias = join(f.root, "alias.md");
    const good = join(f.root, "good.md");
    fs.writeFileSync(real, "Alias target stays untouched.\n", "utf8");
    fs.symlinkSync(real, alias);
    writeManifest(f.manifestPath, {
      surfaces: [
        { path: real, scope: { circle: "project" } },
        { path: alias, scope: "global" },
        { path: good, scope: { circle: "project" } },
      ],
      materialized: {},
    });

    const result = await run(["materialize"], f.deps);

    expect(result.error).toBeUndefined();
    expect(f.exits).toEqual([1]);
    expect(result.stderr).toContain("same-destination aliases");
    expect(result.stderr).toContain(JSON.stringify(real));
    expect(result.stderr).toContain(JSON.stringify(alias));
    expect(fs.readFileSync(real, "utf8")).toBe("Alias target stays untouched.\n");
    expect(fs.readFileSync(good, "utf8")).toContain("Valid principle.");
    const manifest = readMaterializeManifest(f.manifestPath);
    expect(manifest.materialized[real]).toBeUndefined();
    expect(manifest.materialized[alias]).toBeUndefined();
    expect(manifest.materialized[good]).toBeDefined();

    f.exits.length = 0;
    const listed = await run(["materialize", "list"], f.deps);
    expect(listed.error).toBeUndefined();
    expect(f.exits).toEqual([1, 1]);
    expect(listed.stderr).toContain(`monet materialize list: ${real}:`);
    expect(listed.stderr).toContain(`monet materialize list: ${alias}:`);
    expect(listed.stdout).toBe(`fresh\tcircle:project\t${good}\n`);
  });

  it("renders global and circle scopes as disjoint blocks with full bodies in ratification order", async () => {
    const globalPrinciple = member("global-principle", "principle", "Global principle first line.\nGlobal detail stays verbatim.", "global");
    const secondGlobalPrinciple = member("global-principle-2", "principle", "Second global principle.", "global");
    const localPrinciple = member("local-principle", "principle", "Local principle.", "local");
    const globalPreference = member("global-preference", "preference", "Global preference.", "global");
    const localPreference = member("local-preference", "preference", "Local preference.\nSecond line.", "local");
    const core = fakeCore({ project: [globalPrinciple, secondGlobalPrinciple, localPrinciple, globalPreference, localPreference] });
    // A global surface has no circle of its own. Core's skeletonBodies(undefined) uses its default
    // circle, whose union still carries every global member; this fixture mirrors that return shape.
    vi.mocked(core.skeletonBodies).mockImplementation((circle?: string) => circle === "project"
      ? [globalPrinciple, secondGlobalPrinciple, localPrinciple, globalPreference, localPreference]
      : [globalPrinciple, secondGlobalPrinciple, globalPreference]);
    const f = fixture(core);
    roots.push(f.root);
    const globalPath = join(f.root, "global.md");
    const circlePath = join(f.root, "project.md");
    await run(["materialize", "add", globalPath, "--global"], f.deps);
    await run(["materialize", "add", circlePath, "--circle", "project"], f.deps);

    const result = await run(["materialize"], f.deps);
    expect(result.error).toBeUndefined();
    const global = fs.readFileSync(globalPath, "utf8");
    const local = fs.readFileSync(circlePath, "utf8");

    expect(global).toContain("scope=global");
    expect(global).toContain(
      "# Principles\n\nGlobal principle first line.\nGlobal detail stays verbatim.\n\nSecond global principle.",
    );
    expect(global).toContain("# Preferences\n\nGlobal preference.");
    expect(global).not.toContain("Local principle");
    expect(global).not.toContain("Local preference");
    expect(local).toContain("scope=circle:project");
    expect(local).toContain("# Principles\n\nLocal principle.");
    expect(local).toContain("# Preferences\n\nLocal preference.\nSecond line.");
    expect(local).not.toContain("Global principle");
    expect(local).not.toContain("Global preference");
  });

  it("absorbs annotated legacy markers by replacing the whole span", async () => {
    const core = fakeCore({ project: [member("p", "principle", "Replacement principle.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const surface = join(f.root, "legacy.md");
    fs.writeFileSync(
      surface,
      "Before\n<!-- BEGIN monet:skeleton this legacy annotation is intentionally long -->\nOLD\n<!-- END monet:skeleton -->\nAfter",
      "utf8",
    );
    await run(["materialize", "add", surface, "--circle", "project"], f.deps);
    await run(["materialize"], f.deps);

    const text = fs.readFileSync(surface, "utf8");
    expect(text).toMatch(/^Before\n<!-- BEGIN monet:skeleton scope=circle:project /);
    expect(text).toContain("Replacement principle.");
    expect(text).not.toContain("legacy annotation");
    expect(text).not.toContain("OLD");
    expect(text).toMatch(/<!-- END monet:skeleton -->\nAfter$/);
  });

  it("appends with one blank line when markers are absent and creates a missing file as only the block", async () => {
    const core = fakeCore({ project: [member("p", "principle", "Local principle.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const existing = join(f.root, "existing.md");
    const missing = join(f.root, "nested", "missing.md");
    fs.writeFileSync(existing, "Standing text\n\n", "utf8");
    await run(["materialize", "add", existing, "--circle", "project"], f.deps);
    await run(["materialize", "add", missing, "--circle", "project"], f.deps);
    await run(["materialize"], f.deps);

    expect(fs.readFileSync(existing, "utf8")).toMatch(/^Standing text\n\n<!-- BEGIN monet:skeleton/);
    expect(fs.readFileSync(missing, "utf8")).toMatch(/^<!-- BEGIN monet:skeleton/);
    expect(fs.readFileSync(missing, "utf8")).toMatch(/<!-- END monet:skeleton -->$/);
  });

  it("refuses a dangling symlink, preserves it, continues other surfaces, and exits nonzero", async () => {
    const core = fakeCore({ project: [member("p", "principle", "Good principle.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const missingTarget = join(f.root, "missing-target.md");
    const dangling = join(f.root, "dangling.md");
    const good = join(f.root, "good.md");
    fs.symlinkSync(missingTarget, dangling);
    const linkTargetBefore = fs.readlinkSync(dangling);
    await run(["materialize", "add", dangling, "--circle", "project"], f.deps);
    await run(["materialize", "add", good, "--circle", "project"], f.deps);

    const result = await run(["materialize"], f.deps);
    expect(result.error).toBeUndefined();
    expect(f.exits).toEqual([1]);
    expect(result.stderr).toContain(dangling);
    expect(result.stderr).toContain("dangling symbolic link");
    expect(result.stderr).toContain(JSON.stringify(missingTarget));
    expect(fs.lstatSync(dangling).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(dangling)).toBe(linkTargetBefore);
    expect(fs.existsSync(missingTarget)).toBe(false);
    expect(fs.readFileSync(good, "utf8")).toContain("Good principle.");
  });

  it("refuses a marker-bearing scope from a hand-edited registry and continues a sibling", async () => {
    const core = fakeCore({ good: [member("good", "principle", "Good principle.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const poisoned = join(f.root, "poisoned.md");
    const good = join(f.root, "good.md");
    const circle = "poisoned<!-- BEGIN monet:skeleton";
    writeManifest(f.manifestPath, {
      surfaces: [
        { path: poisoned, scope: { circle } },
        { path: good, scope: { circle: "good" } },
      ],
      materialized: {},
    });

    const result = await run(["materialize"], f.deps);

    expect(result.error).toBeUndefined();
    expect(f.exits).toEqual([1]);
    expect(result.stderr).toContain(poisoned);
    expect(result.stderr).toContain("marker collision in circle scope");
    expect(result.stderr).toContain(JSON.stringify(circle));
    expect(fs.existsSync(poisoned)).toBe(false);
    expect(fs.readFileSync(good, "utf8")).toContain("Good principle.");
  });

  it("enforces exactly one marker pair on a synthetic multi-marker render", () => {
    expect(() => renderSkeletonBlock("global", [
      member("synthetic", "principle", "<!-- BEGIN monet:skeleton synthetic -->", "global"),
    ], "2026-08-02T01:02:03.004Z")).toThrowError(MaterializeMarkerCollisionError);
  });

  it.each([
    ["BEGIN", "collision-begin", "Body before <!-- BEGIN monet:skeleton injected --> body after"],
    ["END", "collision-end", "Body before <!-- END monet:skeleton --> body after"],
  ])("refuses a delivered body containing the %s marker before writing and continues a sibling", async (_variant, conceptId, body) => {
    const core = fakeCore({
      poisoned: [member(conceptId, "principle", body, "local")],
      good: [member("good", "principle", "Good principle.", "local")],
    });
    const f = fixture(core);
    roots.push(f.root);
    const poisoned = join(f.root, "poisoned.md");
    const good = join(f.root, "good.md");
    const original = Buffer.from("Hand-written text stays untouched.\n", "utf8");
    fs.writeFileSync(poisoned, original);
    await run(["materialize", "add", poisoned, "--circle", "poisoned"], f.deps);
    await run(["materialize", "add", good, "--circle", "good"], f.deps);

    const result = await run(["materialize"], f.deps);

    expect(result.error).toBeUndefined();
    expect(f.exits).toEqual([1]);
    expect(result.stderr).toContain(poisoned);
    expect(result.stderr).toContain("marker collision");
    expect(result.stderr).toContain(`conceptId ${JSON.stringify(conceptId)}`);
    expect(fs.readFileSync(poisoned)).toEqual(original);
    expect(fs.readFileSync(good, "utf8")).toContain("Good principle.");
    const manifest = readMaterializeManifest(f.manifestPath);
    expect(manifest.materialized[poisoned]).toBeUndefined();
    expect(manifest.materialized[good]).toBeDefined();
  });

  it.each([
    ["begin without end", "Before\n<!-- BEGIN monet:skeleton old -->\nbody"],
    ["reversed", "<!-- END monet:skeleton -->\n<!-- BEGIN monet:skeleton old -->"],
  ])("refuses malformed markers for %s, continues other surfaces, and exits nonzero", async (_name, malformed) => {
    const core = fakeCore({ project: [member("p", "principle", "Good principle.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const bad = join(f.root, "bad.md");
    const good = join(f.root, "good.md");
    fs.writeFileSync(bad, malformed, "utf8");
    await run(["materialize", "add", bad, "--circle", "project"], f.deps);
    await run(["materialize", "add", good, "--circle", "project"], f.deps);

    const result = await run(["materialize"], f.deps);
    expect(result.error).toBeUndefined();
    expect(f.exits).toEqual([1]);
    expect(result.stderr).toContain(bad);
    expect(result.stderr).toContain("malformed monet:skeleton markers");
    expect(fs.readFileSync(bad, "utf8")).toBe(malformed);
    expect(fs.readFileSync(good, "utf8")).toContain("Good principle.");
    const manifest = readMaterializeManifest(f.manifestPath);
    expect(manifest.materialized[bad]).toBeUndefined();
    expect(manifest.materialized[good]).toBeDefined();
  });

  it("refuses a Latin-1 surface as not losslessly decodable, preserves bytes, and continues a sibling", async () => {
    const core = fakeCore({ project: [member("p", "principle", "Rendered principle.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const latin1 = join(f.root, "latin1.md");
    const good = join(f.root, "good.md");
    const original = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x0a]);
    fs.writeFileSync(latin1, original);
    await run(["materialize", "add", latin1, "--circle", "project"], f.deps);
    await run(["materialize", "add", good, "--circle", "project"], f.deps);

    const result = await run(["materialize"], f.deps);

    expect(result.error).toBeUndefined();
    expect(f.exits).toEqual([1]);
    expect(result.stderr).toContain(latin1);
    expect(result.stderr).toContain("not losslessly UTF-8-decodable");
    expect(fs.readFileSync(latin1)).toEqual(original);
    expect(fs.readFileSync(good, "utf8")).toContain("Rendered principle.");
    const manifest = readMaterializeManifest(f.manifestPath);
    expect(manifest.materialized[latin1]).toBeUndefined();
    expect(manifest.materialized[good]).toBeDefined();
  });

  it("refuses a concurrent file edit before rename, preserves it, continues, and exits nonzero", async () => {
    const core = fakeCore({ project: [member("p", "principle", "Rendered principle.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const conflicted = join(f.root, "conflicted.md");
    const good = join(f.root, "good.md");
    fs.writeFileSync(conflicted, "Original hand text.\n", "utf8");
    await run(["materialize", "add", conflicted, "--circle", "project"], f.deps);
    await run(["materialize", "add", good, "--circle", "project"], f.deps);
    let injected = false;
    f.deps.beforeSurfaceWrite = (surfacePath) => {
      if (surfacePath === conflicted && !injected) {
        injected = true;
        fs.writeFileSync(conflicted, "Concurrent hand edit.\n", "utf8");
      }
    };

    const result = await run(["materialize"], f.deps);
    expect(result.error).toBeUndefined();
    expect(f.exits).toEqual([1]);
    expect(result.stderr).toContain(conflicted);
    expect(result.stderr).toContain("changed after it was read");
    expect(result.stderr).toContain("refusing to overwrite concurrent edits");
    expect(fs.readFileSync(conflicted, "utf8")).toBe("Concurrent hand edit.\n");
    expect(fs.readFileSync(good, "utf8")).toContain("Rendered principle.");
    const manifest = readMaterializeManifest(f.manifestPath);
    expect(manifest.materialized[conflicted]).toBeUndefined();
    expect(manifest.materialized[good]).toBeDefined();
  });

  it("refuses a concurrent registry change before rename without reverting it and leaves completed surfaces materialized", async () => {
    const core = fakeCore({ project: [member("p", "principle", "Rendered principle.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const surface = join(f.root, "surface.md");
    const concurrentlyAdded = join(f.root, "concurrent.md");
    await run(["materialize", "add", surface, "--circle", "project"], f.deps);
    f.deps.beforeRegistryWrite = (registryPath) => {
      const concurrent = readMaterializeManifest(registryPath);
      concurrent.surfaces.push({ path: concurrentlyAdded, scope: "global" });
      writeManifest(registryPath, concurrent);
    };

    const result = await run(["materialize"], f.deps);

    expect(result.error).toBeInstanceOf(MaterializeRegistryConflictError);
    expect((result.error as Error).message).toContain("registry conflict");
    expect((result.error as Error).message).toContain("Surfaces already materialized remain materialized");
    expect((result.error as Error).message).toContain("rerun monet materialize");
    expect(fs.readFileSync(surface, "utf8")).toContain("Rendered principle.");
    expect(readMaterializeManifest(f.manifestPath)).toEqual({
      surfaces: [
        { path: surface, scope: { circle: "project" } },
        { path: concurrentlyAdded, scope: "global" },
      ],
      materialized: {},
    });
  });

  it("keeps surface and registry bytes identical across clean reruns with all four guards active", async () => {
    const core = fakeCore({ project: [member("b", "principle", "Stable body.", "local")] });
    const f = fixture(core);
    roots.push(f.root);
    const surface = join(f.root, "stable.md");
    await run(["materialize", "add", surface, "--circle", "project"], f.deps);
    await run(["materialize"], f.deps);
    const firstFile = fs.readFileSync(surface, "utf8");
    const firstRegistry = fs.readFileSync(f.manifestPath);
    const firstState = readMaterializeManifest(f.manifestPath).materialized[surface];

    f.deps.now = () => Date.parse("2026-08-03T09:08:07.006Z");
    await run(["materialize"], f.deps);
    const secondFile = fs.readFileSync(surface, "utf8");
    const secondRegistry = fs.readFileSync(f.manifestPath);
    const secondState = readMaterializeManifest(f.manifestPath).materialized[surface];

    expect(secondFile).toBe(firstFile);
    expect(secondRegistry).toEqual(firstRegistry);
    expect(secondState).toEqual(firstState);
    expect(firstState.blockHash).toBe(hash(firstFile));
    const expectedCanonical = JSON.stringify([{ conceptId: "b", body: "Stable body.", breadth: "local" }]);
    expect(firstState.skeletonState).toBe(hash(expectedCanonical));
  });

  it("reports never-materialized, block-missing, stale, and fresh with the same hashes", async () => {
    const core = fakeCore({
      project: [member("local", "principle", "Local body.", "local")],
    });
    const f = fixture(core);
    roots.push(f.root);
    const never = join(f.root, "never.md");
    const missing = join(f.root, "missing.md");
    const stale = join(f.root, "stale.md");
    const fresh = join(f.root, "fresh.md");
    for (const surface of [never, missing, stale, fresh]) {
      await run(["materialize", "add", surface, "--circle", "project"], f.deps);
    }
    await run(["materialize"], f.deps);
    const manifest = readMaterializeManifest(f.manifestPath);
    delete manifest.materialized[never];
    fs.rmSync(missing);
    fs.writeFileSync(stale, fs.readFileSync(stale, "utf8").replace("Local body.", "Hand edit."), "utf8");
    writeManifest(f.manifestPath, manifest);

    const listed = await run(["materialize", "list"], f.deps);
    expect(listed.error).toBeUndefined();
    expect(listed.stdout).toBe(
      `never-materialized\tcircle:project\t${never}\n` +
      `block-missing\tcircle:project\t${missing}\n` +
      `stale\tcircle:project\t${stale}\n` +
      `fresh\tcircle:project\t${fresh}\n`,
    );
    expect(listed.stderr).toBe(`store: ${f.deps.dbPath()}\n`);
  });

  it("lists never-materialized surfaces without opening or requiring the store", async () => {
    const f = fixture();
    roots.push(f.root);
    const surface = join(f.root, "never.md");
    await run(["materialize", "add", surface, "--circle", "project"], f.deps);
    fs.rmSync(f.deps.dbPath());

    const result = await run(["materialize", "list"], f.deps);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe(`never-materialized\tcircle:project\t${surface}\n`);
    expect(result.stderr).toBe("");
    expect(f.deps.openCore).not.toHaveBeenCalled();
    expect(fs.existsSync(f.deps.dbPath())).toBe(false);
  });

  it("does not create a fresh store when a registered surface needs materialization", async () => {
    const f = fixture();
    roots.push(f.root);
    const surface = join(f.root, "surface.md");
    await run(["materialize", "add", surface, "--circle", "project"], f.deps);
    fs.rmSync(f.deps.dbPath());

    const result = await run(["materialize"], f.deps);
    expect(result.error).toBeInstanceOf(MaterializeCliError);
    expect((result.error as Error).message).toContain(`store is not a readable database file: ${f.deps.dbPath()}`);
    expect(f.deps.openCore).not.toHaveBeenCalled();
    expect(fs.existsSync(f.deps.dbPath())).toBe(false);
    expect(fs.existsSync(surface)).toBe(false);
  });

  it("renders an empty scope as markers only", async () => {
    const f = fixture(fakeCore({ empty: [] }));
    roots.push(f.root);
    const surface = join(f.root, "empty.md");
    await run(["materialize", "add", surface, "--circle", "empty"], f.deps);
    await run(["materialize"], f.deps);
    expect(fs.readFileSync(surface, "utf8")).toMatch(
      /^<!-- BEGIN monet:skeleton scope=circle:empty state=[0-9a-f]{64} generated=2026-08-02T01:02:03\.004Z -->\n<!-- END monet:skeleton -->$/,
    );
  });

  it("uses skeletonBodies without changing usefulness while rendering a real mixed store", async () => {
    const f = fixture();
    roots.push(f.root);
    fs.rmSync(f.deps.dbPath());
    const seed = new MonetCore(f.deps.dbPath(), { defaultCircle: "project" });
    await seed.declare({
      species: "principle",
      content: "A full global real-store principle.\nIts body remains intact.",
      circle: "*",
    });
    await seed.declare({ species: "preference", content: "A local real-store preference." });
    seed.close();
    const raw = new Database(f.deps.dbPath(), { readonly: true, fileMustExist: true });
    const beforeUsefulness = raw.prepare(
      `SELECT id, usefulness_score, usefulness_last_fetched_at FROM concepts
       WHERE kind IN ('principle', 'preference') ORDER BY id`,
    ).all();
    raw.close();
    f.deps.openCore = (dbPath) => new MonetCore(dbPath, { defaultCircle: "project", deferCreatedPin: true });
    const globalSurface = join(f.root, "global-real.md");
    const localSurface = join(f.root, "local-real.md");
    await run(["materialize", "add", globalSurface, "--global"], f.deps);
    await run(["materialize", "add", localSurface, "--circle", "project"], f.deps);
    const result = await run(["materialize"], f.deps);

    expect(result.error).toBeUndefined();
    const globalText = fs.readFileSync(globalSurface, "utf8");
    const localText = fs.readFileSync(localSurface, "utf8");
    expect(globalText).toContain("A full global real-store principle.\nIts body remains intact.");
    expect(globalText).not.toContain("local real-store preference");
    expect(localText).toContain("A local real-store preference.");
    expect(localText).not.toContain("global real-store principle");
    const manifest = readMaterializeManifest(f.manifestPath);
    expect(manifest.materialized[globalSurface].blockHash).toBe(hash(blockFrom(globalText)));
    expect(manifest.materialized[localSurface].blockHash).toBe(hash(blockFrom(localText)));
    const rawAfter = new Database(f.deps.dbPath(), { readonly: true, fileMustExist: true });
    const afterUsefulness = rawAfter.prepare(
      `SELECT id, usefulness_score, usefulness_last_fetched_at FROM concepts
       WHERE kind IN ('principle', 'preference') ORDER BY id`,
    ).all();
    rawAfter.close();
    expect(afterUsefulness).toEqual(beforeUsefulness);
  });
});
