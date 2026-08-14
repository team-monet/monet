import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HashingEmbeddingProvider } from "../embedding";
import { MonetCore } from "../engine";
import {
  BetterSqlitePort,
  StorageExclusiveLockError,
  VerifiedBackupDestinationExistsError,
} from "../storage";

function withTempDir(run: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "monet-verified-backup-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function expectBusy(run: () => unknown): void {
  try {
    run();
    throw new Error("expected SQLITE_BUSY");
  } catch (error) {
    expect((error as { code?: string }).code).toBe("SQLITE_BUSY");
  }
}

describe("BetterSqlitePort.createVerifiedBackup", () => {
  it("includes committed WAL-only data, verifies quick_check, chmods 0600, publishes atomically, and retains ownership", async () => {
    await withTempDir(async (dir) => {
      const sourcePath = join(dir, "source.db");
      const destinationPath = join(dir, "backup.db");
      const port = new BetterSqlitePort(sourcePath);
      port.pragma("wal_autocheckpoint = 0");
      port.exec(`CREATE TABLE proof (value TEXT NOT NULL); PRAGMA wal_checkpoint(TRUNCATE)`);
      port.prepare(`INSERT INTO proof (value) VALUES (?)`).run("committed-only-in-wal");
      expect(statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0);
      const sourceVersionBefore = port.pragma("user_version", { simple: true });

      try {
        const result = await port.createVerifiedBackup(destinationPath);
        expect(result).toEqual({
          sourcePath: resolve(sourcePath),
          path: resolve(destinationPath),
          createdAt: expect.any(Number),
          bytes: statSync(destinationPath).size,
          quickCheck: "ok",
        });
        expect(statSync(destinationPath).mode & 0o777).toBe(0o600);
        expect(readdirSync(dir).filter((name) => name.includes(".partial-"))).toEqual([]);

        const backup = new Database(destinationPath, { readonly: true });
        expect(backup.prepare(`SELECT value FROM proof`).pluck().get()).toBe("committed-only-in-wal");
        expect(backup.pragma("quick_check", { simple: true })).toBe("ok");
        backup.close();

        const observer = new Database(sourcePath);
        observer.pragma("busy_timeout = 50");
        try {
          expectBusy(() => observer.prepare(`SELECT value FROM proof`).all());
        } finally {
          observer.close();
        }
      } finally {
        port.close();
      }
      const source = new Database(sourcePath, { readonly: true });
      expect(source.prepare(`SELECT value FROM proof`).pluck().all()).toEqual(["committed-only-in-wal"]);
      expect(source.pragma("user_version", { simple: true })).toBe(sourceVersionBefore);
      expect(source.pragma("quick_check", { simple: true })).toBe("ok");
      source.close();
    });
  });

  it("refuses a preexisting destination byte-for-byte and releases ownership", async () => {
    await withTempDir(async (dir) => {
      const sourcePath = join(dir, "source.db");
      const destinationPath = join(dir, "existing.db");
      const port = new BetterSqlitePort(sourcePath);
      port.exec(`CREATE TABLE proof (value TEXT)`);
      writeFileSync(destinationPath, "keep me");
      try {
        await expect(port.createVerifiedBackup(destinationPath)).rejects.toBeInstanceOf(
          VerifiedBackupDestinationExistsError,
        );
        expect(readFileSync(destinationPath, "utf8")).toBe("keep me");
        expect(readdirSync(dir).filter((name) => name.includes(".partial-"))).toEqual([]);

        const observer = new Database(sourcePath);
        expect(observer.prepare(`SELECT COUNT(*) FROM proof`).pluck().get()).toBe(0);
        observer.close();
      } finally {
        port.close();
      }
    });
  });

  it("treats a dangling destination symlink as preexisting and never replaces it", async () => {
    await withTempDir(async (dir) => {
      const sourcePath = join(dir, "source.db");
      const destinationPath = join(dir, "dangling.db");
      const port = new BetterSqlitePort(sourcePath);
      port.exec(`CREATE TABLE proof (value TEXT)`);
      symlinkSync(join(dir, "missing-target"), destinationPath);
      try {
        await expect(port.createVerifiedBackup(destinationPath)).rejects.toBeInstanceOf(
          VerifiedBackupDestinationExistsError,
        );
        expect(lstatSync(destinationPath).isSymbolicLink()).toBe(true);
        expect(existsSync(join(dir, "missing-target"))).toBe(false);
      } finally {
        port.close();
      }
    });
  });

  it("preserves a destination that wins the race immediately before atomic publication", async () => {
    await withTempDir(async (dir) => {
      const sourcePath = join(dir, "source.db");
      const destinationPath = join(dir, "raced.db");
      const port = new BetterSqlitePort(sourcePath);
      port.exec(`CREATE TABLE proof (value TEXT)`);
      const publish = (port as any).publishVerifiedBackup.bind(port) as (
        partialPath: string,
        finalPath: string,
      ) => Promise<void>;
      (port as any).publishVerifiedBackup = async (partialPath: string, finalPath: string) => {
        writeFileSync(finalPath, "racing writer wins");
        await publish(partialPath, finalPath);
      };

      try {
        await expect(port.createVerifiedBackup(destinationPath)).rejects.toBeInstanceOf(
          VerifiedBackupDestinationExistsError,
        );
        expect(readFileSync(destinationPath, "utf8")).toBe("racing writer wins");
        expect(readdirSync(dir).filter((name) => name.includes(".partial-"))).toEqual([]);

        const observer = new Database(sourcePath);
        expect(observer.prepare(`SELECT COUNT(*) FROM proof`).pluck().get()).toBe(0);
        observer.close();
      } finally {
        port.close();
      }
    });
  });

  it("deletes only its unique partial and releases ownership when backup fails", async () => {
    await withTempDir(async (dir) => {
      const sourcePath = join(dir, "source.db");
      const destinationPath = join(dir, "backup.db");
      const unrelatedPath = join(dir, ".backup.db.partial-unrelated");
      const port = new BetterSqlitePort(sourcePath);
      port.exec(`CREATE TABLE proof (value TEXT)`);
      writeFileSync(unrelatedPath, "owned elsewhere");
      const native = (port as any).db as Database.Database;
      native.backup = async (partialPath: string) => {
        writeFileSync(partialPath, "incomplete");
        throw new Error("injected backup failure");
      };
      try {
        await expect(port.createVerifiedBackup(destinationPath)).rejects.toThrow("injected backup failure");
        expect(existsSync(destinationPath)).toBe(false);
        expect(readFileSync(unrelatedPath, "utf8")).toBe("owned elsewhere");
        expect(readdirSync(dir).filter((name) => name.includes(".partial-") && name !== ".backup.db.partial-unrelated"))
          .toEqual([]);

        const observer = new Database(sourcePath);
        expect(observer.prepare(`SELECT COUNT(*) FROM proof`).pluck().get()).toBe(0);
        observer.close();
      } finally {
        port.close();
      }
    });
  });

  it("returns a typed lock failure, leaves source state unchanged, creates no destination, and releases ownership", async () => {
    await withTempDir(async (dir) => {
      const sourcePath = join(dir, "source.db");
      const destinationPath = join(dir, "backup.db");
      const port = new BetterSqlitePort(sourcePath);
      port.exec(`CREATE TABLE proof (value TEXT)`);
      port.pragma("busy_timeout = 50");
      const blocker = new Database(sourcePath);
      blocker.exec(`BEGIN IMMEDIATE; INSERT INTO proof VALUES ('uncommitted')`);
      try {
        await expect(port.createVerifiedBackup(destinationPath)).rejects.toBeInstanceOf(StorageExclusiveLockError);
        expect(existsSync(destinationPath)).toBe(false);
        expect(readdirSync(dir).filter((name) => name.includes(".partial-"))).toEqual([]);
      } finally {
        blocker.exec(`ROLLBACK`);
        blocker.close();
      }

      expect((port.prepare(`SELECT COUNT(*) AS count FROM proof`).get() as { count: number }).count).toBe(0);
      const observer = new Database(sourcePath);
      expect(observer.prepare(`SELECT COUNT(*) FROM proof`).pluck().get()).toBe(0);
      observer.close();
      port.close();
    });
  });

  it("does not run MonetCore schema mutation until after a verified backup and accepts the owned port", async () => {
    await withTempDir(async (dir) => {
      const sourcePath = join(dir, "legacy.db");
      const destinationPath = join(dir, "legacy.backup.db");
      const seed = new Database(sourcePath);
      seed.exec(`CREATE TABLE legacy_marker (value TEXT); INSERT INTO legacy_marker VALUES ('before-core')`);
      seed.close();

      const port = new BetterSqlitePort(sourcePath);
      expect(port.prepare(`SELECT name FROM sqlite_schema WHERE name = 'observations'`).get()).toBeUndefined();
      await port.createVerifiedBackup(destinationPath);

      const backup = new Database(destinationPath, { readonly: true });
      expect(backup.prepare(`SELECT name FROM sqlite_schema WHERE name = 'observations'`).get()).toBeUndefined();
      expect(backup.prepare(`SELECT value FROM legacy_marker`).pluck().get()).toBe("before-core");
      backup.close();

      const core = new MonetCore(port, { embedder: new HashingEmbeddingProvider() });
      try {
        expect((core as any).db.prepare(`SELECT name FROM sqlite_schema WHERE name = 'observations'`).get())
          .toEqual({ name: "observations" });
      } finally {
        core.close();
      }
    });
  });
});
