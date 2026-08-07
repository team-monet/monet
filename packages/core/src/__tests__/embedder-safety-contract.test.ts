import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  EmbedderIdentityRequiredError,
  EmbedderMigrationReentryError,
  EmbedderOutputDimensionError,
  EmbedderOutputNonFiniteError,
  EmbedderPinUnsatisfiedError,
  EmbedderRepairOwnershipError,
  EmbedderWidthConflictError,
  MonetCore,
} from "../engine";
import type { EmbeddingProvider } from "../embedding";
import { BetterSqlitePort } from "../storage";
import type { StoragePort } from "../storage";

class SwitchableProvider implements EmbeddingProvider {
  readonly dim = 4;
  readonly modelId = "test:safety:dim=4";
  malformed: "none" | "wrong-width" | "wrong-type" | "nonfinite" = "none";

  embed(): Float32Array {
    if (this.malformed === "wrong-width") return new Float32Array(3);
    if (this.malformed === "wrong-type") return [1, 0, 0, 0] as unknown as Float32Array;
    if (this.malformed === "nonfinite") return new Float32Array([1, Number.NaN, 0, 0]);
    return new Float32Array([1, 0, 0, 0]);
  }
}

function dbOf(core: MonetCore): any {
  return (core as any).db;
}

function insertExternalObservation(db: Database.Database, id: string, width: number): void {
  db.prepare(
    `INSERT INTO observations (id, content, embedding, author_agent_id, kind) VALUES (?, ?, ?, 'external', 'statement')`,
  ).run(id, id, JSON.stringify(new Array(width).fill(0.25)));
}

describe("embedder safety contract — checked reads and stable identity", () => {
  it("rejects malformed search query outputs before native or source-backed scoring", async () => {
    const provider = new SwitchableProvider();
    const core = new MonetCore(":memory:", { embedder: provider });
    try {
      await core.store("native scoring row", { resolution: "forceNew" });
      await core.storeSource("source scoring row", { sourceRefs: ["source://safety/docs.md#row~1"] });

      provider.malformed = "wrong-width";
      await expect(core.search("query")).rejects.toBeInstanceOf(EmbedderOutputDimensionError);
      provider.malformed = "wrong-type";
      await expect(core.search("query")).rejects.toBeInstanceOf(EmbedderOutputDimensionError);
    } finally {
      core.close();
    }
  });

  it("rejects non-finite provider output across ordinary writes and reads without persisting JSON null", async () => {
    const provider = new SwitchableProvider();
    const core = new MonetCore(":memory:", { embedder: provider });
    try {
      const stored = await core.store("finite seed", { resolution: "forceNew" });
      const before = JSON.stringify({
        concepts: dbOf(core).prepare(`SELECT * FROM concepts ORDER BY id`).all(),
        observations: dbOf(core).prepare(`SELECT * FROM observations ORDER BY id`).all(),
      });
      provider.malformed = "nonfinite";
      await expect(core.store("nonfinite native")).rejects.toBeInstanceOf(EmbedderOutputNonFiniteError);
      await expect(core.storeSource("nonfinite source", { sourceRefs: ["source://nonfinite/a"] })).rejects.toBeInstanceOf(EmbedderOutputNonFiniteError);
      await expect(core.search("nonfinite query")).rejects.toBeInstanceOf(EmbedderOutputNonFiniteError);
      expect(JSON.stringify({
        concepts: dbOf(core).prepare(`SELECT * FROM concepts ORDER BY id`).all(),
        observations: dbOf(core).prepare(`SELECT * FROM observations ORDER BY id`).all(),
      })).toBe(before);
      expect(dbOf(core).prepare(`SELECT embedding FROM concepts WHERE id=?`).get(stored.conceptId).embedding).not.toContain("null");
    } finally {
      core.close();
    }
  });

  it("rejects a matching-pin startup probe whose runtime width is wrong", async () => {
    const provider = new SwitchableProvider();
    provider.malformed = "wrong-width";
    const core = new MonetCore(":memory:", { embedder: provider });
    try {
      let caught: unknown;
      try { await core.ensureEmbedderPin(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).cause).toBeInstanceOf(EmbedderOutputDimensionError);
      await expect(core.search("still poisoned")).rejects.toBeInstanceOf(EmbedderPinUnsatisfiedError);
    } finally {
      core.close();
    }
  });

  it("preserves the typed non-finite cause through pin satisfaction", async () => {
    const provider = new SwitchableProvider();
    provider.malformed = "nonfinite";
    const core = new MonetCore(":memory:", { embedder: provider });
    try {
      let caught: unknown;
      try { await core.ensureEmbedderPin(); } catch (error) { caught = error; }
      expect((caught as Error).cause).toBeInstanceOf(EmbedderOutputNonFiniteError);
    } finally {
      core.close();
    }
  });

  it("rejects anonymous first writes repeatedly without semantic, session, or pin mutation, and rejects adopt", async () => {
    const anonymous: EmbeddingProvider = { dim: 4, embed: () => new Float32Array(4) };
    const core = new MonetCore(":memory:", { embedder: anonymous });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(core.store(`anonymous-${attempt}`)).rejects.toBeInstanceOf(EmbedderIdentityRequiredError);
      }
      expect(dbOf(core).prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(0);
      expect(dbOf(core).prepare(`SELECT COUNT(*) AS n FROM concepts`).get().n).toBe(0);
      expect(dbOf(core).prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n).toBe(0);
      expect(dbOf(core).prepare(`SELECT embedder_model_id FROM sync_meta WHERE singleton=1`).get().embedder_model_id).toBeNull();
      expect(() => core.adoptEmbedderPin()).toThrow(EmbedderIdentityRequiredError);
      await expect(core.search("vector-free read")).resolves.toEqual([]);
    } finally {
      core.close();
    }
  });
});

describe("embedder safety contract — graft validation", () => {
  it.each(["all-wrong", "mixed"] as const)("rejects an empty pinned receiver's %s incoming widths atomically", async (shape) => {
    const sender = new MonetCore(":memory:", { embedder: new SwitchableProvider() });
    const receiver = new MonetCore(":memory:", { embedder: new SwitchableProvider() });
    try {
      await sender.store("payload row", { resolution: "forceNew" });
      const payload = sender.exportDelta(0);
      for (const row of payload.concepts) row.embedding = JSON.stringify(new Array(shape === "all-wrong" ? 3 : 4).fill(0.1));
      for (const row of payload.observations) row.embedding = JSON.stringify(new Array(3).fill(0.1));

      expect(() => receiver.graftRows(payload)).toThrow(EmbedderWidthConflictError);
      expect(dbOf(receiver).prepare(`SELECT COUNT(*) AS n FROM concepts`).get().n).toBe(0);
      expect(dbOf(receiver).prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(0);
    } finally {
      sender.close();
      receiver.close();
    }
  });
});

describe("embedder safety contract — cache receipts", () => {
  it("supports a pre-hook StoragePort adapter and treats a throwing optional hook as cache-only failure", async () => {
    for (const mode of ["absent", "throwing"] as const) {
      const inner = new BetterSqlitePort(":memory:");
      const legacy: StoragePort = {
        prepare: (sql) => inner.prepare(sql),
        exec: (sql) => inner.exec(sql),
        pragma: (source, options) => inner.pragma(source, options),
        transaction: (fn) => inner.transaction(fn),
        immediateTransaction: (fn) => inner.immediateTransaction(fn),
        acquireExclusiveOwnership: () => inner.acquireExclusiveOwnership(),
        releaseExclusiveOwnership: () => inner.releaseExclusiveOwnership(),
        close: () => inner.close(),
        ...(mode === "throwing" ? { inTransaction: () => { throw new Error("optional hook failed"); } } : {}),
      };
      const core = new MonetCore(legacy, { embedder: new SwitchableProvider(), graphEnabled: false });
      await expect(core.store(`committed-${mode}`, { resolution: "forceNew" })).resolves.toBeTruthy();
      expect(inner.prepare(`SELECT COUNT(*) AS n FROM concepts`).get()).toEqual({ n: 1 });
      expect((core as any).embeddingWidthProof).toBeUndefined();
      core.close();
    }
  });

  it("invalidates a commit-to-receipt token when an external commit lands in that exact window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-width-receipt-"));
    const path = join(dir, "monet.db");
    const port = new BetterSqlitePort(path);
    const core = new MonetCore(port, { embedder: new SwitchableProvider(), graphEnabled: false });
    const external = new Database(path);
    try {
      await core.store("first", { resolution: "forceNew" });
      expect((core as any).embeddingWidthProof).toBeDefined();
      const original = port.immediateTransaction.bind(port);
      let inject = true;
      port.immediateTransaction = ((fn: (...args: any[]) => any) => (...args: any[]) => {
        const result = original(fn)(...args);
        if (inject) {
          inject = false;
          insertExternalObservation(external, "external-window", 6);
        }
        return result;
      }) as typeof port.immediateTransaction;

      await core.store("second", { resolution: "forceNew" });
      expect((core as any).embeddingWidthProof).toBeUndefined();
      await expect(core.store("third", { resolution: "forceNew" })).rejects.toBeInstanceOf(EmbedderWidthConflictError);
    } finally {
      external.close();
      core.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never installs a rolled-back receipt and rescans successfully on retry", async () => {
    const port = new BetterSqlitePort(":memory:");
    const core = new MonetCore(port, { embedder: new SwitchableProvider(), graphEnabled: false });
    try {
      await core.store("first", { resolution: "forceNew" });
      const priorProof = (core as any).embeddingWidthProof;
      const original = port.immediateTransaction.bind(port);
      port.immediateTransaction = ((fn: (...args: any[]) => any) => original((...args: any[]) => {
        fn(...args);
        throw new Error("rollback after mutation");
      })) as typeof port.immediateTransaction;
      await expect(core.store("rolled back", { resolution: "forceNew" })).rejects.toThrow("rollback after mutation");
      expect((core as any).embeddingWidthProof).toBe(priorProof);
      port.immediateTransaction = original;
      await expect(core.store("retry", { resolution: "forceNew" })).resolves.toBeTruthy();
      expect(dbOf(core).prepare(`SELECT COUNT(*) AS n FROM observations`).get().n).toBe(2);
    } finally {
      core.close();
    }
  });

  it("rescans external commits both before validation and after an installed receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-width-external-"));
    const path = join(dir, "monet.db");
    const port = new BetterSqlitePort(path);
    const core = new MonetCore(port, { embedder: new SwitchableProvider(), graphEnabled: false });
    const external = new Database(path);
    try {
      await core.store("first", { resolution: "forceNew" });
      insertExternalObservation(external, "external-after", 6);
      await expect(core.store("after receipt", { resolution: "forceNew" })).rejects.toBeInstanceOf(EmbedderWidthConflictError);

      external.prepare(`DELETE FROM observations WHERE id='external-after'`).run();
      await core.store("proof refreshed", { resolution: "forceNew" });
      const original = port.immediateTransaction.bind(port);
      let inject = true;
      port.immediateTransaction = ((fn: (...args: any[]) => any) => (...args: any[]) => {
        if (inject) {
          inject = false;
          insertExternalObservation(external, "external-before", 6);
        }
        return original(fn)(...args);
      }) as typeof port.immediateTransaction;
      await expect(core.store("before validation", { resolution: "forceNew" })).rejects.toBeInstanceOf(EmbedderWidthConflictError);
    } finally {
      external.close();
      core.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("embedder safety contract — migration reentry and completion", () => {
  it("blocks progress-callback and provider reentry, including queued mutation and public repair helpers", async () => {
    const old = new SwitchableProvider();
    const core = new MonetCore(":memory:", { embedder: old, graphEnabled: false });
    const stored = await core.store("migration body", { resolution: "forceNew" });
    const errors: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    let providerReentered = false;
    const target: EmbeddingProvider = {
      dim: 4,
      modelId: "test:safety:target",
      embed(text: string): Float32Array {
        if (!providerReentered && !text.includes("preflight")) {
          providerReentered = true;
          try { core.retireConcept(stored.conceptId); } catch (error) { errors.push(error); }
          pending.push(core.store("provider reentry").catch((error) => errors.push(error)));
        }
        return new Float32Array([0, 1, 0, 0]);
      },
    };
    (core as any).embedder = target;
    try {
      const report = await core.migrateEmbeddings({
        targetModelId: target.modelId!,
        onProgress(event) {
          if (event.phase !== "lock") return;
          try { core.retireConcept(stored.conceptId); } catch (error) { errors.push(error); }
          try { core.adoptEmbedderPin(); } catch (error) { errors.push(error); }
          try { core.abandonEmbedderMigration(); } catch (error) { errors.push(error); }
          pending.push(core.store("callback reentry").catch((error) => errors.push(error)));
          pending.push(core.reembedConcept(stored.conceptId).catch((error) => errors.push(error)));
          pending.push(core.migrateEmbeddings({ targetModelId: target.modelId! }).catch((error) => errors.push(error)));
          pending.push(new Promise<void>((resolve) => queueMicrotask(() => {
            core.store("queued reentry").catch((error) => errors.push(error)).finally(resolve);
          })));
        },
      });
      await Promise.all(pending);
      expect(report.failures).toEqual([]);
      expect(errors.some((error) => error instanceof EmbedderMigrationReentryError)).toBe(true);
      expect(errors.some((error) => error instanceof EmbedderRepairOwnershipError)).toBe(true);
      expect(errors.filter((error) => error instanceof EmbedderMigrationReentryError).length).toBeGreaterThanOrEqual(6);
      expect(dbOf(core).prepare(`SELECT status FROM concepts WHERE id=?`).get(stored.conceptId).status).toBe("active");
    } finally {
      core.close();
    }
  });

  it("rejects a concurrent outsider while provider descendants retain provider-only context", async () => {
    const original = new SwitchableProvider();
    const core = new MonetCore(":memory:", { embedder: original, graphEnabled: false });
    const stored = await core.store("blocked provider body", { resolution: "forceNew" });
    let entered!: () => void;
    const enteredProvider = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const releaseProvider = new Promise<void>((resolve) => { release = resolve; });
    let providerDescendantDone!: () => void;
    const providerDescendant = new Promise<void>((resolve) => { providerDescendantDone = resolve; });
    let providerDescendantError: unknown;
    let blocked = false;
    const target: EmbeddingProvider = {
      dim: 4,
      modelId: "test:safety:async-owner",
      async embed(text: string): Promise<Float32Array> {
        if (!blocked && text === "blocked provider body") {
          blocked = true;
          entered();
          await releaseProvider;
          queueMicrotask(() => {
            void core.reembedConcept(stored.conceptId)
              .catch((error) => { providerDescendantError = error; })
              .finally(providerDescendantDone);
          });
        }
        return new Float32Array([0, 1, 0, 0]);
      },
    };
    (core as any).embedder = target;
    try {
      const migration = core.migrateEmbeddings({ targetModelId: target.modelId! });
      await enteredProvider;
      await expect(core.reembedConcept(stored.conceptId)).rejects.toBeInstanceOf(EmbedderRepairOwnershipError);
      await expect(core.store("concurrent outsider")).rejects.toBeInstanceOf(EmbedderMigrationReentryError);
      release();
      await expect(migration).resolves.toMatchObject({ failures: [] });
      await providerDescendant;
      expect(providerDescendantError).toBeInstanceOf(EmbedderRepairOwnershipError);
    } finally {
      core.close();
    }
  });

  it("returns durable success and reports a throwing completion observer separately", async () => {
    const provider = new SwitchableProvider();
    const core = new MonetCore(":memory:", { embedder: provider, graphEnabled: false });
    try {
      await core.store("completion observer row", { resolution: "forceNew" });
      const report = await core.migrateEmbeddings({
        targetModelId: provider.modelId,
        onProgress(event) {
          if (event.phase === "complete") throw new Error("observer exploded after completion");
        },
      });
      expect(report.failures).toEqual([]);
      expect(report.observerFailures).toEqual([{ phase: "complete", message: "observer exploded after completion" }]);
      expect(dbOf(core).prepare(`SELECT 1 FROM embedder_migration WHERE singleton=1`).get()).toBeUndefined();
      await expect(core.search("still served")).resolves.toHaveLength(1);
    } finally {
      core.close();
    }
  });
});
