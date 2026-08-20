/**
 * Joining an outcome to the moment it belongs to.
 *
 * WHY THIS IS ITS OWN PROBLEM. The host opens a moment in one process (PreToolUse) and closes it in
 * another (PostToolUse). Nothing carries the moment id across; the two events share only the host's
 * `tool_use_id` — the Claude Code hooks reference (https://code.claude.com/docs/en/hooks) lists it
 * among PreToolUse's event-specific input fields and shows it in PostToolUse's own stdin example.
 * CITED BY CONTENT, NOT BY LINE: that page moves, no copy of it lives in this repo, and a line
 * number nobody can check is not a citation. So the join cannot happen in either hook — it happens
 * at fold time, here.
 *
 * WHAT THESE TESTS ARE REALLY ABOUT: the case where the join does NOT land. A PreToolUse run is
 * typically two records, its run-start and its interception. If the interception append is
 * swallowed, that run is merely SHORT — a sequence hole is only visible when a record follows it,
 * and nothing follows the last one. The sequence is structurally blind to this loss, which makes
 * the orphan outcome the only witness that a governed moment ever happened.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BetterSqlitePort } from "../storage";
import type { StoragePort } from "../storage";
import { foldMomentSpool, observedMomentLosses, readGovernedMoment } from "../moment-ledger";

const dirs: string[] = [];
const ports: StoragePort[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-moment-join-"));
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

/** A spool line written by hand, so a test can seed a loss no live writer would produce. */
function seed(path: string, runId: string, seq: number, body: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify({ v: 1, runId, seq, ...body })}\n`);
}

const OUTCOME_SHA = "d".repeat(64);
const OUTCOME_AT = "2026-08-19T00:00:05.000Z";

function opened(toolUseId: string | null, momentId = "m1"): Record<string, unknown> {
  return {
    kind: "interception",
    momentId,
    at: "2026-08-19T00:00:00.000Z",
    toolUseId,
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
  };
}

function outcome(toolUseId: string): Record<string, unknown> {
  return { kind: "outcome", momentId: null, toolUseId, outcomeStatus: null, outcomeAt: OUTCOME_AT, outcomeSha256: OUTCOME_SHA };
}

function dump(db: StoragePort): unknown {
  return {
    moments: db.prepare(`SELECT * FROM governed_moments ORDER BY moment_id`).all(),
    losses: db
      .prepare(`SELECT kind, run_id, from_seq, to_seq, tool_use_id, outcome_at FROM moment_losses ORDER BY id`)
      .all(),
  };
}

describe("an outcome joins its moment through the host's tool call", () => {
  it("attaches the outcome to the moment that recorded the same tool call", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seed(path, "run-pre", 0, opened("toolu_1"));
    seed(path, "run-post", 0, outcome("toolu_1"));
    const folded = foldMomentSpool(db, path);
    expect(folded.unobservedInterceptionsOpened).toBe(0);
    expect(readGovernedMoment(db, path, "m1")).toMatchObject({
      toolUseId: "toolu_1",
      outcomeAt: OUTCOME_AT,
      outcomeSha256: OUTCOME_SHA,
    });
    expect(observedMomentLosses(db, path)).toEqual([]);
  });

  it("resolves in either byte order within one pass", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    // The outcome lands FIRST in the file. Resolving records in file order would report a loss that
    // the very next line disproves.
    seed(path, "run-post", 0, outcome("toolu_2"));
    seed(path, "run-pre", 0, opened("toolu_2"));
    const folded = foldMomentSpool(db, path);
    expect(folded.unobservedInterceptionsOpened).toBe(0);
    expect(readGovernedMoment(db, path, "m1")?.outcomeSha256).toBe(OUTCOME_SHA);
    expect(observedMomentLosses(db, path)).toEqual([]);
  });

  it("records a loss when the interception was never observed, and creates no moment for it", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seed(path, "run-post", 0, outcome("toolu_3"));
    const folded = foldMomentSpool(db, path);
    expect(folded.unobservedInterceptionsOpened).toBe(1);
    expect(observedMomentLosses(db, path)).toEqual([
      { kind: "unobserved-interception", toolUseId: "toolu_3", outcomeAt: OUTCOME_AT, outcomeSha256: OUTCOME_SHA },
    ]);
    // An outcome never manufactures a moment — invariant 09 holds through the fold too.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM governed_moments`).get()).toEqual({ n: 0 });
    // The sequence sees nothing wrong here, which is precisely why this second kind of loss exists.
    expect(observedMomentLosses(db, path).filter((loss) => loss.kind === "sequence-gap")).toEqual([]);
  });

  it("closes the loss and applies the held outcome when the interception turns up later", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seed(path, "run-post", 0, outcome("toolu_4"));
    expect(foldMomentSpool(db, path).unobservedInterceptionsOpened).toBe(1);

    seed(path, "run-pre", 0, opened("toolu_4"));
    const second = foldMomentSpool(db, path);
    expect(second.unobservedInterceptionsClosed).toBe(1);
    expect(observedMomentLosses(db, path)).toEqual([]);
    // The outcome was HELD on the loss row, not summarized, so closing it recovers the whole thing.
    expect(readGovernedMoment(db, path, "m1")).toMatchObject({
      outcomeAt: OUTCOME_AT,
      outcomeSha256: OUTCOME_SHA,
    });
  });

  it("does not re-report a loss that is already standing", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seed(path, "run-post", 0, outcome("toolu_5"));
    foldMomentSpool(db, path);
    const afterFirst = dump(db);

    db.prepare(`UPDATE moment_fold_cursor SET byte_offset = 0 WHERE singleton = 1`).run();
    const second = foldMomentSpool(db, path);
    expect(second.unobservedInterceptionsOpened).toBe(0);
    expect(dump(db)).toEqual(afterFirst);
  });

  it("closes a moment with no tool call as outcome-unknown rather than guessing", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    // The host documents tool_use_id as nullable, so this is a real case and not a defensive one.
    seed(path, "run-pre", 0, opened(null));
    seed(path, "run-post", 0, outcome("toolu_6"));
    foldMomentSpool(db, path);
    const moment = readGovernedMoment(db, path, "m1");
    expect(moment).toMatchObject({ opened: true, toolUseId: null });
    // Not known — and never quietly filled from the only outcome that happens to be in the file.
    expect(moment?.outcomeAt).toBeNull();
    expect(moment?.outcomeSha256).toBeNull();
    expect(observedMomentLosses(db, path)).toEqual([
      { kind: "unobserved-interception", toolUseId: "toolu_6", outcomeAt: OUTCOME_AT, outcomeSha256: OUTCOME_SHA },
    ]);
  });
});
