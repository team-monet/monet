import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MonetCore } from "../engine";
import { MONET_SCHEMA_VERSION } from "../schema-version";
import { BetterSqlitePort, readStoredSchemaVersion } from "../storage";

const unsupportedSchemaVersion = MONET_SCHEMA_VERSION + 1;

function refusal(version = unsupportedSchemaVersion): string {
  return `Store schema ${version} is newer than supported schema ${MONET_SCHEMA_VERSION}; ` +
    `refusing to open. Upgrade Monet first.`;
}

function withStore(run: (dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "monet-schema-ceiling-"));
  try {
    run(join(dir, "monet.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withStoreAsync(run: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "monet-schema-ceiling-"));
  try {
    await run(join(dir, "monet.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stampUserVersion(dbPath: string, version: number): void {
  const db = new Database(dbPath);
  try {
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
  }
}

function stampRollbackJournalUserVersion(dbPath: string, version: number): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = DELETE");
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
  }
}

function seedCleanlyClosedWalStore(dbPath: string, version: number): void {
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
  }
}

function storeFiles(dbPath: string): string[] {
  return readdirSync(dirname(dbPath)).sort();
}

function readState(dbPath: string): { tables: string[]; userVersion: number } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return {
      tables: (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{ name: string }>)
        .map((row) => row.name),
      userVersion: db.pragma("user_version", { simple: true }) as number,
    };
  } finally {
    db.close();
  }
}

function readStateFromMainFileCopy(dbPath: string): { tables: string[]; userVersion: number } {
  const dir = mkdtempSync(join(tmpdir(), "monet-schema-ceiling-copy-"));
  const copyPath = join(dir, "monet.db");
  try {
    copyFileSync(dbPath, copyPath);
    return readState(copyPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readMainFileHeaderUserVersion(dbPath: string): number | null {
  const bytes = readFileSync(dbPath);
  if (bytes.length < 100) return null;
  return bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) ? bytes.readUInt32BE(60) : null;
}

function captureOpenError(db: string | BetterSqlitePort): Error {
  try {
    const core = new MonetCore(db);
    core.close();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`MonetCore threw a non-Error value: ${String(error)}`);
  }
  throw new Error("MonetCore unexpectedly opened an unsupported schema");
}

function spawnExclusiveLockHolder(dbPath: string): ReturnType<typeof spawn> {
  const betterSqlitePath = createRequire(import.meta.url).resolve("better-sqlite3");
  const script = `
const Database = require(process.argv[1]);
const db = new Database(process.argv[2]);
let closed = false;
function finish(exitCode) {
  if (closed) process.exit(exitCode);
  try {
    db.exec("COMMIT");
  } finally {
    closed = true;
    db.close();
  }
  process.exit(exitCode);
}
process.on("SIGTERM", () => finish(0));
try {
  db.exec("BEGIN EXCLUSIVE");
  process.stdout.write("LOCKED\\n");
  setTimeout(() => finish(0), 500);
} catch (error) {
  try {
    db.close();
  } catch {}
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
`;
  return spawn(process.execPath, ["-e", script, betterSqlitePath, dbPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForLock(child: ReturnType<typeof spawn>): Promise<void> {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  let stdout = "";
  let stderr = "";

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onStdout = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("LOCKED\n")) settle(resolve);
    };
    const onStderr = (chunk: string) => {
      stderr += chunk;
    };
    const onError = (error: Error) => settle(() => reject(error));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = stderr.trim() === "" ? "no stderr" : stderr.trim();
      settle(() => reject(new Error(`Lock holder exited before ready (${code ?? signal}): ${detail}`)));
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await waitForExit(child);
}

describe("MonetCore schema-version ceiling", () => {
  it("refuses an empty file store stamped above this build's schema version", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, unsupportedSchemaVersion);

      expect(captureOpenError(dbPath).message).toBe(refusal());
    });
  });

  it("leaves a refused empty store without schema writes or a version change", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, unsupportedSchemaVersion);
      const bytesBefore = readFileSync(dbPath);

      expect(captureOpenError(dbPath).message).toBe(refusal());
      expect(readFileSync(dbPath).equals(bytesBefore)).toBe(true);
      expect(readState(dbPath)).toEqual({
        tables: [],
        userVersion: unsupportedSchemaVersion,
      });
    });
  });

  it("refuses a migrated store that is later stamped above this build's schema version", () => {
    withStore((dbPath) => {
      const seeded = new MonetCore(dbPath);
      seeded.close();
      stampUserVersion(dbPath, unsupportedSchemaVersion);

      expect(captureOpenError(dbPath).message).toBe(refusal());
    });
  });

  it("opens a store stamped exactly at this build's schema version without changing the version", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, MONET_SCHEMA_VERSION);

      const core = new MonetCore(dbPath);
      core.close();

      expect(readState(dbPath).userVersion).toBe(MONET_SCHEMA_VERSION);
    });
  });

  it("reads a cleanly closed WAL store without creating sidecars", () => {
    withStore((dbPath) => {
      seedCleanlyClosedWalStore(dbPath, MONET_SCHEMA_VERSION);
      expect(storeFiles(dbPath)).toEqual(["monet.db"]);

      expect(readStoredSchemaVersion(dbPath)).toBe(MONET_SCHEMA_VERSION);
      expect(storeFiles(dbPath)).toEqual(["monet.db"]);
    });
  });

  it("refuses a cleanly closed WAL store above this build's schema without touching it", () => {
    withStore((dbPath) => {
      seedCleanlyClosedWalStore(dbPath, unsupportedSchemaVersion);
      const bytesBefore = readFileSync(dbPath);

      expect(() => new MonetCore(dbPath)).toThrow(/newer than supported/);
      expect(readFileSync(dbPath).equals(bytesBefore)).toBe(true);
      expect(storeFiles(dbPath)).toEqual(["monet.db"]);
      expect(readStateFromMainFileCopy(dbPath)).toEqual({
        tables: [],
        userVersion: unsupportedSchemaVersion,
      });
    });
  });

  it("refuses a live WAL store whose elevated schema version is still in WAL frames", () => {
    withStore((dbPath) => {
      const writer = new Database(dbPath);
      try {
        writer.pragma("journal_mode = WAL");
        writer.pragma(`user_version = ${unsupportedSchemaVersion}`);
        const mainFileHeaderUserVersion = readMainFileHeaderUserVersion(dbPath);
        // The elevated version lives only in the uncheckpointed WAL frames: a header-only read of
        // the main file would conclude "0, not above this build's ceiling", so the `-wal`/`-shm`
        // branch is load-bearing rather than an optimization. Some SQLite builds may checkpoint the
        // pragma before the writer closes, so the header gap is asserted only when observable.
        if (mainFileHeaderUserVersion !== unsupportedSchemaVersion) {
          expect(mainFileHeaderUserVersion).toBe(0);
        }
        expect(readStoredSchemaVersion(dbPath)).toBe(unsupportedSchemaVersion);

        expect(() => new MonetCore(dbPath)).toThrow(/newer than supported/);
      } finally {
        writer.close();
      }
    });
  });

  it("opens a fresh store and migrates user_version 0 to this build's schema version", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, 0);

      const core = new MonetCore(dbPath);
      core.close();

      expect(readState(dbPath).userVersion).toBe(MONET_SCHEMA_VERSION);
    });
  });

  it("does not mask the schema ceiling as startup contention", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, unsupportedSchemaVersion);

      const error = captureOpenError(dbPath);
      expect(error.message).toContain(refusal());
      expect(error.message).not.toMatch(/locked|SQLITE_BUSY|busy/i);
    });
  });

  it("refuses a lock-held store when the main-file header already shows an unsupported schema", async () => {
    await withStoreAsync(async (dbPath) => {
      stampRollbackJournalUserVersion(dbPath, unsupportedSchemaVersion);
      const lockHolder = spawnExclusiveLockHolder(dbPath);
      try {
        await waitForLock(lockHolder);

        const error = captureOpenError(dbPath);
        expect(error.message).toMatch(/newer than supported schema/);
        expect(error.message).toContain(String(unsupportedSchemaVersion));

        await waitForExit(lockHolder);
        const state = readState(dbPath);
        expect(state.userVersion).toBe(unsupportedSchemaVersion);
        expect(state.tables).toHaveLength(0);
      } finally {
        await stopChild(lockHolder);
      }
    });
  });

  it("applies the same refusal when MonetCore is constructed with a StoragePort", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, unsupportedSchemaVersion);
      const port = new BetterSqlitePort(dbPath);
      try {
        expect(captureOpenError(port).message).toBe(refusal());
      } finally {
        port.close();
      }
    });
  });
});
