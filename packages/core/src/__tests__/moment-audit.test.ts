/**
 * Defects found by an independent audit that ran the system instead of reading it.
 *
 * WHY THIS FILE EXISTS SEPARATELY. The rest of the moment suite was green alongside every one of
 * these. That is the finding about the suite, not just about the code: the existing tests exercise
 * each mechanism at the seam it was built at, and none of them asked what the SURFACES actually
 * report over a population built the way a real session builds one. Every test here starts from a
 * state the auditor observed, not from a shape convenient to the mechanism under test.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { BetterSqlitePort } from "../storage";
import type { StoragePort } from "../storage";
import {
  UnknownMomentError,
  foldMomentSpool,
  momentConformance,
  momentCounts,
  momentsOwingAQuestion,
} from "../moment-ledger";
import { renderOverview } from "../render-overview";

const dirs: string[] = [];
const ports: StoragePort[] = [];
const cores: MonetCore[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-audit-"));
  dirs.push(dir);
  return dir;
};
const mkDb = (): StoragePort => {
  const db = new BetterSqlitePort(":memory:");
  ports.push(db);
  return db;
};
afterEach(() => {
  for (const core of cores.splice(0)) core.close();
  for (const port of ports.splice(0)) port.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function line(path: string, body: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify({ v: 1, runId: "run-audit", seq: seq++, ...body })}\n`);
}

function interception(path: string, momentId: string, overrides: Record<string, unknown> = {}): void {
  line(path, {
    kind: "interception",
    momentId,
    at: "2026-08-20T00:00:00.000Z",
    toolUseId: null,
    circle: "acme-widgets",
    sessionId: null,
    surface: "Bash",
    actionSha256: "a".repeat(64),
    actionRendering: "terraform apply",
    actionChars: 15,
    actionClipped: false,
    stageId: "stage-1",
    ruleIds: ["rule-a"],
    disposition: "advised",
    deliveredRuleIds: [],
    ...overrides,
  });
}

function readAndActed(path: string, momentId: string): void {
  interception(path, momentId);
  line(path, { kind: "read", momentId, ruleId: "rule-a", namedStageId: "stage-1", readAt: "t" });
  line(path, { kind: "outcome", momentId, toolUseId: null, outcomeStatus: null, outcomeAt: "t", outcomeSha256: "b".repeat(64) });
}

/**
 * The other half, and the distinction the all-clear now turns on: rules read with NO action on the
 * record — everything written since #85 retired interception.
 */
function readNoAction(path: string, momentId: string): void {
  interception(path, momentId, {
    surface: "stage_lookup", actionSha256: null, actionRendering: null, actionChars: null,
    actionClipped: null, stageId: null, ruleIds: null, disposition: "ungoverned", deliveredRuleIds: null,
  });
  line(path, { kind: "read", momentId, ruleId: "rule-a", namedStageId: "stage-1", readAt: "t" });
  line(path, { kind: "outcome", momentId, toolUseId: null, outcomeStatus: null, outcomeAt: "t", outcomeSha256: "b".repeat(64) });
}

describe("F2 — an answered moment is not also an unasked one", () => {
  it("does not count one moment as both followed and notAsked", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    readAndActed(path, "m1");
    // The agent obeyed the signal literally: it asked the user out loud and recorded the reply.
    // Nothing told it to call conformance_ask, so `asked_at` stays null.
    line(path, { kind: "answer", momentId: "m1", answer: "followed", answeredAt: "t" });

    const counts = momentConformance(db, path, "acme-widgets");
    expect(counts.followed).toBe(1);
    // AN ANSWER IS PROOF AN ASK HAPPENED. Counting this moment as an agent defect reports a
    // failure that did not occur, to a human, with a named owner.
    expect(counts.notAsked).toBe(0);
  });

  it("stops owing a question once it has been answered", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    readAndActed(path, "m1");
    line(path, { kind: "answer", momentId: "m1", answer: "followed", answeredAt: "t" });
    // Otherwise the ask signal names it forever, and every restart re-announces a closed moment.
    expect(momentsOwingAQuestion(db, path, "acme-widgets", 10)).toEqual([]);
  });
});

describe("F3 — debris is not a governed moment", () => {
  /** An outcome whose interception was swallowed: the row exists, `opened` is 0, `at` is NULL. */
  function debris(path: string, momentId: string): void {
    line(path, { kind: "outcome", momentId, toolUseId: null, outcomeStatus: null, outcomeAt: "t", outcomeSha256: "c".repeat(64) });
    line(path, { kind: "read", momentId, ruleId: "rule-a", namedStageId: "stage-1", readAt: "t" });
  }

  it("keeps debris out of the counts", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    interception(path, "real");
    debris(path, "debris");

    const counts = momentCounts(db, path, "acme-widgets");
    // The schema's own comment says a debris row "is not a governed moment and must never be
    // counted as one". Nothing read `opened` until now.
    expect(counts.total).toBe(1);
  });

  it("does not report debris to a human as an agent defect", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    debris(path, "debris");
    expect(momentConformance(db, path, "acme-widgets").notAsked).toBe(0);
  });

  it("does not feed debris into a model's context as a moment to ask about", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    readAndActed(path, "real-one");
    debris(path, "debris");
    // ORDER BY at puts debris (at IS NULL) at the HEAD of an oldest-first backlog, so it is not
    // merely included — it is served first.
    expect(momentsOwingAQuestion(db, path, "acme-widgets", 10)).toEqual(["real-one"]);
  });

  it("reports how much debris there is, as its own number", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    interception(path, "real");
    debris(path, "debris");
    // Excluding debris from the counts must not make it invisible: a swallowed interception is a
    // real loss and the record has to be able to say how many it is holding.
    expect(momentCounts(db, path, "acme-widgets").unopened).toBe(1);
  });
});

describe("F7 — a read that returned no rules is still a read", () => {
  it("records a stage_lookup that matched nothing", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);

    // A miss, and a stage-hit-with-no-live-rules, both return zero rules. The attempt is the
    // numerator a recognition-rate needs, and moment_reads' own comment claims EVERY read.
    core.recordRuleReads("m1", [], "stage-asked-for");
    foldMomentSpool(db, path);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM moment_reads`).get()).toEqual({ n: 1 });
    // The stage the agent asked for is still attributed, which is what makes a never-looked-up
    // stage distinguishable from one that is looked up and simply has nothing bound.
    expect(db.prepare(`SELECT named_stage_id AS s FROM moment_reads`).get()).toEqual({ s: "stage-asked-for" });
  });
});


/**
 * RE-AUDIT. The first round scoped every POPULATION to `opened = 1` and stopped there — the two
 * entry points that let a moment be answered still accepted a debris row. That did not remove the
 * defect, it inverted it: the row used to be over-counted and now it is un-counted, and what gets
 * lost is a user's own answer, which is the one datum in this system no machine can reproduce.
 */
describe("R1 — an answer can never land somewhere nothing reads", () => {
  /** A moment whose interception append was genuinely swallowed: read and outcome, no interception. */
  function debris(path: string, momentId: string): void {
    line(path, { kind: "read", momentId, ruleId: "rule-a", namedStageId: "stage-1", readAt: "t" });
    line(path, { kind: "outcome", momentId, toolUseId: null, outcomeStatus: null, outcomeAt: "t", outcomeSha256: "c".repeat(64) });
  }

  it("refuses an ask against a moment nobody intercepted", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    debris(path, "debris");
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    void db;
    // Loudly refused beats quietly lost: the agent gets an error it can put to the user.
    expect(() => core.recordMomentAsk("debris")).toThrow(UnknownMomentError);
  });

  it("refuses an answer against a moment nobody intercepted, rather than storing it unreadably", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    debris(path, "debris");
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);

    expect(() => core.recordMomentAnswer("debris", "not-followed")).toThrow(UnknownMomentError);

    // AND NOTHING WAS WRITTEN. The failure this replaces accepted the call, put the answer on disk,
    // and then reported {followed:0, notFollowed:0, unanswered:0, notAsked:0} — a user saying "the
    // rule was not followed", durable and invisible to every reader.
    const counts = momentConformance(db, path, "acme-widgets");
    expect(counts).toMatchObject({ followed: 0, notFollowed: 0, unanswered: 0, notAsked: 0 });
    const stored = db.prepare(`SELECT answer FROM governed_moments WHERE moment_id = 'debris'`).get();
    expect(stored).toEqual({ answer: null });
  });
});

describe("R2 — the all-clear does not print over a reported loss", () => {
  it("stays silent about curation work while debris is on the page", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    line(path, { kind: "outcome", momentId: "d1", toolUseId: null, outcomeStatus: null, outcomeAt: "t", outcomeSha256: "c".repeat(64) });
    line(path, { kind: "outcome", momentId: "d2", toolUseId: null, outcomeStatus: null, outcomeAt: "t", outcomeSha256: "d".repeat(64) });
    foldMomentSpool(db, path);

    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    const rendered = renderOverview(core.overview("acme-widgets"), { color: false });

    // The renderer already prints this in its needs-attention colour...
    expect(rendered).toContain("never observed");
    // ...so printing the all-clear two lines under it tells a human both things at once.
    expect(rendered).not.toContain("no curation work queued");
  });
});


describe("G2 — the all-clear stays reachable", () => {
  it("keeps the all-clear when a read moment records NO action", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    // THE SAME SHAPE AS THE UNJOINABLE-READ CASE ABOVE, and it arrived the same way. This half of
    // `notAsked` only grows — nothing removes a moment but asking — and its benign normal case is a
    // lookup made to READ rules, where nothing is recorded to have followed and there is nothing to
    // ask about. While the whole population sat in the all-clear list, one such lookup retired
    // "no curation work queued" for the life of the store, with nothing a human could act on.
    readNoAction(path, "read-never-asked");
    foldMomentSpool(db, path);
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    const rendered = renderOverview(core.overview("acme-widgets"), { color: false });

    // BOTH HALVES. The population is still reported — dropping it from the lists must not drop it
    // from the page — and the all-clear survives it.
    expect(rendered).toContain("not recorded: 1");
    expect(rendered).toContain("no curation work queued");
  });

  it("SUPPRESSES the all-clear when the read moment records an action", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    // THE PAIR TO THE TEST ABOVE, and without it that one proves only that the all-clear can print.
    // A store upgraded across #85 holds moments that DO carry an action, and on those a missing
    // question is real debt. Dropping the whole population from the all-clear gate — rather than
    // the unknown-action half — would print "no curation work queued" straight over it.
    readAndActed(path, "acted-never-asked");
    foldMomentSpool(db, path);
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    const rendered = renderOverview(core.overview("acme-widgets"), { color: false });

    expect(rendered).toContain("read, acted on, nothing recorded");
    expect(rendered).not.toContain("no curation work queued");
  });

  it("keeps the all-clear after an ordinary agent_context lookup", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    // The DOCUMENTED NORMAL CASE: stage_lookup reached from agent_context, no interception behind
    // it. moment_reads has no DELETE anywhere, so this count only ever grows — suppressing the
    // all-clear on it made "no curation work queued" unreachable for the life of the store after
    // one lookup, with zero moments, zero losses, and nothing a human could act on.
    line(path, { kind: "read", momentId: null, ruleId: "rule-a", namedStageId: "stage-1", circle: "acme-widgets", readAt: "t" });
    foldMomentSpool(db, path);
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    const rendered = renderOverview(core.overview("acme-widgets"), { color: false });

    expect(rendered).toContain("no curation work queued");
    // And it does not open the GATE section on its own: it is dim and informational, so it rides
    // inside the section when something else opens it.
    expect(rendered).not.toContain("named no moment");
  });

  it("still shows the count when something else opens the section", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    line(path, { kind: "read", momentId: null, ruleId: "rule-a", namedStageId: "stage-1", circle: "acme-widgets", readAt: "t" });
    // Debris opens the section; the unjoinable count rides along rather than being lost.
    line(path, { kind: "outcome", momentId: "d1", toolUseId: null, outcomeStatus: null, outcomeAt: "t", outcomeSha256: "c".repeat(64) });
    foldMomentSpool(db, path);
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    const rendered = renderOverview(core.overview("acme-widgets"), { color: false });

    expect(rendered).toContain("never observed");
    expect(rendered).toContain("named no moment");
    expect(rendered).not.toContain("no curation work queued");
  });
});
