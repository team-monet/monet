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
});
