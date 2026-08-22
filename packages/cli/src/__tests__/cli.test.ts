import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MonetCore, deriveCircle as coreDeriveCircle } from "@team-monet/core";
import { afterEach, describe, expect, it } from "vitest";

// Needed for the two P1-B/P2-D divergence tests below, which spawn with `cwd` OUTSIDE this repo —
// a bare "tsx" specifier only resolves when cwd IS the repo root (see gate-cli.test.ts's own
// TSX_LOADER comment for the full ERR_MODULE_NOT_FOUND story); an absolute path sidesteps that.
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI_ENTRY = join(REPO_ROOT, "src/cli.ts");
const TSX_LOADER = join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs");

describe("CLI usage errors", () => {
  it.each(["status"])("names the %s subcommand", (command) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", command, "--bogus"],
      { cwd: REPO_ROOT, encoding: "utf8", env: process.env },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`monet ${command}: unknown option '--bogus'\n`);
  });
});

describe("CLI store visibility", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("prints the resolved store on stderr for status", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "monet-status-cli-"));
    dirs.push(storageDir);

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "status"],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        env: { ...process.env, MONET_STORAGE_DIR: storageDir },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe(`store: ${join(storageDir, "monet.db")}\n`);
    expect(result.stdout.split("\n", 1)[0]).toBe("Monet Status");
  });

  it("exposes doctor and repair help through the real CLI process", () => {
    for (const command of ["doctor", "repair"]) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", command, "--help"],
        { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", env: process.env },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Usage: monet ${command} [options]`);
    }
  });

  it("returns exit 2 and pure JSON for a missing-store doctor run", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "monet-doctor-cli-"));
    dirs.push(storageDir);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "doctor", "--dir", storageDir, "--json"],
      { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", env: process.env },
    );

    expect(result.status).toBe(2);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "monet.recovery.v1",
      command: "doctor",
      ok: false,
      assessment: "missing",
      provider: { loadStatus: "not-checked" },
    });
    expect(result.stderr).toBe(`store: ${join(storageDir, "monet.db")}\n`);
  });

  it("returns exit 1 and a JSON error for invalid noninteractive repair grammar", () => {
    const storageDir = mkdtempSync(join(tmpdir(), "monet-repair-cli-"));
    dirs.push(storageDir);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "repair", "--target", "hashing", "--apply", "--dir", storageDir, "--json"],
      { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", env: process.env },
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "monet.recovery.v1",
      command: "repair",
      ok: false,
      error: { message: expect.stringContaining("--apply requires --yes") },
    });
  });

  it("P1-B/P2-D (Codex round 4 on PR #42): status roots at MONET_PROJECT_DIR, not cwd, when they diverge", () => {
    const projectA = mkdtempSync(join(tmpdir(), "monet-status-a-"));
    const cwdB = mkdtempSync(join(tmpdir(), "monet-status-b-"));
    const isolatedHome = mkdtempSync(join(tmpdir(), "monet-status-home-"));
    dirs.push(projectA, cwdB, isolatedHome);
    // Pre-create A's .monet so getMonetDir's rung-2 existsSync check finds it directly (db/index.ts:
    // rung 2 requires the dir to ALREADY exist, else it falls through to the HOME rung). Without
    // this, BOTH the correct (A-rooted) and buggy (cwd-rooted) resolutions would fall through to
    // the SAME isolated-HOME fallback — neither A nor cwdB would have a pre-existing .monet — and
    // this test could not distinguish the two at all.
    mkdirSync(join(projectA, ".monet"), { recursive: true });

    const result = spawnSync(
      process.execPath,
      ["--import", TSX_LOADER, CLI_ENTRY, "status"],
      {
        cwd: cwdB,
        encoding: "utf8",
        // HOME isolated and MONET_STORAGE_DIR explicitly blanked (never just inherited via
        // ...process.env) on every spawn this round — an un-isolated spawn here would either
        // touch the real ~/.monet or silently mask the very divergence this test exists to prove,
        // if the outer test-runner process happens to have either var set.
        env: { ...process.env, MONET_PROJECT_DIR: projectA, HOME: isolatedHome, MONET_STORAGE_DIR: "" },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe(`store: ${join(projectA, ".monet", "monet.db")}\n`);
    expect(result.stdout).toContain(`Storage:       ${join(projectA, ".monet", "monet.db")}`);
    expect(existsSync(join(cwdB, ".monet"))).toBe(false); // cwd's own store was never touched
  });

});
