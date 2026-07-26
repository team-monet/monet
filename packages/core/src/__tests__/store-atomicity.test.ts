/**
 * store() atomicity regression — data-integrity bug fix (2026-06-12).
 *
 * Before the fix: store()'s mutation path was NOT wrapped in a transaction. An extraction /
 * graph-derivation failure after the observation INSERT (and after concept create/attach) left
 * orphaned rows. A retry then created a near-duplicate concept because the first call's rows
 * persisted despite the error returning to the caller.
 *
 * After the fix: the entire mutation path — observation insert, resolution (attach/create/fork
 * + possible_duplicate_of edges), concept updates, entity extraction + graph derivation — runs
 * inside one transaction. If anything in that envelope throws, ALL writes roll back. The session
 * row (ensureSession) intentionally lives OUTSIDE the envelope.
 *
 * Injection strategy: a `CrashingEntityPort` wraps `BetterSqlitePort` and throws a controlled
 * error the first time a write to the `entities` table is attempted (i.e., during graph
 * derivation, after the observation row and concept row have been written). This exercises the
 * exact failure mode described in the live-store evidence.
 *
 * Test structure:
 *  1. PRE-FIX (behaviour): crashing store returns/throws error AND leaves zero new rows.
 *  2. POST-FIX (behaviour): same injection still errors but counts remain byte-identical;
 *     a subsequent NORMAL store still works end-to-end.
 *  3. NORMAL store (regression guard): store still works correctly when no crash occurs.
 */

import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";
import { BetterSqlitePort } from "../storage";
import type { StoragePort, Statement, PragmaOptions, RunResult } from "../storage";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * A StoragePort proxy that wraps BetterSqlitePort. On the first INSERT into the `entities`
 * table (which happens during graph derivation, after observation/concept rows are written),
 * it throws a controlled error. All other writes pass through untouched.
 *
 * This reproduces the crash-at-extraction failure mode: the observation row and concept row
 * have already been inserted when the error fires.
 */
class CrashingEntityPort implements StoragePort {
  private inner: BetterSqlitePort;
  private shouldCrash: boolean;

  constructor() {
    this.inner = new BetterSqlitePort(":memory:");
    this.shouldCrash = false;
  }

  /** Arm the crash so the next entities-table write will throw. */
  armCrash(): void {
    this.shouldCrash = true;
  }

  /** Disarm the crash (for the normal-store phase). */
  disarmCrash(): void {
    this.shouldCrash = false;
  }

  prepare(sql: string): Statement {
    const inner = this.inner;
    const self = this;
    const stmt = inner.prepare(sql);
    // Intercept writes to the entities table — this is the graph-derivation step.
    const isEntityWrite =
      /^\s*INSERT\s+INTO\s+entities\b/i.test(sql) ||
      /^\s*INSERT\s+INTO\s+concept_entities\b/i.test(sql);

    if (!isEntityWrite) return stmt;

    // Return a proxy statement that throws on .run() when the crash is armed.
    return {
      run(...params: unknown[]): RunResult {
        if (self.shouldCrash) {
          self.shouldCrash = false; // fire once, then disarm
          throw new Error("INJECTED: entity extraction crash (simulates lexicon bug)");
        }
        return stmt.run(...params);
      },
      get(...params: unknown[]): unknown {
        return stmt.get(...params);
      },
      all(...params: unknown[]): unknown[] {
        return stmt.all(...params);
      },
    };
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  pragma(source: string, options?: PragmaOptions): unknown {
    return this.inner.pragma(source, options);
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return this.inner.transaction(fn);
  }

  immediateTransaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return this.inner.immediateTransaction(fn);
  }

  inTransaction(): boolean {
    return this.inner.inTransaction();
  }

  acquireExclusiveOwnership(): void {
    this.inner.acquireExclusiveOwnership();
  }

  releaseExclusiveOwnership(): void {
    this.inner.releaseExclusiveOwnership();
  }

  close(): void {
    this.inner.close();
  }

  /** Row-count helpers for assertion. */
  countTable(table: string): number {
    const stmt = this.inner.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
    return (stmt.get() as { n: number }).n;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("store() atomicity — crash during graph derivation", () => {
  /**
   * Core assertion: a crashing store leaves ZERO new rows in every affected table.
   *
   * Before the fix this test fails because the observation row and concept row persist
   * (the crash happens after those INSERTs, but there's no transaction rolling them back).
   */
  it("(pre-fix would fail) crashing store returns error AND leaves no observation, concept, edge, entity rows", async () => {
    const port = new CrashingEntityPort();
    // graphEnabled:true ensures the entity/derivation path runs (where the crash fires).
    const c = new MonetCore(port, { graphEnabled: true, tauAttach: 1.1, tauAmbiguous: 1.1 });

    const obsBefore = port.countTable("observations");
    const conceptsBefore = port.countTable("concepts");
    const edgesBefore = port.countTable("memory_edge");
    const entitiesBefore = port.countTable("entities");
    const cesBefore = port.countTable("concept_entities");
    // The store-time resolution log is written inside the same transaction, so it is covered by
    // the same guarantee and counted here rather than assumed: an instrumentation row surviving a
    // rolled-back write would report a decision the store never made, which is worse than no row.
    const resolutionsBefore = port.countTable("resolution_events");

    // Arm crash: the next entities-table write will throw.
    port.armCrash();

    // store() must propagate the error to the caller.
    await expect(c.store("TypeScript EntityService path/to/file.ts")).rejects.toThrow(
      "INJECTED: entity extraction crash",
    );

    // ALL counts must be byte-identical to before — no partial writes.
    expect(port.countTable("observations")).toBe(obsBefore);
    expect(port.countTable("concepts")).toBe(conceptsBefore);
    expect(port.countTable("memory_edge")).toBe(edgesBefore);
    expect(port.countTable("entities")).toBe(entitiesBefore);
    expect(port.countTable("concept_entities")).toBe(cesBefore);
    expect(port.countTable("resolution_events")).toBe(resolutionsBefore);

    c.close();
  });

  /**
   * After the fix: crashing store still errors, counts still byte-identical to pre-call.
   * Then a NORMAL store (no crash) succeeds and increments counts by exactly 1 obs + 1 concept.
   */
  it("after fix: crashing store errors, counts unchanged; subsequent normal store succeeds end-to-end", async () => {
    const port = new CrashingEntityPort();
    const c = new MonetCore(port, { graphEnabled: true, tauAttach: 1.1, tauAmbiguous: 1.1 });

    const obsBefore = port.countTable("observations");
    const conceptsBefore = port.countTable("concepts");

    // Phase 1 — crashing call.
    port.armCrash();
    await expect(c.store("TypeScript EntityService path/to/file.ts")).rejects.toThrow(
      "INJECTED: entity extraction crash",
    );
    // Counts unchanged.
    expect(port.countTable("observations")).toBe(obsBefore);
    expect(port.countTable("concepts")).toBe(conceptsBefore);
    expect(port.countTable("resolution_events")).toBe(0);

    // Phase 2 — normal store succeeds (crash is disarmed after the single-shot fire).
    const result = await c.store("TypeScript EntityService path/to/file.ts");
    expect(result.action).toMatch(/^(created|attached)$/);
    expect(result.conceptId).toBeTruthy();

    // Exactly one new observation, one new concept, and one resolution event — the log tracks
    // COMMITTED writes exactly, which is what makes a rate computed from it trustworthy.
    expect(port.countTable("observations")).toBe(obsBefore + 1);
    expect(port.countTable("concepts")).toBe(conceptsBefore + 1);
    expect(port.countTable("resolution_events")).toBe(1);

    // Full fetch works.
    const fetched = await c.getConcept(result.conceptId, { synthesize: false });
    expect(fetched).not.toBeNull();
    expect(fetched!.supportCount).toBe(1);

    c.close();
  });

  /**
   * Normal store regression guard: without any crash injection, store() still creates rows
   * in ALL tables (observations, concepts, entities, concept_entities, memory_edge for
   * concepts that share entities).
   */
  it("normal store (no crash) populates observations, concepts, entities, concept_entities", async () => {
    const port = new CrashingEntityPort();
    const c = new MonetCore(port, { graphEnabled: true, tauAttach: 1.1, tauAmbiguous: 1.1 });

    const obsBefore = port.countTable("observations");
    const conceptsBefore = port.countTable("concepts");

    const result = await c.store("TypeScript EntityService stores path/to/service.ts");
    expect(result.action).toBe("created");

    expect(port.countTable("observations")).toBeGreaterThan(obsBefore);
    expect(port.countTable("concepts")).toBeGreaterThan(conceptsBefore);
    // Entity rows should exist (TypeScript, EntityService, path/to/service.ts are extractable).
    expect(port.countTable("entities")).toBeGreaterThan(0);
    expect(port.countTable("concept_entities")).toBeGreaterThan(0);

    c.close();
  });

  /**
   * Session row lives OUTSIDE the transaction envelope by design:
   * A crashing store must NOT roll back the session row — the session is an audit trail
   * of what was attempted, independent of whether the store succeeded. The next successful
   * store in the same session will reuse the same session id.
   */
  it("crashing store does not roll back the session row (session is outside the envelope)", async () => {
    const port = new CrashingEntityPort();
    const c = new MonetCore(port, { graphEnabled: true, tauAttach: 1.1, tauAmbiguous: 1.1 });

    const sessionsBefore = (port as unknown as { inner: BetterSqlitePort }).inner
      .prepare("SELECT COUNT(*) AS n FROM sessions")
      .get() as { n: number };

    port.armCrash();
    await expect(c.store("TypeScript EntityService path/to/file.ts")).rejects.toThrow();

    const sessionsAfter = (port as unknown as { inner: BetterSqlitePort }).inner
      .prepare("SELECT COUNT(*) AS n FROM sessions")
      .get() as { n: number };

    // Session was opened (ensureSession ran before the transaction) and must survive the rollback.
    expect(sessionsAfter.n).toBe(sessionsBefore.n + 1);

    c.close();
  });
});
