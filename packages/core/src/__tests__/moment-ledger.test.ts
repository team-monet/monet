/**
 * The moment ledger.
 *
 * TWO PROPERTIES CARRY THIS FILE, and everything else here is in service of them.
 *
 * COMPLETENESS: the store must be able to say "run R is missing seq 3-5", not merely hold fewer
 * rows than were written. A swallowed append is invisible in a file; it is nameable in a sequence.
 *
 * IDEMPOTENCE: the fold runs on demand, before every read and every write against a moment, so it
 * re-reads ranges constantly. If a second fold over the same range changed anything at all, every
 * number computed from this ledger would depend on how often somebody asked.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BetterSqlitePort } from "../storage";
import type { StoragePort } from "../storage";
import {
  UnknownMomentError,
  attachMomentAnswer,
  attachMomentAsk,
  createMomentTables,
  foldMomentSpool,
  observedMomentLosses,
  readGovernedMoment,
} from "../moment-ledger";
import { spoolInterception, spoolOutcome, spoolRuleRead, startMomentRun } from "../moment-spool";
import type { MomentRun } from "../moment-spool";

const dirs: string[] = [];
const ports: StoragePort[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-moment-ledger-"));
  dirs.push(dir);
  return dir;
};
const mkDb = (): StoragePort => {
  const db = new BetterSqlitePort(":memory:");
  ports.push(db);
  return db;
};
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A spool line written by hand, so a test can seed a hole no live writer would produce. */
function seed(path: string, runId: string, seq: number, body: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify({ v: 1, runId, seq, ...body })}\n`);
}

function interception(momentId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "interception",
    momentId,
    at: "2026-08-19T00:00:00.000Z",
    toolUseId: null,
    sessionId: null,
    surface: "Bash",
    actionSha256: "a".repeat(64),
    actionRendering: "git status",
    actionChars: 10,
    actionClipped: false,
    stageId: null,
    ruleIds: [],
    disposition: "silent",
    deliveredRuleIds: [],
    ...overrides,
  };
}

/** Everything the ledger holds, in a form two folds can be compared on. */
function dump(db: StoragePort): unknown {
  return {
    moments: db.prepare(`SELECT * FROM governed_moments ORDER BY moment_id`).all(),
    runs: db.prepare(`SELECT * FROM moment_runs ORDER BY run_id`).all(),
    losses: db
      .prepare(`SELECT kind, run_id, from_seq, to_seq, tool_use_id, outcome_at FROM moment_losses ORDER BY id`)
      .all(),
  };
}

describe("the transport proves its own completeness", () => {
  it("names the hole a swallowed append left behind", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seed(path, "run-a", 0, { kind: "run-start", writerRole: "host-hook", at: "2026-08-19T00:00:00.000Z" });
    seed(path, "run-a", 1, interception("m1"));
    seed(path, "run-a", 2, interception("m2"));
    // seq 3, 4 and 5 were consumed by appends that failed. Nothing is on disk for them.
    seed(path, "run-a", 6, interception("m6"));
    seed(path, "run-a", 7, interception("m7"));

    const folded = foldMomentSpool(db, path);
    expect(folded.gapsOpened).toBe(3);
    expect(observedMomentLosses(db, path)).toEqual([
      { kind: "sequence-gap", runId: "run-a", writerRole: "host-hook", fromSeq: 3, toSeq: 5 },
    ]);
  });

  it("names a hole in a run whose own declaration never landed", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    // No run-start record at all: seq 0 was consumed and lost.
    seed(path, "run-b", 1, interception("m1"));
    foldMomentSpool(db, path);
    expect(observedMomentLosses(db, path)).toEqual([{ kind: "sequence-gap", runId: "run-b", writerRole: null, fromSeq: 0, toSeq: 0 }]);
  });

  it("closes the part of a hole that turns up later, and keeps naming the rest", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seed(path, "run-a", 0, { kind: "run-start", writerRole: "core", at: "2026-08-19T00:00:00.000Z" });
    seed(path, "run-a", 5, interception("m5"));
    foldMomentSpool(db, path);
    expect(observedMomentLosses(db, path)).toEqual([{ kind: "sequence-gap", runId: "run-a", writerRole: "core", fromSeq: 1, toSeq: 4 }]);

    seed(path, "run-a", 3, interception("m3"));
    const second = foldMomentSpool(db, path);
    expect(second.gapsClosed).toBe(1);
    expect(observedMomentLosses(db, path)).toEqual([
      { kind: "sequence-gap", runId: "run-a", writerRole: "core", fromSeq: 1, toSeq: 2 },
      { kind: "sequence-gap", runId: "run-a", writerRole: "core", fromSeq: 4, toSeq: 4 },
    ]);
  });

  it("reports nothing missing when every sequence number landed", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const run = startMomentRun(path, "core");
    for (const id of ["m1", "m2", "m3"]) {
      spoolInterception(run, {
        momentId: id,
        at: "2026-08-19T00:00:00.000Z",
        toolUseId: null,
        sessionId: null,
        surface: "Bash",
        action: "git status",
        stageId: null,
        ruleIds: [],
        disposition: "silent",
        deliveredRuleIds: [],
      });
    }
    foldMomentSpool(db, path);
    expect(observedMomentLosses(db, path)).toEqual([]);
    // The one thing sequencing CANNOT catch, asserted so nobody reads the report as total.
    const vanished = startMomentRun(join(mkTmp(), "gone", "moments.jsonl"), "host-hook");
    expect(vanished.seq).toBe(1);
    expect(observedMomentLosses(db, path)).toEqual([]);
  });
});

describe("the fold is idempotent", () => {
  it("changes nothing when the same range is folded a second time", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seed(path, "run-a", 0, { kind: "run-start", writerRole: "core", at: "2026-08-19T00:00:00.000Z" });
    seed(path, "run-a", 1, interception("m1", { ruleIds: ["r1"], disposition: "advised", deliveredRuleIds: ["r1"] }));
    seed(path, "run-a", 3, { kind: "read", momentId: "m1", ruleId: "r1", namedStageId: null, readAt: "2026-08-19T00:00:01.000Z" });
    seed(path, "run-a", 4, { kind: "outcome", momentId: "m1", toolUseId: null, outcomeStatus: null, outcomeAt: "t", outcomeSha256: "b".repeat(64) });

    const first = foldMomentSpool(db, path);
    expect(first.recordsFolded).toBe(4);
    const afterFirst = dump(db);

    // Re-fold the SAME range, not the empty tail: rewind the cursor and read it all again.
    db.prepare(`UPDATE moment_fold_cursor SET byte_offset = 0 WHERE singleton = 1`).run();
    const second = foldMomentSpool(db, path);
    expect(second.recordsFolded).toBe(4);
    expect(second.gapsOpened).toBe(0);
    expect(second.gapsClosed).toBe(0);
    expect(dump(db)).toEqual(afterFirst);

    // And a PARTIAL overlap, which is the shape a crash between applying and storing the cursor
    // leaves behind: rewind into the middle of the range so some records are re-applied, some not.
    const written = readFileSync(path, "utf8").split("\n");
    const midpoint = Buffer.byteLength(`${written[0]}\n${written[1]}\n`, "utf8");
    db.prepare(`UPDATE moment_fold_cursor SET byte_offset = ? WHERE singleton = 1`).run(midpoint);
    const third = foldMomentSpool(db, path);
    expect(third.recordsFolded).toBe(2);
    expect(dump(db)).toEqual(afterFirst);
  });

  it("keeps the first observation when a later record claims a different value", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seed(path, "run-a", 0, interception("m1", { surface: "Bash", disposition: "silent" }));
    seed(path, "run-a", 1, interception("m1", { surface: "Write", disposition: "blocked" }));
    seed(path, "run-a", 2, { kind: "read", momentId: "m1", ruleId: "r1", namedStageId: null, readAt: "first" });
    seed(path, "run-a", 3, { kind: "read", momentId: "m1", ruleId: "r1", namedStageId: null, readAt: "second" });
    foldMomentSpool(db, path);
    const moment = readGovernedMoment(db, path, "m1");
    expect(moment).toMatchObject({ surface: "Bash", disposition: "silent" });
    expect(moment?.ruleReads).toEqual({ r1: "first" });
  });

  it("costs nothing when there is nothing new to fold", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seed(path, "run-a", 0, interception("m1"));
    const first = foldMomentSpool(db, path);
    const second = foldMomentSpool(db, path);
    expect(second.recordsFolded).toBe(0);
    expect(second.cursor).toBe(first.cursor);
  });
});

describe("not known is never a verdict", () => {
  it("keeps an empty rule set and a silent disposition as values", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seed(path, "run-a", 0, interception("m1"));
    const moment = readGovernedMoment(db, path, "m1");
    expect(moment).toMatchObject({ opened: true, ruleIds: [], deliveredRuleIds: [], disposition: "silent" });
    expect(moment?.sessionId).toBeNull();
    expect(moment?.stageId).toBeNull();
  });

  it("marks a moment nobody intercepted rather than passing it off as governed", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    // An outcome arrived for a moment whose interception record was swallowed.
    seed(path, "run-a", 0, { kind: "outcome", momentId: "orphan", toolUseId: null, outcomeStatus: null, outcomeAt: "t", outcomeSha256: "c".repeat(64) });
    const moment = readGovernedMoment(db, path, "orphan");
    expect(moment).toMatchObject({ opened: false, outcomeSha256: "c".repeat(64) });
    expect(moment?.disposition).toBeNull();
    expect(moment?.ruleIds).toBeNull();
  });

  it("leaves a run's role unknown until its declaration is folded", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seed(path, "run-a", 1, interception("m1"));
    foldMomentSpool(db, path);
    expect(db.prepare(`SELECT writer_role FROM moment_runs WHERE run_id = 'run-a'`).get()).toEqual({
      writer_role: null,
    });
  });
});

describe("an answer attaches; it never creates", () => {
  const openMoment = (path: string, db: StoragePort): MomentRun => {
    const run = startMomentRun(path, "core");
    spoolInterception(run, {
      momentId: "m1",
      at: "2026-08-19T00:00:00.000Z",
      toolUseId: null,
      sessionId: "s1",
      surface: "Bash",
      action: "git push --force",
      stageId: "stage-1",
      ruleIds: ["r1"],
      disposition: "advised",
      deliveredRuleIds: ["r1"],
    });
    spoolRuleRead(run, { momentId: "m1", ruleId: "r1", namedStageId: "stage-1", readAt: "2026-08-19T00:00:01.000Z" });
    spoolOutcome(run, { momentId: "m1", toolUseId: null, outcome: "ok", outcomeStatus: "ok", outcomeAt: "2026-08-19T00:00:02.000Z" });
    createMomentTables(db);
    return run;
  };

  it("errors to the caller when the moment is in neither the ledger nor the spool", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const run = openMoment(path, db);
    expect(() => attachMomentAnswer(db, run, { momentId: "never-seen", answer: "followed" })).toThrow(
      UnknownMomentError,
    );
    expect(db.prepare(`SELECT COUNT(*) AS n FROM governed_moments WHERE moment_id = 'never-seen'`).get()).toEqual({
      n: 0,
    });
  });

  it("attaches to a moment that is only in the spool, because the write folds first", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const run = openMoment(path, db);
    // Nothing has folded yet: the ledger has never heard of m1.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM governed_moments`).get()).toEqual({ n: 0 });

    attachMomentAsk(db, run, { momentId: "m1", askedAt: "2026-08-19T00:00:03.000Z" });
    attachMomentAnswer(db, run, { momentId: "m1", answer: "not-followed", answeredAt: "2026-08-19T00:00:04.000Z" });

    expect(readGovernedMoment(db, path, "m1")).toMatchObject({
      opened: true,
      askedAt: "2026-08-19T00:00:03.000Z",
      answer: "not-followed",
      answeredAt: "2026-08-19T00:00:04.000Z",
      ruleReads: { r1: "2026-08-19T00:00:01.000Z" },
    });
  });

  it("refuses to record an answer nobody would keep", () => {
    const db = mkDb();
    const run: MomentRun = { path: null, writerRole: "core", runId: "run-a", seq: 0 };
    expect(() => attachMomentAnswer(db, run, { momentId: "m1", answer: "followed" })).toThrow(/spool is disabled/);
  });

  it("separates not-asked from unanswered", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const run = openMoment(path, db);
    const readAndActed = readGovernedMoment(db, path, "m1");
    // Read, acted, never asked: an agent defect. Distinct from asked-and-waiting below.
    expect(readAndActed).toMatchObject({ askedAt: null, answer: null });
    expect(Object.keys(readAndActed?.ruleReads ?? {})).toEqual(["r1"]);
    expect(readAndActed?.outcomeAt).not.toBeNull();

    attachMomentAsk(db, run, { momentId: "m1", askedAt: "2026-08-19T00:00:03.000Z" });
    const asked = readGovernedMoment(db, path, "m1");
    expect(asked).toMatchObject({ askedAt: "2026-08-19T00:00:03.000Z", answer: null });
  });
});
