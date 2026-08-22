/**
 * A STORE THE PREVIOUS RELEASE WROTE STILL OPENS, READS, WRITES AND SYNCS.
 *
 * WHY THIS FILE EXISTS. `createGateTables` is one `CREATE TABLE IF NOT EXISTS` per table, which is
 * a no-op against a store that already has them. So a column REMOVED from the schema does not
 * disappear from an existing store — it stays, with whatever constraints it was declared with, for
 * the rest of that store's life. The removal is only ever a removal for stores created afterward.
 *
 * That makes a dropped column a compatibility question rather than a cleanup, and it has a specific
 * failure shape: `stages.verified` was declared `NOT NULL DEFAULT 0`, and an INSERT that stops
 * naming it is fine ONLY because of the DEFAULT. An INSERT written as `INSERT INTO stages VALUES
 * (...)` without a column list, or a future NOT NULL column added without a default, breaks every
 * upgraded store on its first write while every fresh store stays green — which is exactly the kind
 * of defect a fresh-store test suite cannot see.
 *
 * THE THIRD CASE IS THE WIRE, not the schema: a peer still running the previous release exports
 * stage rows that CARRY `verified`. sync-types.ts's `SyncStageRow` states plainly that this is fine
 * ("the graft's INSERT names its columns explicitly, and an extra property on the wire is simply
 * not read"). That claim is load-bearing for anyone syncing across a version boundary and was
 * asserted nowhere; it is asserted here.
 *
 * `verified` is the CONCRETE INSTANCE, removed 2026-08-22 with the mechanical matcher that was the
 * only thing able to set it. The CLASS is what this guards: any column this repo removes from
 * `stages` leaves the same three questions behind.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import type { StoragePort } from "../storage";

const dirs: string[] = [];
const cores: MonetCore[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-gate-compat-"));
  dirs.push(dir);
  return dir;
};
const core = (path: string, extra: Record<string, unknown> = {}): MonetCore => {
  const c = new MonetCore(path, { tauAttach: 1.1, tauAmbiguous: 1.1, ...extra });
  cores.push(c);
  return c;
};
afterEach(() => {
  for (const c of cores.splice(0)) {
    try {
      c.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The engine's own connection, for the DDL and column reads no public method exposes. */
const raw = (c: MonetCore): StoragePort => (c as unknown as { db: StoragePort }).db;

const columnsOf = (c: MonetCore, table: string): string[] =>
  (raw(c).prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((x) => x.name);

describe("stages: a column this build no longer declares", () => {
  it("survives the reopen, and every read and write keeps working around it", async () => {
    const path = join(mkTmp(), "monet.db");

    // A STORE THE PREVIOUS RELEASE WROTE. The ALTER reproduces the removed declaration verbatim —
    // NOT NULL DEFAULT 0 with the same CHECK — because the DEFAULT is the whole reason an INSERT
    // that omits the column still works, and a laxer stand-in would test nothing.
    const previousRelease = core(path);
    raw(previousRelease).exec(
      `ALTER TABLE stages ADD COLUMN verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1))`,
    );
    await previousRelease.store("Never force-push to a shared branch.", {
      kind: "rule",
      rule: { stage: "git force push", instance: "Bash:git push --force origin main", scope: "domain" },
    });
    previousRelease.close();

    // REOPENED BY THIS BUILD. `CREATE TABLE IF NOT EXISTS` is a no-op, so the column is still there
    // — asserted, because the rest of this test is only meaningful if it is.
    const c = core(path);
    expect(columnsOf(c, "stages")).toContain("verified");

    // READ what the previous release wrote...
    expect(c.stages().map((s) => s.name)).toEqual(["git force push"]);
    expect(c.stageLookup({ stage: "git force push" }).rules).toHaveLength(1);

    // ...and WRITE a new stage through the current INSERT, which does not name the column.
    await c.declare({ species: "stage", stage: "terraform apply", patterns: ["Bash:terraform apply"] });
    expect(c.stages().map((s) => s.name).sort()).toEqual(["git force push", "terraform apply"]);
    // The DEFAULT did the work — the row is complete and the NOT NULL constraint is satisfied.
    expect(raw(c).prepare(`SELECT verified FROM stages WHERE name = 'terraform apply'`).get()).toEqual({
      verified: 0,
    });
  });

  it("grafts a payload from a peer that still sends the removed field", async () => {
    const path = join(mkTmp(), "monet.db");
    const sender = core(path);
    await sender.declare({ species: "stage", stage: "git force push", patterns: ["Bash:git push --force"] });
    await sender.declare({ species: "stage", stage: "terraform apply", patterns: ["Bash:terraform apply"] });

    const payload = sender.exportDelta(0);
    expect(payload.stages ?? []).toHaveLength(2);
    // A PRE-2026-08-22 PEER'S WIRE SHAPE: every stage row carries `verified`. The receiver must not
    // read it, must not choke on it, and must not let it reach the INSERT — see SyncStageRow.
    for (const row of payload.stages ?? []) (row as unknown as { verified: number }).verified = 1;

    const receiver = core(":memory:", { syncDeviceId: "machine-b" });
    const result = receiver.graftRows(payload);
    expect(result.inserted.stages).toBe(2);
    expect(receiver.stages().map((s) => s.name).sort()).toEqual(["git force push", "terraform apply"]);
    // The receiver's own schema is untouched by what the sender sent.
    expect(columnsOf(receiver, "stages")).not.toContain("verified");
  });
});
