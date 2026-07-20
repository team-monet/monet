import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  EmbedderMigrationConflictError,
  EmbedderMigrationIncompleteError,
  EmbedderMigrationStartError,
  EmbedderMigrationValidationError,
  MonetCore,
} from "../engine";
import { HashingEmbeddingProvider, type EmbeddingProvider } from "../embedding";
import { BetterSqlitePort, StorageExclusiveLockError, type Statement } from "../storage";
import {
  EmbedderMigrationConflictError as PublicEmbedderMigrationConflictError,
  EmbedderMigrationIncompleteError as PublicEmbedderMigrationIncompleteError,
  EmbedderMigrationStartError as PublicEmbedderMigrationStartError,
  EmbedderMigrationValidationError as PublicEmbedderMigrationValidationError,
  StorageExclusiveLockError as PublicStorageExclusiveLockError,
} from "../index";

const LOCK_REMEDIATION =
  "Cannot start embedder migration: this Monet store is in use and an exclusive lock could not be acquired within 5 seconds. " +
  "Stop every Monet process using this database — MCP servers, CLI commands, dashboards, backup/indexer connections — " +
  "wait for them to exit, then re-run. Do not run `monet status` or `monet source` against this store while migration is active.";

interface MigrationLifecycle {
  beginEmbedderMigration(targetModelId: string): Promise<void>;
  completeEmbedderMigration(): void;
  abortEmbedderMigration(): void;
}

interface MigrationRow {
  target_model_id: string;
  started_at: number;
}

interface PinRow {
  embedder_model_id: string | null;
  embedder_pin_source: string | null;
  embedder_pinned_at: number | null;
}

class TestEmbedder implements EmbeddingProvider {
  readonly modelId?: string;

  constructor(
    modelId: string | null | undefined = "test:model:v2",
    readonly dim = 8,
    private readonly behavior: "ok" | "throw" | "wrong-dim" = "ok",
  ) {
    this.modelId = modelId ?? undefined;
  }

  embed(): Float32Array {
    if (this.behavior === "throw") throw new Error("injected preflight failure");
    return new Float32Array(this.behavior === "wrong-dim" ? this.dim + 1 : this.dim);
  }
}

class InstrumentedMigrationStorage extends BetterSqlitePort {
  readonly completionEvents: string[] = [];
  deleteError?: Error;
  releaseError?: Error;

  override prepare(sql: string): Statement {
    const statement = super.prepare(sql);
    if (!/^\s*DELETE FROM embedder_migration\b/.test(sql)) return statement;
    return {
      run: (...params: unknown[]) => {
        this.completionEvents.push("delete");
        if (this.deleteError) throw this.deleteError;
        return statement.run(...params);
      },
      get: (...params: unknown[]) => statement.get(...params),
      all: (...params: unknown[]) => statement.all(...params),
    };
  }

  override releaseExclusiveOwnership(): void {
    this.completionEvents.push("release");
    if (this.releaseError) throw this.releaseError;
    super.releaseExclusiveOwnership();
  }
}

class OwnershipTrackingStorage extends BetterSqlitePort {
  readonly ownershipEvents: Array<"acquire" | "release"> = [];

  override acquireExclusiveOwnership(): void {
    this.ownershipEvents.push("acquire");
    super.acquireExclusiveOwnership();
  }

  override releaseExclusiveOwnership(): void {
    this.ownershipEvents.push("release");
    super.releaseExclusiveOwnership();
  }
}

function lifecycle(core: MonetCore): MigrationLifecycle {
  return core as unknown as MigrationLifecycle;
}

function readMigration(db: { prepare(sql: string): { get(): unknown } }): MigrationRow | undefined {
  return db.prepare(`SELECT target_model_id, started_at FROM embedder_migration WHERE singleton = 1`).get() as
    | MigrationRow
    | undefined;
}

function readPin(db: { prepare(sql: string): { get(): unknown } }): PinRow {
  return db
    .prepare(`SELECT embedder_model_id, embedder_pin_source, embedder_pinned_at FROM sync_meta WHERE singleton = 1`)
    .get() as PinRow;
}

function expectBusy(run: () => unknown): void {
  try {
    run();
    throw new Error("expected SQLITE_BUSY");
  } catch (error) {
    expect((error as { code?: string }).code).toBe("SQLITE_BUSY");
  }
}

function withTempDb(run: (dbPath: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "monet-embedder-migration-"));
  const dbPath = join(dir, "monet.db");
  return Promise.resolve(run(dbPath)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("embedder migration storage ownership", () => {
  it("keeps in-memory ownership operations idempotent no-ops without affecting ordinary storage", () => {
    const port = new BetterSqlitePort(":memory:");
    try {
      expect(() => port.acquireExclusiveOwnership()).not.toThrow();
      expect(() => port.acquireExclusiveOwnership()).not.toThrow();

      port.exec(`CREATE TABLE ownership_probe (value TEXT NOT NULL)`);
      expect(port.prepare(`INSERT INTO ownership_probe (value) VALUES (?)`).run("usable").changes).toBe(1);
      expect(port.prepare(`SELECT value FROM ownership_probe`).all()).toEqual([{ value: "usable" }]);

      expect(() => port.releaseExclusiveOwnership()).not.toThrow();
      expect(() => port.releaseExclusiveOwnership()).not.toThrow();
    } finally {
      expect(() => port.close()).not.toThrow();
    }
  });

  it("retains a real-file exclusive lock across an awaited tick and release restores raw read/write access", async () => {
    await withTempDb(async (dbPath) => {
      const owner = new BetterSqlitePort(dbPath);
      owner.exec(`CREATE TABLE lock_probe (value TEXT NOT NULL)`);
      const raw = new Database(dbPath);
      raw.pragma("busy_timeout = 50");
      try {
        owner.acquireExclusiveOwnership();
        await new Promise<void>((resolve) => setImmediate(resolve));

        expectBusy(() => raw.prepare(`SELECT * FROM lock_probe`).all());
        expectBusy(() => raw.prepare(`INSERT INTO lock_probe (value) VALUES ('blocked')`).run());

        owner.releaseExclusiveOwnership();
        expect(raw.prepare(`SELECT * FROM lock_probe`).all()).toEqual([]);
        expect(raw.prepare(`INSERT INTO lock_probe (value) VALUES ('restored')`).run().changes).toBe(1);
      } finally {
        raw.close();
        owner.close();
      }
    });
  });

  it("treats verified same-port double acquire as idempotent until one release restores raw access", async () => {
    await withTempDb((dbPath) => {
      const owner = new BetterSqlitePort(dbPath);
      owner.exec(`CREATE TABLE lock_probe (value TEXT NOT NULL)`);
      const raw = new Database(dbPath);
      raw.pragma("busy_timeout = 50");
      try {
        owner.acquireExclusiveOwnership();
        owner.acquireExclusiveOwnership();

        expectBusy(() => raw.prepare(`SELECT * FROM lock_probe`).all());
        expectBusy(() => raw.prepare(`INSERT INTO lock_probe (value) VALUES ('blocked')`).run());

        owner.releaseExclusiveOwnership();
        expect(raw.prepare(`SELECT * FROM lock_probe`).all()).toEqual([]);
        expect(raw.prepare(`INSERT INTO lock_probe (value) VALUES ('restored')`).run().changes).toBe(1);
      } finally {
        raw.close();
        owner.close();
      }
    });
  });

  it("preserves poisoned acquisition evidence until explicit reconciliation, then reacquires a real exclusive lock", async () => {
    await withTempDb((dbPath) => {
      const port = new BetterSqlitePort(dbPath);
      port.exec(`CREATE TABLE lock_probe (value TEXT NOT NULL)`);
      const blocker = new Database(dbPath);
      blocker.pragma("busy_timeout = 50");

      try {
        const originalUserVersion = blocker.pragma("user_version", { simple: true }) as number;
        // A retained WAL EXCLUSIVE lock cannot be established while any other connection is open.
        // Initialize the real port and schema first, then reconnect its raw handle only after the
        // blocker has committed the write that makes its connection-level lock effective.
        ((port as any).db as Database.Database).close();
        blocker.pragma("locking_mode = EXCLUSIVE");
        blocker.pragma(`user_version = ${originalUserVersion + 1}`);
        (port as any).db = new Database(dbPath);
        port.pragma("busy_timeout = 75");

        let poisonedError: unknown;
        try {
          port.acquireExclusiveOwnership();
        } catch (error) {
          poisonedError = error;
        }
        expect(poisonedError).toBeInstanceOf(StorageExclusiveLockError);
        const acquisitionCause = (poisonedError as Error & { cause?: unknown }).cause;
        const cleanupError = (poisonedError as StorageExclusiveLockError).cleanupError;
        expect((acquisitionCause as { code?: string } | undefined)?.code).toBe("SQLITE_BUSY");
        expect((cleanupError as { code?: string } | undefined)?.code).toBe("SQLITE_BUSY");
        expect(cleanupError).not.toBe(acquisitionCause);

        blocker.pragma(`user_version = ${originalUserVersion}`);
        blocker.close();

        let retryError: unknown;
        try {
          port.acquireExclusiveOwnership();
        } catch (error) {
          retryError = error;
        }
        expect(retryError).toBe(poisonedError);

        port.releaseExclusiveOwnership();
        port.acquireExclusiveOwnership();

        const raw = new Database(dbPath);
        raw.pragma("busy_timeout = 50");
        try {
          expectBusy(() => raw.prepare(`SELECT * FROM sqlite_schema`).all());
          expectBusy(() => raw.exec("BEGIN IMMEDIATE"));

          port.releaseExclusiveOwnership();
          expect(raw.prepare(`SELECT * FROM sqlite_schema`).all()).not.toEqual([]);
          raw.exec("BEGIN IMMEDIATE");
          expect(raw.prepare(`INSERT INTO lock_probe (value) VALUES ('restored')`).run().changes).toBe(1);
          raw.exec("COMMIT");
        } finally {
          if (raw.inTransaction) raw.exec("ROLLBACK");
          raw.close();
        }
      } finally {
        try {
          if (blocker.inTransaction) blocker.exec("ROLLBACK");
          blocker.close();
        } finally {
          port.close();
        }
      }
    });
  });

  it("a virgin port on a fresh empty file can acquire and, critically, RELEASE (S6 warm-read regression)", async () => {
    await withTempDb((dbPath) => {
      // Set up the database through a raw connection, then close it.
      // This leaves a file with a test table but no open connections holding state.
      let setup = new Database(dbPath);
      setup.exec(`CREATE TABLE virgin_lock_probe (value TEXT NOT NULL)`);
      setup.close();

      // Now open the owner port on this file. Because no DDL/reads/writes have
      // happened through the port itself, the WAL/shm are still unwarmed (virgin state
      // before the warm-read fix in acquireExclusiveOwnership).
      const owner = new BetterSqlitePort(dbPath);
      const raw = new Database(dbPath);
      raw.pragma("busy_timeout = 50");
      try {
        owner.acquireExclusiveOwnership();

        expectBusy(() => raw.prepare(`SELECT * FROM virgin_lock_probe`).all());
        expectBusy(() => raw.exec("BEGIN IMMEDIATE"));

        owner.releaseExclusiveOwnership();
        expect(raw.prepare(`SELECT * FROM virgin_lock_probe`).all()).toEqual([]);
        raw.exec("BEGIN IMMEDIATE");
        expect(raw.prepare(`INSERT INTO virgin_lock_probe (value) VALUES ('restored')`).run().changes).toBe(1);
        raw.exec("COMMIT");
      } finally {
        if (raw.inTransaction) raw.exec("ROLLBACK");
        raw.close();
        owner.close();
      }
    });
  });

  it("wraps a live-reader acquisition timeout, writes no migration state, and retains no lock", async () => {
    await withTempDb(async (dbPath) => {
      const storage = new BetterSqlitePort(dbPath);
      const core = new MonetCore(storage, { embedder: new TestEmbedder() });
      const beforePin = readPin((core as any).db);
      const competing = new Database(dbPath);
      competing.exec("BEGIN");
      competing.prepare(`SELECT * FROM sync_meta`).all();
      let migrationActive = false;
      try {
        let caught: unknown;
        const startedAt = performance.now();
        try {
          await lifecycle(core).beginEmbedderMigration("test:model:v2");
        } catch (error) {
          caught = error;
        }
        const elapsedMs = performance.now() - startedAt;
        expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
        expect(elapsedMs).toBeLessThan(6_500);
        expect(caught).toBeInstanceOf(EmbedderMigrationStartError);
        expect((caught as Error).message).toBe(LOCK_REMEDIATION);
        expect(readMigration((core as any).db)).toBeUndefined();
        expect(readPin((core as any).db)).toEqual(beforePin);

        competing.exec("ROLLBACK");
        competing.close();
        // WAL EXCLUSIVE is connection-level: an idle but open peer still prevents acquisition.
        // The operator contract requires every process/connection to exit, not merely end a transaction.
        const sharedRaw = new Database(dbPath);
        try {
          expect(sharedRaw.prepare(`SELECT * FROM sync_meta`).all()).toHaveLength(1);
          expect(sharedRaw.prepare(`UPDATE sync_meta SET last_mutation_at = last_mutation_at WHERE singleton = 1`).run().changes).toBe(1);
        } finally {
          sharedRaw.close();
        }

        await lifecycle(core).beginEmbedderMigration("test:model:v2");
        migrationActive = true;
        const blockedRaw = new Database(dbPath);
        blockedRaw.pragma("busy_timeout = 50");
        try {
          expectBusy(() => blockedRaw.prepare(`SELECT * FROM sync_meta`).all());
          expectBusy(() =>
            blockedRaw.prepare(`UPDATE sync_meta SET last_mutation_at = last_mutation_at WHERE singleton = 1`).run(),
          );

          lifecycle(core).abortEmbedderMigration();
          migrationActive = false;
          expect(blockedRaw.prepare(`SELECT * FROM sync_meta`).all()).toHaveLength(1);
          expect(blockedRaw.prepare(`UPDATE sync_meta SET last_mutation_at = last_mutation_at WHERE singleton = 1`).run().changes).toBe(1);
        } finally {
          blockedRaw.close();
        }
      } finally {
        if (competing.inTransaction) competing.exec("ROLLBACK");
        if (migrationActive) lifecycle(core).abortEmbedderMigration();
        competing.close();
        core.close();
      }
    });
  }, 10_000);
});

describe("embedder migration lifecycle", () => {
  it("close preserves the sentinel, releases ownership, and fresh guards prefer incomplete migration", async () => {
    await withTempDb(async (dbPath) => {
      const core = new MonetCore(dbPath, { embedder: new TestEmbedder() });
      await lifecycle(core).beginEmbedderMigration("test:model:v2");
      const migration = readMigration((core as any).db)!;
      expect(readPin((core as any).db).embedder_pin_source).toBe("migrated");

      const raw = new Database(dbPath);
      raw.pragma("busy_timeout = 50");
      try {
        expectBusy(() => readMigration(raw));
        core.close();
        expect(readMigration(raw)).toEqual(migration);
      } finally {
        raw.close();
      }

      const reopened = new MonetCore(dbPath, { embedder: new TestEmbedder() });
      try {
        await expect(reopened.ensureEmbedderPin()).rejects.toMatchObject({
          name: "EmbedderMigrationIncompleteError",
          targetModelId: "test:model:v2",
          startedAt: migration.started_at,
        });
        await expect(reopened.search("must not serve")).rejects.toBeInstanceOf(EmbedderMigrationIncompleteError);
      } finally {
        reopened.close();
      }
    });
  });

  it("resumes the same target, rejects a different target, and abort preserves recovery state", async () => {
    await withTempDb(async (dbPath) => {
      const initial = new MonetCore(dbPath, { embedder: new TestEmbedder("test:model:v2") });
      await lifecycle(initial).beginEmbedderMigration("test:model:v2");
      lifecycle(initial).abortEmbedderMigration();
      const original = readMigration((initial as any).db)!;
      initial.close();

      const conflicting = new MonetCore(dbPath, { embedder: new TestEmbedder("test:model:v3") });
      try {
        await expect(lifecycle(conflicting).beginEmbedderMigration("test:model:v3")).rejects.toMatchObject({
          name: "EmbedderMigrationConflictError",
          requestedTargetModelId: "test:model:v3",
          activeTargetModelId: "test:model:v2",
          startedAt: original.started_at,
        });
        expect(readMigration((conflicting as any).db)).toEqual(original);
      } finally {
        conflicting.close();
      }

      const resumed = new MonetCore(dbPath, { embedder: new TestEmbedder("test:model:v2") });
      try {
        await lifecycle(resumed).beginEmbedderMigration("test:model:v2");
        expect(readMigration((resumed as any).db)).toEqual(original);
        lifecycle(resumed).abortEmbedderMigration();
        expect(readMigration((resumed as any).db)).toEqual(original);
      } finally {
        resumed.close();
      }
    });
  });

  it("complete deletes the sentinel before releasing ownership and a fresh matching core is clean", async () => {
    await withTempDb(async (dbPath) => {
      const storage = new InstrumentedMigrationStorage(dbPath);
      const core = new MonetCore(storage, { embedder: new TestEmbedder() });
      await lifecycle(core).beginEmbedderMigration("test:model:v2");
      lifecycle(core).completeEmbedderMigration();
      expect(storage.completionEvents).toEqual(["delete", "release"]);
      expect(readMigration((core as any).db)).toBeUndefined();
      core.close();

      const reopened = new MonetCore(dbPath, { embedder: new TestEmbedder() });
      try {
        await expect(reopened.ensureEmbedderPin()).resolves.toBeUndefined();
        await expect(reopened.search("safe after completion")).resolves.toEqual([]);
      } finally {
        reopened.close();
      }
    });
  });

  it("complete releases ownership after sentinel deletion fails, preserves recovery state, and rethrows the deletion error", async () => {
    await withTempDb(async (dbPath) => {
      const storage = new InstrumentedMigrationStorage(dbPath);
      const core = new MonetCore(storage, { embedder: new TestEmbedder() });
      await lifecycle(core).beginEmbedderMigration("test:model:v2");
      const migration = readMigration(storage)!;
      const deleteError = new Error("injected sentinel delete failure");
      storage.deleteError = deleteError;

      let caught: unknown;
      try {
        lifecycle(core).completeEmbedderMigration();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(deleteError);
      expect(storage.completionEvents).toEqual(["delete", "release"]);
      expect(readMigration(storage)).toEqual(migration);
      expect((core as any).ownsEmbedderMigrationLock).toBe(false);
      core.close();
    });
  });

  it("complete propagates an ownership release failure after deleting the sentinel", async () => {
    await withTempDb(async (dbPath) => {
      const storage = new InstrumentedMigrationStorage(dbPath);
      const core = new MonetCore(storage, { embedder: new TestEmbedder() });
      await lifecycle(core).beginEmbedderMigration("test:model:v2");
      const releaseError = new Error("injected ownership release failure");
      storage.releaseError = releaseError;

      let caught: unknown;
      try {
        lifecycle(core).completeEmbedderMigration();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(releaseError);
      expect(storage.completionEvents).toEqual(["delete", "release"]);
      expect(readMigration(storage)).toBeUndefined();
      expect((core as any).ownsEmbedderMigrationLock).toBe(true);

      storage.releaseError = undefined;
      core.close();
    });
  });

  it("complete aggregates sentinel deletion and ownership release failures without losing ownership state", async () => {
    await withTempDb(async (dbPath) => {
      const storage = new InstrumentedMigrationStorage(dbPath);
      const core = new MonetCore(storage, { embedder: new TestEmbedder() });
      await lifecycle(core).beginEmbedderMigration("test:model:v2");
      const migration = readMigration(storage)!;
      const deleteError = new Error("injected sentinel delete failure");
      const releaseError = new Error("injected ownership release failure");
      storage.deleteError = deleteError;
      storage.releaseError = releaseError;

      let caught: unknown;
      try {
        lifecycle(core).completeEmbedderMigration();
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toEqual([deleteError, releaseError]);
      expect((caught as Error & { cause?: unknown }).cause).toBe(deleteError);
      expect(storage.completionEvents).toEqual(["delete", "release"]);
      expect(readMigration(storage)).toEqual(migration);
      expect((core as any).ownsEmbedderMigrationLock).toBe(true);

      storage.releaseError = undefined;
      core.close();
    });
  });

  it("a matching target pin with an incomplete sentinel keeps constructor graph backfill pending", async () => {
    await withTempDb(async (dbPath) => {
      const embedder = new HashingEmbeddingProvider(256, 1);
      const seed = new MonetCore(dbPath, {
        embedder,
        graphEnabled: false,
        tauAttach: 1.1,
        tauAmbiguous: 1.1,
      });
      await seed.store("the database migration failed due to a lock timeout", { circle: "c" });
      await seed.store("the schema migration failed because of a connection timeout", { circle: "c" });
      await lifecycle(seed).beginEmbedderMigration(embedder.modelId!);
      lifecycle(seed).abortEmbedderMigration();
      seed.close();

      const raw = new Database(dbPath);
      try {
        expect(raw.pragma("user_version", { simple: true })).toBe(0);
        expect(readMigration(raw)?.target_model_id).toBe(embedder.modelId);
        expect(readPin(raw).embedder_model_id).toBe(embedder.modelId);
      } finally {
        raw.close();
      }

      const reopened = new MonetCore(dbPath, {
        embedder: new HashingEmbeddingProvider(256, 1),
        graphEnabled: true,
        tauAttach: 1.1,
        tauAmbiguous: 1.1,
        edgeSimMin: 0.1,
      });
      try {
        expect((reopened as any).pinUnsatisfied).toBe(true);
        expect((reopened as any).db.pragma("user_version", { simple: true })).toBe(0);
        expect(reopened.edges()).toEqual([]);
        await expect(reopened.ensureEmbedderPin()).rejects.toBeInstanceOf(EmbedderMigrationIncompleteError);
      } finally {
        reopened.close();
      }
    });
  });

  it("creates the sentinel table when opening an old pre-existing store", async () => {
    await withTempDb((dbPath) => {
      const old = new Database(dbPath);
      old.exec(`CREATE TABLE pre_existing (id INTEGER PRIMARY KEY)`);
      old.close();

      const core = new MonetCore(dbPath, { embedder: new TestEmbedder() });
      try {
        const table = (core as any).db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'embedder_migration'`)
          .get() as { name: string } | undefined;
        expect(table?.name).toBe("embedder_migration");
      } finally {
        core.close();
      }
    });
  });

  it("validates a repeated begin before reacquisition and preserves the active same-engine lock", async () => {
    await withTempDb(async (dbPath) => {
      const embedder = new TestEmbedder("test:model:v2");
      const storage = new OwnershipTrackingStorage(dbPath);
      const core = new MonetCore(storage, { embedder });
      let migrationActive = false;
      try {
        await lifecycle(core).beginEmbedderMigration(embedder.modelId!);
        migrationActive = true;
        const eventsAfterFirstBegin = [...storage.ownershipEvents];
        expect(eventsAfterFirstBegin).toEqual(["acquire"]);

        let validationError: unknown;
        try {
          await lifecycle(core).beginEmbedderMigration("test:model:v3");
        } catch (error) {
          validationError = error;
        }
        expect(validationError).toBeInstanceOf(EmbedderMigrationValidationError);
        expect(validationError).toMatchObject({ reason: "target-mismatch" });
        expect(storage.ownershipEvents).toEqual(eventsAfterFirstBegin);

        const raw = new Database(dbPath);
        raw.pragma("busy_timeout = 50");
        try {
          expectBusy(() => raw.prepare(`SELECT * FROM sync_meta`).all());
          expectBusy(() =>
            raw.prepare(`UPDATE sync_meta SET last_mutation_at = last_mutation_at WHERE singleton = 1`).run(),
          );

          lifecycle(core).abortEmbedderMigration();
          migrationActive = false;
          expect(storage.ownershipEvents).toEqual([...eventsAfterFirstBegin, "release"]);
          expect(raw.prepare(`SELECT * FROM sync_meta`).all()).toHaveLength(1);
          expect(raw.prepare(`UPDATE sync_meta SET last_mutation_at = last_mutation_at WHERE singleton = 1`).run().changes).toBe(1);
        } finally {
          raw.close();
        }
      } finally {
        if (migrationActive) lifecycle(core).abortEmbedderMigration();
        core.close();
      }
    });
  });

  it.each([
    {
      name: "empty target",
      embedder: new TestEmbedder("test:model:v2"),
      target: "",
      reason: "empty-target",
    },
    {
      name: "anonymous provider",
      embedder: new TestEmbedder(null),
      target: "test:model:v2",
      reason: "anonymous-provider",
    },
    {
      name: "empty provider model id",
      embedder: new TestEmbedder(""),
      target: "test:model:v2",
      reason: "empty-provider-model-id",
    },
    {
      name: "mismatched target",
      embedder: new TestEmbedder("test:model:v2"),
      target: "test:model:v3",
      reason: "target-mismatch",
    },
    {
      name: "preflight embed failure",
      embedder: new TestEmbedder("test:model:v2", 8, "throw"),
      target: "test:model:v2",
      reason: "preflight-failed",
    },
    {
      name: "preflight dimension mismatch",
      embedder: new TestEmbedder("test:model:v2", 8, "wrong-dim"),
      target: "test:model:v2",
      reason: "preflight-dimension-mismatch",
    },
  ])("$name writes no sentinel or pin and retains no lock", async ({ embedder, target, reason }) => {
    await withTempDb(async (dbPath) => {
      const core = new MonetCore(dbPath, { embedder });
      const beforePin = readPin((core as any).db);
      try {
        await expect(lifecycle(core).beginEmbedderMigration(target)).rejects.toMatchObject({
          name: "EmbedderMigrationValidationError",
          reason,
        });
        expect(readMigration((core as any).db)).toBeUndefined();
        expect(readPin((core as any).db)).toEqual(beforePin);

        const raw = new Database(dbPath);
        raw.pragma("busy_timeout = 100");
        try {
          expect(raw.prepare(`SELECT * FROM sync_meta`).all()).toHaveLength(1);
          expect(raw.prepare(`UPDATE sync_meta SET last_mutation_at = last_mutation_at WHERE singleton = 1`).run().changes).toBe(1);
        } finally {
          raw.close();
        }
      } finally {
        core.close();
      }
    });
  });

  it("exports every public typed migration/storage error through the package index", () => {
    expect(PublicEmbedderMigrationValidationError).toBe(EmbedderMigrationValidationError);
    expect(PublicEmbedderMigrationConflictError).toBe(EmbedderMigrationConflictError);
    expect(PublicEmbedderMigrationIncompleteError).toBe(EmbedderMigrationIncompleteError);
    expect(PublicEmbedderMigrationStartError).toBe(EmbedderMigrationStartError);
    expect(PublicStorageExclusiveLockError).toBe(StorageExclusiveLockError);
  });
});
