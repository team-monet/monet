import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
});
