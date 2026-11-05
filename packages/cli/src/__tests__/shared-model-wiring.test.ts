import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openServedCore } from "../bootstrap";

// Everything else in the CLI's tests injects an embedder or asks for the lexical one, so without
// these a serving path that stopped using the host would pass them all while every session loaded
// its own model again.

const fakeHost = vi.hoisted(() => ({
  embed: vi.fn(async () => new Float32Array(1024).fill(0.1)),
  countTokens: vi.fn(async (_spec: unknown, text: string) => text.length),
  inputWindow: vi.fn(async () => 8192),
}));

vi.mock("@team-monet/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@team-monet/core")>()),
  createSharedModelHost: () => fakeHost,
}));

const REPO_ROOT = resolve(import.meta.dirname, "../..");

describe("the serving path and the shared model", () => {
  let dir: string;

  beforeEach(() => {
    // Short and fixed in depth: a socket path must fit, and a temp directory on macOS is too long.
    dir = mkdtempSync(process.platform === "win32" ? join(REPO_ROOT, ".wiring-") : "/tmp/monet-wiring-");
    vi.stubEnv("MONET_EMBEDDER", "");
    fakeHost.embed.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("selects a store's model through the host", async () => {
    const core = await openServedCore(join(dir, "monet.db"), { scopeContext: dir, defaultCircle: "test" });
    expect(fakeHost.embed).toHaveBeenCalled();
    core.close();
  });

  it("swaps to a store's pinned model through the same host", async () => {
    const core = await openServedCore(join(dir, "monet.db"), { scopeContext: dir, defaultCircle: "test" });
    fakeHost.embed.mockClear();
    const swapped = await core["embedderLoader"]("Xenova/bge-m3:cls:q8");
    expect(swapped.modelId).toBe("Xenova/bge-m3:cls:q8");
    expect(fakeHost.embed).toHaveBeenCalled();
    core.close();
  });

  it.skipIf(process.platform === "win32")(
    "a real session that needs the model starts a separate process to hold it",
    async () => {
      const { MONET_EMBEDDER: _ignored, ...env } = process.env;
      // Absolute, because the host starts from the user's home, where a bare `tsx` resolves to nothing.
      const tsx = createRequire(join(REPO_ROOT, "package.json")).resolve("tsx");
      const session = spawn(process.execPath, ["--import", tsx, "src/cli.ts", "start"], {
        cwd: REPO_ROOT,
        stdio: ["pipe", "ignore", "ignore"],
        env: {
          ...env,
          HOME: dir,
          MONET_STORAGE_DIR: join(dir, "store"),
          MONET_MODEL_CACHE: join(dir, "models"),
        },
      });

      const runtimeDir = join(dir, ".monet", "shared-model");
      const hostPid = (): number | null => {
        if (!existsSync(runtimeDir)) return null;
        const file = readdirSync(runtimeDir).find((name) => name.endsWith(".pid"));
        const pid = file ? Number(readFileSync(join(runtimeDir, file), "utf8").trim()) : 0;
        return pid > 0 ? pid : null;
      };

      let pid: number | null = null;
      try {
        const deadline = Date.now() + 60_000;
        while (pid === null && session.exitCode === null && Date.now() < deadline) {
          pid = hostPid();
          if (pid === null) await new Promise((settle) => setTimeout(settle, 100));
        }
        expect(pid, "no process took the model, so this session holds its own copy").not.toBeNull();
        expect(pid).not.toBe(session.pid);
        expect(() => process.kill(pid!, 0)).not.toThrow();
      } finally {
        if (pid !== null) process.kill(pid, "SIGKILL");
        session.kill("SIGKILL");
      }
    },
    90_000,
  );
});
