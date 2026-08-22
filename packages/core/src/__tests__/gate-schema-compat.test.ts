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
 * TWO CONCRETE INSTANCES, one CLASS. `verified` was REMOVED on 2026-08-22 with the mechanical
 * matcher that was the only thing able to set it — it could go because its DEFAULT covered the
 * upgraded store. `trigger_patterns` was RETIRED the same day and could NOT go, because it is
 * `NOT NULL` with NO default: see the second describe block for the two independent reasons the
 * column outlived the concept, each of which this file holds to.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { RETIRED_TRIGGER_PATTERNS } from "../gates";
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
      rule: { stage: "git force push", scope: "domain" },
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
    await c.declare({ species: "stage", stage: "terraform apply" });
    expect(c.stages().map((s) => s.name).sort()).toEqual(["git force push", "terraform apply"]);
    // The DEFAULT did the work — the row is complete and the NOT NULL constraint is satisfied.
    expect(raw(c).prepare(`SELECT verified FROM stages WHERE name = 'terraform apply'`).get()).toEqual({
      verified: 0,
    });
  });

  it("grafts a payload from a peer that still sends the removed field", async () => {
    const path = join(mkTmp(), "monet.db");
    const sender = core(path);
    await sender.declare({ species: "stage", stage: "git force push" });
    await sender.declare({ species: "stage", stage: "terraform apply" });

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

/**
 * THE OTHER ENDING, and the reason the class above is not "removed columns are fine".
 *
 * `trigger_patterns` was retired as a CONCEPT on 2026-08-22 and the COLUMN deliberately stayed. Two
 * independent reasons, either one sufficient, and this block holds to both so that a later cleanup
 * pass cannot quietly take the column out on the grounds that nothing reads it:
 *
 *   1. THE LOCAL STORE. Unlike `verified`, this column is `TEXT NOT NULL` with NO DEFAULT. An
 *      INSERT that stopped naming it would fail on every store the previous release wrote.
 *   2. THE WIRE. `exportDelta` selects `*`. A build that dropped the column would send peers a
 *      stage row with no `trigger_patterns` property; an older peer binds that positionally into
 *      its own NOT NULL column and its graft loop has no per-row catch, so the throw takes down the
 *      ENTIRE graft rather than one row.
 */
describe("stages.trigger_patterns: a retired concept whose column had to stay", () => {
  it("is still declared NOT NULL with no default, which is why the INSERT must name it", () => {
    const c = core(":memory:");
    const col = (raw(c).prepare(`PRAGMA table_info(stages)`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>).find((x) => x.name === "trigger_patterns");

    // If this assertion ever fails because the column was dropped, read the block comment above
    // before "fixing" the test: dropping it is the defect, not the assertion.
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(1);
    // NO DEFAULT — the entire difference from `verified`, and the reason omitting the column from
    // the INSERT is not an option here.
    expect(col!.dflt_value).toBeNull();
  });

  it("is written on every stage this build creates, so an upgraded store keeps accepting writes", async () => {
    const path = join(mkTmp(), "monet.db");

    // A STORE THE PREVIOUS RELEASE WROTE, carrying a real pattern array in the column.
    const previousRelease = core(path);
    raw(previousRelease)
      .prepare(
        `INSERT INTO stages (id, name, trigger_patterns, origin, created_at, sync_updated_at,
                             sync_revision, sync_writer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "stage-legacy",
        "git force push",
        JSON.stringify([{ tool: "bash", tokens: ["git", "push", "--force"] }]),
        "declaration",
        1,
        1,
        0,
        "machine-a",
      );
    previousRelease.close();

    const c = core(path);
    // The legacy row still READS — nothing parses the column, and the stage is addressed by name.
    expect(c.stages().map((s) => s.name)).toEqual(["git force push"]);
    // And nothing surfaces the stored patterns any more: a StageView is name + origin.
    expect(Object.keys(c.stages()[0]!).sort()).toEqual(["createdAt", "id", "name", "origin"]);

    // THE WRITE THAT THE NOT NULL CONSTRAINT WOULD HAVE BROKEN. This is the whole test: creating a
    // stage on a store that already carries the column must still work.
    await c.declare({ species: "stage", stage: "terraform apply" });
    expect(
      raw(c).prepare(`SELECT trigger_patterns FROM stages WHERE name = 'terraform apply'`).get(),
    ).toEqual({ trigger_patterns: RETIRED_TRIGGER_PATTERNS });

    // The capture entrance mints stages too, and takes the same INSERT.
    await c.store("Never run apply without a plan.", {
      kind: "rule",
      rule: { stage: "terraform apply without plan", scope: "domain" },
    });
    expect(
      raw(c)
        .prepare(`SELECT trigger_patterns FROM stages WHERE name = 'terraform apply without plan'`)
        .get(),
    ).toEqual({ trigger_patterns: RETIRED_TRIGGER_PATTERNS });

    // The legacy row was never rewritten — retirement is not a migration.
    expect(
      raw(c).prepare(`SELECT trigger_patterns FROM stages WHERE id = 'stage-legacy'`).get(),
    ).toEqual({ trigger_patterns: JSON.stringify([{ tool: "bash", tokens: ["git", "push", "--force"] }]) });
  });

  it("names the column in the INSERT — an INSERT that omitted it would fail outright", () => {
    // THE FAILURE THIS FILE EXISTS TO PREVENT, demonstrated rather than asserted about. If a later
    // change drops `trigger_patterns` from upsertStage's INSERT, every stage creation starts
    // throwing exactly this, on fresh and upgraded stores alike.
    const c = core(":memory:");
    expect(() =>
      raw(c)
        .prepare(
          `INSERT INTO stages (id, name, origin, created_at, sync_updated_at, sync_revision, sync_writer)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("s1", "some stage", "declaration", 1, 1, 0, "machine-a"),
    ).toThrow(/NOT NULL constraint failed: stages\.trigger_patterns/);
  });

  it("keeps sending the column on the wire, so an older peer's graft does not abort", async () => {
    const sender = core(":memory:");
    await sender.declare({ species: "stage", stage: "terraform apply" });
    const payload = sender.exportDelta(0);
    expect(payload.stages ?? []).toHaveLength(1);

    // DIRECTION 4: this build's payload, grafted by a peer still running the previous release. That
    // peer's INSERT binds `row.trigger_patterns` POSITIONALLY into its own NOT NULL column, and its
    // graft loop has no per-row catch — so an absent property would abort the whole graft, not skip
    // one row. Replaying that peer's exact statement here is the assertion.
    const oldPeer = core(":memory:", { syncDeviceId: "machine-old" });
    const row = (payload.stages ?? [])[0]!;
    expect(() =>
      raw(oldPeer)
        .prepare(
          `INSERT INTO stages (id, name, trigger_patterns, origin, created_at, sync_updated_at,
                               sync_revision, sync_writer)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id, row.name, row.trigger_patterns, row.origin,
          row.created_at, row.sync_updated_at, row.sync_revision ?? 0, row.sync_writer ?? null,
        ),
    ).not.toThrow();
    expect(
      raw(oldPeer).prepare(`SELECT trigger_patterns FROM stages WHERE id = ?`).get(row.id),
    ).toEqual({ trigger_patterns: RETIRED_TRIGGER_PATTERNS });
  });

  it("grafts an older peer's real pattern array without reading it", async () => {
    const receiver = core(":memory:", { syncDeviceId: "machine-b" });
    const sender = core(":memory:", { syncDeviceId: "machine-a" });
    await sender.declare({ species: "stage", stage: "git force push" });
    const payload = sender.exportDelta(0);
    // A PRE-RETIREMENT PEER'S WIRE SHAPE: a real pattern array, not the tombstone.
    for (const row of payload.stages ?? []) {
      row.trigger_patterns = JSON.stringify([{ tool: "bash", tokens: ["git", "push", "--force"] }]);
    }

    expect(receiver.graftRows(payload).inserted.stages).toBe(1);
    // It lands verbatim — the receiver stores what it was sent and never parses it...
    expect(
      raw(receiver).prepare(`SELECT trigger_patterns FROM stages WHERE name = 'git force push'`).get(),
    ).toEqual({ trigger_patterns: JSON.stringify([{ tool: "bash", tokens: ["git", "push", "--force"] }]) });
    // ...and the stage is still addressed by NAME, which is the only address there is now.
    expect(receiver.stageLookup({ stage: "git force push" }).stage?.name).toBe("git force push");
  });
});

/**
 * THE OTHER HALF OF THIS FILE'S CLASS: an object the build no longer CREATES, in a store that
 * already HAS it.
 *
 * The two describe blocks above are about columns that had to survive removal. This one is the
 * opposite disposition on the same asymmetry — a family of objects that must be actively destroyed,
 * because leaving them costs work on every write instead of merely occupying a column.
 *
 * `gate_meta` and its eleven triggers were the mixed-build compatibility family, removed on
 * 2026-08-22 by deleting their CREATE statements. That stopped fresh stores from acquiring them and
 * left every upgraded store carrying all twelve objects, still firing on concept title/status/circle
 * changes, stage inserts, rule reclassification and alias mutations — each bumping a generation
 * counter whose last reader went with the gate mirror.
 *
 * THE FIXTURE IS BUILT TO BE ABLE TO FAIL. It installs the family with the previous release's own
 * verbatim DDL and then PROVES the triggers fire — `generation` is read before and after a real
 * declaration — before the store is ever reopened. Without that, a green result here would be
 * indistinguishable from a fixture whose triggers were inert typos, which is the one thing a
 * migration test must not be.
 */
describe("gate_meta and its trigger family: objects this build no longer creates", () => {
  const PREVIOUS_RELEASE_FAMILY_SQL = `
    CREATE TABLE IF NOT EXISTS gate_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO gate_meta (singleton, generation) VALUES (1, 0);

    CREATE TRIGGER IF NOT EXISTS trg_rule_bindings_backfill_circle
    AFTER INSERT ON rule_bindings
    FOR EACH ROW WHEN NEW.circle IS NULL
    BEGIN
      UPDATE rule_bindings SET circle = (
        SELECT CASE WHEN c.circle = '*' THEN NULL ELSE c.circle END
          FROM concepts c WHERE c.id = NEW.concept_id
      ) WHERE concept_id = NEW.concept_id;
      UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_rule_bindings_follow_concept_circle
    AFTER UPDATE OF circle ON concepts
    FOR EACH ROW WHEN NEW.circle != '*'
    BEGIN
      UPDATE rule_bindings SET circle = NEW.circle
       WHERE concept_id = NEW.id AND circle IS NOT NULL AND circle != '*';
      UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_rule_bindings_follow_concept_status
    AFTER UPDATE OF status ON concepts
    FOR EACH ROW WHEN OLD.status IS NOT NEW.status AND EXISTS (SELECT 1 FROM rule_bindings WHERE concept_id = NEW.id)
    BEGIN
      UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_rule_bindings_follow_concept_title
    AFTER UPDATE OF title ON concepts
    FOR EACH ROW WHEN OLD.title IS NOT NEW.title AND EXISTS (SELECT 1 FROM rule_bindings WHERE concept_id = NEW.id)
    BEGIN
      UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_rule_bindings_bump_on_reclassification
    AFTER UPDATE OF stage_id, severity, scope, model_tag, origin, declared_by, reason ON rule_bindings
    FOR EACH ROW WHEN
      OLD.stage_id IS NOT NEW.stage_id OR OLD.severity IS NOT NEW.severity OR OLD.scope IS NOT NEW.scope OR
      OLD.model_tag IS NOT NEW.model_tag OR OLD.origin IS NOT NEW.origin OR OLD.declared_by IS NOT NEW.declared_by OR
      OLD.reason IS NOT NEW.reason
    BEGIN
      UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_stages_bump_on_trigger_patterns
    AFTER UPDATE OF trigger_patterns ON stages
    FOR EACH ROW WHEN OLD.trigger_patterns IS NOT NEW.trigger_patterns
    BEGIN
      UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_stages_bump_on_insert
    AFTER INSERT ON stages
    BEGIN
      UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_concepts_bump_on_delete
    AFTER DELETE ON concepts
    FOR EACH ROW WHEN EXISTS (SELECT 1 FROM rule_bindings WHERE concept_id = OLD.id)
    BEGIN
      UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_circle_aliases_bump_on_insert
    AFTER INSERT ON circle_aliases
    BEGIN
      UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_circle_aliases_bump_on_update
    AFTER UPDATE OF to_name, status ON circle_aliases
    FOR EACH ROW WHEN OLD.to_name IS NOT NEW.to_name OR OLD.status IS NOT NEW.status
    BEGIN
      UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_circle_aliases_bump_on_delete
    AFTER DELETE ON circle_aliases
    BEGIN
      UPDATE gate_meta SET generation = generation + 1 WHERE singleton = 1;
    END;
  `;

  /** Every object of the family still present, by name — the whole point is that this ends empty. */
  const familyObjectsIn = (c: MonetCore): string[] =>
    (
      raw(c)
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE (type = 'trigger' AND name LIKE 'trg_%')
               OR (type = 'table' AND name = 'gate_meta')
            ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

  const generationOf = (c: MonetCore): number =>
    (raw(c).prepare(`SELECT generation FROM gate_meta WHERE singleton = 1`).get() as { generation: number })
      .generation;

  it("an upgraded store carrying the family comes out clean, and keeps writing", async () => {
    const path = join(mkTmp(), "monet.db");

    // A STORE THE PREVIOUS RELEASE WROTE: this build's schema, plus the family it no longer creates.
    const previousRelease = core(path);
    raw(previousRelease).exec(PREVIOUS_RELEASE_FAMILY_SQL);
    expect(familyObjectsIn(previousRelease)).toHaveLength(12);

    // THE FIXTURE CAN EXHIBIT THE EFFECT — measured, not assumed. A declaration inserts a stage and
    // a rule binding, so at least two of the eleven fire; if the counter does not move, the DDL
    // above is decorative and everything below it proves nothing.
    const before = generationOf(previousRelease);
    await previousRelease.store("Never force-push to a shared branch.", {
      kind: "rule",
      rule: { stage: "git force push", scope: "domain" },
    });
    expect(generationOf(previousRelease)).toBeGreaterThan(before);
    previousRelease.close();

    // REOPENED BY THIS BUILD. Deleting the CREATE statements did nothing to this store; the drop in
    // `migrateGateColumns` is what has to.
    const c = core(path);
    expect(familyObjectsIn(c)).toEqual([]);
    expect(
      raw(c).prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gate_meta'`).get(),
    ).toBeUndefined();

    // AND THE STORE STILL WORKS. Dropping `gate_meta` while a trigger that writes to it survived
    // would leave the next stage insert failing "no such table: gate_meta" — this write is what
    // proves the triggers-before-table ordering actually held.
    await c.declare({ species: "stage", stage: "terraform apply" });
    expect(c.stages().map((s) => s.name).sort()).toEqual(["git force push", "terraform apply"]);
    // What the previous release wrote is still readable, and still delivers.
    expect(c.stageLookup({ stage: "git force push" }).rules).toHaveLength(1);
  });

  it("is a no-op on a store that never had the family, and on a second open", async () => {
    const path = join(mkTmp(), "monet.db");

    // A store created entirely by this build: twelve `IF EXISTS` drops that find nothing.
    const fresh = core(path);
    expect(familyObjectsIn(fresh)).toEqual([]);
    await fresh.declare({ species: "stage", stage: "terraform apply" });
    fresh.close();

    // Reopened — the drop runs again (twice per construction, via init() and after migrate()) and
    // is still a no-op. Idempotence here is what lets it run unconditionally with no version gate.
    const reopened = core(path);
    expect(familyObjectsIn(reopened)).toEqual([]);
    expect(reopened.stages().map((s) => s.name)).toEqual(["terraform apply"]);
  });
});
