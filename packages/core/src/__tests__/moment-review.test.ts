/**
 * Findings from the Codex review of PR #63.
 *
 * Every one of these is the same class of defect this ticket exists to remove: a surface reporting a
 * value it does not have, or reporting silence where something broke. They are grouped here rather
 * than scattered so the next reader can see that class in one place.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { BetterSqlitePort } from "../storage";
import type { StoragePort } from "../storage";
import { UnknownMomentError, foldMomentSpool, momentConformance, readGovernedMoment } from "../moment-ledger";
import { MOMENT_SPOOL_READ_CHUNK_BYTES, readMomentSpool } from "../moment-spool";

const dirs: string[] = [];
const ports: StoragePort[] = [];
const cores: MonetCore[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-review-"));
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
  appendFileSync(path, `${JSON.stringify({ v: 1, runId: "run-review", seq: seq++, ...body })}\n`);
}

function readAndActed(path: string, momentId: string): void {
  line(path, {
    kind: "interception", momentId, at: "2026-08-21T00:00:00.000Z", toolUseId: null, circle: "acme-widgets", sessionId: null,
    surface: "Bash", actionSha256: "a".repeat(64), actionRendering: "terraform apply", actionChars: 15,
    actionClipped: false, stageId: "stage-1", ruleIds: ["rule-a"], disposition: "advised",
    deliveredRuleIds: [],
  });
  line(path, { kind: "read", momentId, ruleId: "rule-a", namedStageId: "stage-1", readAt: "t" });
  line(path, {
    kind: "outcome", momentId, toolUseId: null, outcomeStatus: "ok", outcomeAt: "t",
    outcomeSha256: "b".repeat(64),
  });
}

describe("P1 — a conformance write with no spool must not report success", () => {
  it("refuses an ask when no spool is configured", () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets" });
    cores.push(core);
    // The MCP handler answers `recorded: "ask"` on a silent return, telling the user their answer
    // was saved when no byte was written anywhere.
    expect(() => core.recordMomentAsk("m1")).toThrow(/spool/i);
  });

  it("refuses an answer when no spool is configured", () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets" });
    cores.push(core);
    // A conformance answer is the one datum in this system that cannot be reproduced.
    expect(() => core.recordMomentAnswer("m1", "not-followed")).toThrow(/spool/i);
  });
});

describe("P1 — an unreadable spool is not a missing one", () => {
  it("surfaces a permission failure instead of reporting zero activity", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    writeFileSync(path, "");
    chmodSync(path, 0o000);
    try {
      // Broken recording indistinguishable from healthy inactivity is the incident this whole
      // subsystem was built after.
      expect(() => readMomentSpool(path, 0)).toThrow();
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("still treats a genuinely absent spool as the ordinary pre-first-append state", () => {
    const read = readMomentSpool(join(mkTmp(), "never-created.jsonl"), 0);
    expect(read).toMatchObject({ records: [], nextCursor: 0 });
  });
});

describe("P2 — the cursor does not step over records a later reader must fold", () => {
  it("stops at a future-version line rather than skipping past it", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    seq = 0;
    line(path, { kind: "run-start", writerRole: "core", at: "t" });
    appendFileSync(path, `${JSON.stringify({ v: 99, runId: "run-review", seq: 1, kind: "something-new" })}\n`);
    line(path, { kind: "ask", momentId: "m1", askedAt: "t" });

    const read = readMomentSpool(path, 0);
    expect(read.futureVersionLines).toBe(1);
    // Advancing past it makes that data permanently absent from the ledger once the build that
    // understands it arrives: nothing ever reads it, and nothing says so.
    const bytesBeforeFuture = `${JSON.stringify({ v: 1, runId: "run-review", seq: 0, kind: "run-start", writerRole: "core", at: "t" })}\n`.length;
    expect(read.nextCursor).toBe(bytesBeforeFuture);
  });
});

describe("P2 — conformance writes require something to judge", () => {
  it("refuses an ask for a moment with no read", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    seq = 0;
    // A silent moment: intercepted and acted on, nothing read. Nothing to have followed.
    line(path, {
      kind: "interception", momentId: "silent", at: "2026-08-21T00:00:00.000Z", toolUseId: null, circle: "acme-widgets",
      sessionId: null, surface: "Bash", actionSha256: "a".repeat(64), actionRendering: "git status",
      actionChars: 10, actionClipped: false, stageId: null, ruleIds: [], disposition: "silent",
      deliveredRuleIds: [],
    });
    line(path, {
      kind: "outcome", momentId: "silent", toolUseId: null, outcomeStatus: "ok", outcomeAt: "t",
      outcomeSha256: "c".repeat(64),
    });
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    expect(() => core.recordMomentAsk("silent")).toThrow(UnknownMomentError);
  });

  it("refuses an ask for a blocked moment, which by design never acts", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    seq = 0;
    line(path, {
      kind: "interception", momentId: "blocked", at: "2026-08-21T00:00:00.000Z", toolUseId: null, circle: "acme-widgets",
      sessionId: null, surface: "Bash", actionSha256: "a".repeat(64), actionRendering: "git push --force",
      actionChars: 16, actionClipped: false, stageId: "s1", ruleIds: ["rule-a"], disposition: "blocked",
      deliveredRuleIds: ["rule-a"],
    });
    line(path, { kind: "read", momentId: "blocked", ruleId: "rule-a", namedStageId: "s1", readAt: "t" });
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    // Its id IS handed to the agent in the deny instruction, so it can be asked about — and it has
    // no outcome by design, so there is no completed action for a user to judge.
    expect(() => core.recordMomentAsk("blocked")).toThrow(UnknownMomentError);
  });

  it("accepts an ask for a moment that was read and acted on", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    seq = 0;
    readAndActed(path, "m1");
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    expect(() => core.recordMomentAsk("m1")).not.toThrow();
  });
});

describe("P2 — a conflicting second answer is refused, not silently dropped", () => {
  it("throws rather than echoing a replacement the tally ignored", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    const db = mkDb();
    seq = 0;
    readAndActed(path, "m1");
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    core.recordMomentAsk("m1");
    core.recordMomentAnswer("m1", "followed");

    // COALESCE keeps the first value; the tool returned a success payload naming the second. The
    // durable tally then disagrees with what the user was told.
    expect(() => core.recordMomentAnswer("m1", "not-followed")).toThrow(/already/i);
    expect(momentConformance(db, path, "acme-widgets")).toMatchObject({ followed: 1, notFollowed: 0 });
  });

  it("accepts a repeat of the SAME answer, which asserts nothing new", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    seq = 0;
    readAndActed(path, "m2");
    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    core.recordMomentAsk("m2");
    core.recordMomentAnswer("m2", "followed");
    expect(() => core.recordMomentAnswer("m2", "followed")).not.toThrow();
  });
});

describe("P1 — the fold does not allocate the whole spool", () => {
  it("folds a spool larger than one chunk without materializing it at once", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    const db = mkDb();
    seq = 0;
    // Comfortably more than one bounded chunk, so a single-buffer read would be visible.
    for (let i = 0; i < 15000; i += 1) {
      line(path, { kind: "ask", momentId: `m${i}`, askedAt: "t" });
    }
    const { size } = statSync(path);
    expect(size).toBeGreaterThan(MOMENT_SPOOL_READ_CHUNK_BYTES);

    // ONE READ IS BOUNDED. Without this the buffer is the whole remaining spool, which on a fresh
    // store replaying all of history is an ordinary MCP read allocating the entire file.
    const oneRead = readMomentSpool(path, 0);
    expect(oneRead.nextCursor).toBeLessThan(size);
    expect(oneRead.nextCursor).toBeLessThanOrEqual(MOMENT_SPOOL_READ_CHUNK_BYTES);

    // AND THE FOLD IS STILL COMPLETE: bounding memory must not bound WORK, or a fresh store would
    // be permanently behind on a spool nothing reclaims.
    const folded = foldMomentSpool(db, path);
    expect(folded.recordsFolded).toBe(15000);
    expect(readGovernedMoment(db, path, "m14999")).not.toBeNull();
  });
});


describe("P1 — moment counts are scoped to the circle the overview asked for", () => {
  function interception(path: string, momentId: string, circle: string | null): void {
    line(path, {
      kind: "interception", momentId, at: "2026-08-21T00:00:00.000Z", toolUseId: null, sessionId: null,
      circle, surface: "Bash", actionSha256: "a".repeat(64), actionRendering: "terraform apply",
      actionChars: 15, actionClipped: false, stageId: "s1", ruleIds: ["rule-a"], disposition: "advised",
      deliveredRuleIds: [],
    });
  }

  it("does not report another circle's activity", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    const db = mkDb();
    seq = 0;
    interception(path, "mine", "acme-widgets");
    // The spool is HOME-LEVEL and shared, so a second project's moments land in this store's fold.
    interception(path, "theirs", "other-project");
    foldMomentSpool(db, path);

    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    expect(core.momentCounts("acme-widgets").fires).toBe(1);
    expect(core.momentCounts("other-project").fires).toBe(1);
  });

  it("counts a moment whose circle was never known as unattributed, not as this circle's", () => {
    const dir = mkTmp();
    const path = join(dir, "moments.jsonl");
    const db = mkDb();
    seq = 0;
    interception(path, "mine", "acme-widgets");
    // The gate failed before resolving a circle, or the hook had none pinned. Excluding it must not
    // hide it: an unattributable moment is a real observation with a missing field.
    interception(path, "unknown", null);
    foldMomentSpool(db, path);

    const core = new MonetCore(":memory:", { momentSpoolPath: path, defaultCircle: "acme-widgets" });
    cores.push(core);
    const counts = core.momentCounts("acme-widgets");
    expect(counts.fires).toBe(1);
    expect(counts.unattributed).toBe(1);
  });
});
