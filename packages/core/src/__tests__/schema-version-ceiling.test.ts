import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * A WAL store whose committed version is already in the main file, with the log truncated but the
 * index still beside it. Held open by the caller because that is what leaves the two sidecar shapes
 * #158 records in place: a zero-length `-wal` and a lone `-shm`, both of which the pre-write decision
 * has to read from the header rather than from a peek.
 */
function seedCheckpointedWalStore(dbPath: string, version: number): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma(`user_version = ${version}`);
  db.exec("CREATE TABLE probe (value TEXT)");
  db.prepare("INSERT INTO probe (value) VALUES ('kept')").run();
  db.pragma("wal_checkpoint(TRUNCATE)");
  return db;
}

/** Copy the main file plus the named sidecars into a fresh dir; returns the copy for assertions. */
function copyStoreShape(dbPath: string, suffixes: string[]): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "monet-schema-ceiling-shape-"));
  const copy = join(dir, "monet.db");
  copyFileSync(dbPath, copy);
  for (const suffix of suffixes) copyFileSync(`${dbPath}${suffix}`, `${copy}${suffix}`);
  return { dir, dbPath: copy };
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

  it("reports null (inconclusive) for a file that is not a readable SQLite store", () => {
    withStore((dbPath) => {
      writeFileSync(dbPath, Buffer.from("this is not a SQLite store"));
      expect(readStoredSchemaVersion(dbPath)).toBeNull();
    });
  });

  it("refuses an above-ceiling store behind a held `-journal` without opening it for writing", () => {
    withStore((dbPath) => {
      stampRollbackJournalUserVersion(dbPath, unsupportedSchemaVersion);
      const writer = new Database(dbPath);
      try {
        writer.exec("CREATE TABLE probe (value TEXT)");
        writer.exec("BEGIN IMMEDIATE");
        writer.prepare("INSERT INTO probe (value) VALUES ('uncommitted')").run();
        expect(existsSync(`${dbPath}-journal`)).toBe(true);
        const bytesBefore = readFileSync(dbPath);

        const error = captureOpenError(dbPath);

        expect(error.message).toBe(refusal());
        expect(error.message).not.toMatch(/locked|SQLITE_BUSY|busy/i);
        // P3-a: the decision comes from the file's own header, so a journal-shaped sidecar in the way
        // never turns the decision into an open — the bytes are untouched and the journal is still
        // there for its writer to roll back. Pre-fix this shape was peeks-first, which both mutated
        // the main file and (with a holder) surfaced as startup contention instead of the ceiling.
        expect(readFileSync(dbPath).equals(bytesBefore)).toBe(true);
        expect(existsSync(`${dbPath}-journal`)).toBe(true);
      } finally {
        try {
          writer.exec("ROLLBACK");
        } catch { /* the writer may already have finished */ }
        writer.close();
      }
    });
  });

  it("refuses a lock-held live `-wal` store at the ceiling instead of startup contention", () => {
    withStore((dbPath) => {
      const writer = new Database(dbPath);
      try {
        writer.pragma("journal_mode = WAL");
        writer.pragma(`user_version = ${unsupportedSchemaVersion}`);
        writer.exec("CREATE TABLE probe (value TEXT)");
        writer.exec("BEGIN IMMEDIATE");
        writer.prepare("INSERT INTO probe (value) VALUES ('uncommitted')").run();
        expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

        const error = captureOpenError(dbPath);

        // #158 P2-b / DoD item 2: the elevated version lives in WAL frames and a peer holds the write
        // lock. The refusal must still be the ceiling, not `storeContentionError` — the decision is
        // taken from the log, which readers may open while a writer holds it.
        expect(error.message).toBe(refusal());
        expect(error.message).not.toMatch(/locked|SQLITE_BUSY|busy/i);
      } finally {
        try {
          writer.exec("ROLLBACK");
        } catch { /* the writer may already have finished */ }
        writer.close();
      }
    });
  });

  it("refuses an above-ceiling store whose only sidecar is a leftover `-shm`", () => {
    withStore((dbPath) => {
      const holder = seedCheckpointedWalStore(dbPath, unsupportedSchemaVersion);
      const shape = copyStoreShape(dbPath, ["-shm"]);
      try {
        expect(storeFiles(shape.dbPath)).toEqual(["monet.db", "monet.db-shm"]);
        const bytesBefore = readFileSync(shape.dbPath);

        // Pre-fix this shape was opened: a lone `-shm` makes the readonly peek report 0 on a store
        // whose header says `unsupportedSchemaVersion`, and 0 is not above any ceiling.
        expect(readMainFileHeaderUserVersion(shape.dbPath)).toBe(unsupportedSchemaVersion);
        expect(captureOpenError(shape.dbPath).message).toBe(refusal());
        expect(readFileSync(shape.dbPath).equals(bytesBefore)).toBe(true);
        expect(storeFiles(shape.dbPath)).toEqual(["monet.db", "monet.db-shm"]);
      } finally {
        holder.close();
        rmSync(shape.dir, { recursive: true, force: true });
      }
    });
  });

  it("refuses an above-ceiling store behind a zero-length `-wal` without removing it", () => {
    withStore((dbPath) => {
      const holder = seedCheckpointedWalStore(dbPath, unsupportedSchemaVersion);
      try {
        expect(existsSync(`${dbPath}-wal`)).toBe(true);
        expect(statSync(`${dbPath}-wal`).size).toBe(0);
        const bytesBefore = readFileSync(dbPath);

        expect(captureOpenError(dbPath).message).toBe(refusal());
        expect(readFileSync(dbPath).equals(bytesBefore)).toBe(true);
        // A zero-length log holds no frames, so the header is the whole truth — and reading it does
        // not remove a sidecar the store's writer may still be holding.
        expect(existsSync(`${dbPath}-wal`)).toBe(true);
      } finally {
        holder.close();
      }
    });
  });

  it("decides from WAL frames the header does not show, without opening the store for writing or consuming the log", () => {
    withStore((dbPath) => {
      const holder = seedCheckpointedWalStore(dbPath, MONET_SCHEMA_VERSION);
      try {
        // The ceiling is raised ONLY in the log: the committed header still reads this build's
        // version, so the header alone cannot answer this store. Nothing checkpoints the frame away
        // because this connection stays open for the length of the test.
        holder.prepare(`PRAGMA user_version = ${unsupportedSchemaVersion}`).run();
        const shape = copyStoreShape(dbPath, ["-wal", "-shm"]);
        try {
          expect(readMainFileHeaderUserVersion(shape.dbPath)).toBe(MONET_SCHEMA_VERSION);
          expect(statSync(`${shape.dbPath}-wal`).size).toBeGreaterThan(0);

          // Decided BEFORE anything opens it for writing — the whole point of #158 — and decided from
          // the frames, which a header read cannot see. A lock-held variant of this shape is what the
          // ladder's single retry exists for; it is not unit-pinned, because a WAL writer's frames
          // land at commit and a reader with a valid `-shm` is not blocked by a WAL writer, so the
          // busy moment cannot be constructed on a shape that still has frames to read.
          expect(readStoredSchemaVersion(shape.dbPath)).toBe(unsupportedSchemaVersion);
          expect(captureOpenError(shape.dbPath).message).toBe(refusal());

          // Side effects: the log is still there with its frames, and the header still says what it
          // said. A checkpoint inside the peek, or a header-first fallback, shows up right here.
          expect(statSync(`${shape.dbPath}-wal`).size).toBeGreaterThan(0);
          expect(readMainFileHeaderUserVersion(shape.dbPath)).toBe(MONET_SCHEMA_VERSION);
        } finally {
          rmSync(shape.dir, { recursive: true, force: true });
        }
      } finally {
        holder.close();
      }
    });
  });

  it("refuses an above-ceiling store whose lone zero-length `-wal` has no `-shm` beside it, and creates none", () => {
    withStore((dbPath) => {
      seedCleanlyClosedWalStore(dbPath, unsupportedSchemaVersion);
      // Closed cleanly, so the log was unlinked and only the copy below carries a `-wal`: an empty
      // one, which is the shape a writer leaves when it truncates its log without unlinking it. A
      // peek on this shape answers from a store it also creates a `-shm` in; the header answers from
      // the bytes that are already there.
      const shape = copyStoreShape(dbPath, []);
      writeFileSync(`${shape.dbPath}-wal`, "");
      try {
        expect(storeFiles(shape.dbPath)).toEqual(["monet.db", "monet.db-wal"]);
        expect(readMainFileHeaderUserVersion(shape.dbPath)).toBe(unsupportedSchemaVersion);
        const bytesBefore = readFileSync(shape.dbPath);

        expect(captureOpenError(shape.dbPath).message).toBe(refusal());
        expect(readFileSync(shape.dbPath).equals(bytesBefore)).toBe(true);
        expect(storeFiles(shape.dbPath)).toEqual(["monet.db", "monet.db-wal"]);
      } finally {
        rmSync(shape.dir, { recursive: true, force: true });
      }
    });
  });

  it("refuses through the live re-check when no pre-write decision is available, leaving the caller's port open", () => {
    withStore((dbPath) => {
      stampUserVersion(dbPath, MONET_SCHEMA_VERSION);
      const port = new BetterSqlitePort(dbPath);
      try {
        // A caller-supplied port is the one shape where the constructor cannot read the disk first,
        // so the live re-check is the only check that runs. This port reports the ceiling on that
        // second read — the version moved between the two reads, which is the reason the live check
        // exists at all.
        let reads = 0;
        const flaky = new Proxy(port, {
          get(target, property) {
            if (property === "pragma") {
              return (sql: string, options?: unknown) => {
                if (/user_version/i.test(sql)) {
                  reads += 1;
                  return reads === 1 ? MONET_SCHEMA_VERSION : unsupportedSchemaVersion;
                }
                return (target.pragma as (s: string, o?: unknown) => unknown)(sql, options);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        }) as unknown as BetterSqlitePort;

        expect(captureOpenError(flaky).message).toBe(refusal());
        expect(reads).toBeGreaterThan(1);
        // ONE PORT-OWNERSHIP RULE (#158 P3-b): the refused port is the CALLER's, so the constructor
        // must not close it — a closed better-sqlite3 connection is detectable, and a caller that
        // catches the refusal may still have cleanup to run over the port it handed in.
        expect(port.pragma("user_version", { simple: true })).toBe(MONET_SCHEMA_VERSION);
      } finally {
        port.close();
      }
    });
  });
});
