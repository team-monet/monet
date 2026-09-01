/**
 * The fourth fact — the one a machine may not produce.
 *
 * Applicable, Delivered and Received are mechanical. Conformance is a judgement about the act, and
 * the user makes it. So the assertions here are mostly about what the record says when the user has
 * NOT answered — because that is where the two states with different owners live, and collapsing
 * them into one "pending" bucket is the failure this surface exists to prevent:
 *
 *   `unanswered` — asked, waiting on the user. A queue. The agent did its part.
 *   `not asked`  — rules read, no question put. NOT a defect by itself: whether an action
 *                   followed is not recorded (#85 retired interception).
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";
import { renderOverview } from "../render-overview";
import { BetterSqlitePort } from "../storage";
import type { StoragePort } from "../storage";
import { UnknownMomentError, momentConformance, momentsOwingAQuestion } from "../moment-ledger";

const dirs: string[] = [];
const ports: StoragePort[] = [];
const cores: MonetCore[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-conformance-"));
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
  appendFileSync(path, `${JSON.stringify({ v: 1, runId: "run-fixture", seq: seq++, ...body })}\n`);
}

/** A moment that was intercepted, read, and acted on — the shape that owes a question. */
function readAndActed(path: string, momentId: string, at = "2026-08-19T00:00:00.000Z"): void {
  line(path, {
    kind: "interception",
    momentId,
    at,
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
  });
  line(path, { kind: "read", momentId, ruleId: "rule-a", namedStageId: "stage-1", readAt: at });
  line(path, { kind: "outcome", momentId, toolUseId: null, outcomeStatus: null, outcomeAt: at, outcomeSha256: "b".repeat(64) });
}

/**
 * A moment with rules read and NO action on the record — everything written since #85 retired
 * interception. `readAndActed` above is the other half, and the two must not be confused: the
 * whole correction here turns on which of them a claim is about.
 */
function readNoAction(path: string, momentId: string, at = "2026-08-19T00:00:00.000Z"): void {
  line(path, {
    kind: "interception", momentId, at, toolUseId: null, circle: "acme-widgets", sessionId: null,
    surface: "stage_lookup", actionSha256: null, actionRendering: null, actionChars: null,
    actionClipped: null, stageId: null, ruleIds: null, disposition: "ungoverned", deliveredRuleIds: null,
  });
  line(path, { kind: "read", momentId, ruleId: "rule-a", namedStageId: "stage-1", readAt: at });
  line(path, { kind: "outcome", momentId, toolUseId: null, outcomeStatus: null, outcomeAt: at, outcomeSha256: "b".repeat(64) });
}

function coreWithSpool(spoolPath: string): MonetCore {
  const core = new MonetCore(":memory:", { momentSpoolPath: spoolPath, defaultCircle: "acme-widgets" });
  cores.push(core);
  return core;
}

/**
 * One live rule at `stage`, so a `stage_lookup` of that stage DELIVERS something.
 *
 * The key and its instruction ship only on a response that actually carried a rule (mcp-server.ts),
 * so a test asserting on either has to look up a stage that has one. The rule's own wording stays
 * clear of every needle the assertions count — `conformance_answer`, `followed these rules` — because
 * one of them counts occurrences across the whole payload, and rule text lands in that payload.
 */
async function declareRuleAt(core: MonetCore, stage: string): Promise<void> {
  await core.declare({
    species: "rule",
    stage,
    content: "Check with the branch owner first.",
    severity: "advisory",
    scope: "domain",
    circle: "acme-widgets",
  });
}

/*
 * TWO MATCHERS, AND THE SPLIT IS THE POINT. An ABSENCE assertion cannot use the exact wording:
 * change the signal and it matches nothing, so `.toBe(false)` passes while saying nothing about
 * whether a signal fired — a green that cannot fail, which is the exact failure these tests are
 * written against. Proven, not assumed: with one matcher, reverting the wording failed only the
 * two PRESENCE tests and left both absence tests green.
 *
 * So absence matches the family (any `Monet:` notice at all — the healthy state on these surfaces
 * is silence, not "silence of one particular sentence"), and presence matches the sentence. A
 * future notice worded differently trips the absence tests loudly, which is the safe direction.
 */
const ASK_SIGNAL_ANY = "Monet: ";
const ASK_SIGNAL_PREFIX = "Monet: rules were read at";

describe("the rendered workbench does not claim an action either", () => {
  it("names the population without attributing an act or a fault to the agent", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const core = coreWithSpool(path);
    try {
      // NO ACTION ON THE RECORD — the post-#85 shape, and the one the corrected line is about.
      // `readAndActed` writes an `actionSha256`, so using it here would have exercised the other
      // half and asserted the wrong sentence.
      readNoAction(path, "never-asked-one");
      const out = renderOverview(core.overview("acme-widgets"), { color: false, width: 200 });

      // PRESENT FIRST, or every assertion below passes on an empty render.
      expect(out).toContain("never asked: 1");
      // The signal was corrected and this line was not, so the same false claim survived on the
      // one surface a human actually reads. Both halves: the claim is gone, and what replaced it
      // says what the record holds.
      expect(out).not.toContain("acted");
      expect(out).toContain("delivered rules, no question put");
    } finally {
      core.close();
    }
  });
});

describe("the four states, kept apart", () => {
  it("separates a queue owed to the user from a defect owed by the agent", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    readAndActed(path, "asked-waiting");
    readAndActed(path, "never-asked");
    line(path, { kind: "ask", momentId: "asked-waiting", askedAt: "2026-08-19T00:00:01.000Z" });

    const counts = momentConformance(db, path, "acme-widgets");
    // The whole point: these are two numbers, not one "pending".
    expect(counts.unanswered).toBe(1);
    expect(counts.notAsked).toBe(1);
    expect(counts.followed).toBe(0);
    expect(counts.notFollowed).toBe(0);
  });

  it("counts an answered moment as answered, in the direction the user gave", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    readAndActed(path, "m-followed");
    readAndActed(path, "m-broke-it");
    line(path, { kind: "ask", momentId: "m-followed", askedAt: "2026-08-19T00:00:01.000Z" });
    line(path, { kind: "ask", momentId: "m-broke-it", askedAt: "2026-08-19T00:00:01.000Z" });
    line(path, { kind: "answer", momentId: "m-followed", answer: "followed", answeredAt: "t" });
    line(path, { kind: "answer", momentId: "m-broke-it", answer: "not-followed", answeredAt: "t" });

    const counts = momentConformance(db, path, "acme-widgets");
    expect(counts).toMatchObject({ followed: 1, notFollowed: 1, unanswered: 0, notAsked: 0 });
  });

  it("owes nothing for a moment that was never read", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    // Intercepted and acted on, but the agent never read a rule — so there is nothing to have
    // followed or broken. Silence is a value, and most moments look like this.
    line(path, {
      kind: "interception",
      momentId: "silent-one",
      at: "2026-08-19T00:00:00.000Z",
      toolUseId: null,
      circle: "acme-widgets",
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
    });
    line(path, { kind: "outcome", momentId: "silent-one", toolUseId: null, outcomeStatus: null, outcomeAt: "t", outcomeSha256: "c".repeat(64) });

    expect(momentConformance(db, path, "acme-widgets").notAsked).toBe(0);
    expect(momentsOwingAQuestion(db, path, "acme-widgets", 10)).toEqual([]);
  });

  it("owes nothing for a moment that was read but has not finished", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    readAndActed(path, "done");
    // Read, but no outcome yet — the act has not happened, so no question is owed for it.
    line(path, {
      kind: "interception",
      momentId: "in-flight",
      at: "2026-08-19T00:00:00.000Z",
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
    });
    line(path, { kind: "read", momentId: "in-flight", ruleId: "rule-a", namedStageId: null, readAt: "t" });

    expect(momentsOwingAQuestion(db, path, "acme-widgets", 10)).toEqual(["done"]);
  });

  it("gives unjoinable reads a durable home that a re-fold does not inflate", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    line(path, { kind: "read", momentId: null, ruleId: "rule-a", namedStageId: null, circle: "acme-widgets", readAt: "t" });
    line(path, { kind: "read", momentId: null, ruleId: "rule-b", namedStageId: null, circle: "acme-widgets", readAt: "t" });

    expect(momentConformance(db, path, "acme-widgets").unjoinableReads).toBe(2);
    // THE REASON IT IS KEYED RATHER THAN COUNTED: the fold re-reads ranges routinely, and an
    // incremented total would double on every one of them — turning the signal that detects a
    // broken delivery into a number nobody can trust.
    db.prepare(`UPDATE moment_fold_cursor SET byte_offset = 0 WHERE singleton = 1`).run();
    expect(momentConformance(db, path, "acme-widgets").unjoinableReads).toBe(2);
  });
});

describe("the ask and the answer attach to a moment that exists", () => {
  it("records an ask and then an answer against a real moment", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    seq = 0;
    readAndActed(path, "m1");
    const core = coreWithSpool(path);

    expect(momentsOwingAQuestion(db, path, "acme-widgets", 10)).toEqual(["m1"]);
    core.recordMomentAsk("m1");
    // Asked: it has left the owed set and joined the queue.
    expect(core.momentConformance()).toMatchObject({ unanswered: 1, notAsked: 0 });
    core.recordMomentAnswer("m1", "followed");
    expect(core.momentConformance()).toMatchObject({ followed: 1, unanswered: 0, notAsked: 0 });
  });

  it("refuses an answer for a moment the record has never seen", () => {
    const path = join(mkTmp(), "moments.jsonl");
    seq = 0;
    readAndActed(path, "m1");
    const core = coreWithSpool(path);

    // Invariant 09, unsoftened: an answer attaches, it never creates. A created row would make this
    // a back door for moments the interceptor never observed.
    expect(() => core.recordMomentAnswer("no-such-moment", "followed")).toThrow(UnknownMomentError);
    expect(() => core.recordMomentAsk("no-such-moment")).toThrow(UnknownMomentError);
  });

  it("folds before it answers, so a just-spooled moment is already visible", () => {
    const path = join(mkTmp(), "moments.jsonl");
    const core = coreWithSpool(path);
    seq = 0;

    // Written to the spool by an interceptor; nothing has folded it into any database yet.
    readAndActed(path, "fresh");
    // Invariant 08: the read folds first, so this does not report an empty store.
    expect(core.momentsOwingAQuestion(10)).toEqual(["fresh"]);
  });

  it("is inert when no spool is configured", () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets" });
    cores.push(core);
    expect(core.momentConformance()).toEqual({
      followed: 0,
      notFollowed: 0,
      notAskedWithAction: 0,
      readLate: 0,
      unanswered: 0,
      notAsked: 0,
      unjoinableReads: 0,
    });
    expect(core.momentsOwingAQuestion(10)).toEqual([]);
  });
});


/**
 * THE ASK SIGNAL — the only part of this design that reaches a model's context.
 *
 * So these tests are as much about what it does NOT say as what it does: no rule content, no action
 * rendering, nothing on the overwhelming majority of responses, and never twice for one moment.
 *
 * THEY DRIVE `stage_lookup`, NOT `memory_search`, AND THAT IS THE POINT OF ONE OF THEM. The signal
 * used to ride every tool response; it now rides the ONE response that hands the agent rules,
 * because that is the only place the instruction has context to attach to. Written against
 * `memory_search`, these tests would now be asserting silence and calling it delivery.
 */
describe("the ask signal is gone, and stays gone (#147)", () => {
  async function pair(core: MonetCore): Promise<{ client: Client; cleanup: () => Promise<void> }> {
    const server = new McpServer({ name: "t", version: "1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "c", version: "1" });
    await client.connect(ct);
    return { client, cleanup: async () => { await client.close(); } };
  }

  const texts = (result: unknown): string[] =>
    ((result as { content: Array<{ type: string; text?: string }> }).content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "");

  it("appends no id-naming block, however large the standing backlog", async () => {
    const path = join(mkTmp(), "moments.jsonl");
    const core = coreWithSpool(path);
    await declareRuleAt(core, "git force push");
    const { client, cleanup } = await pair(core);
    try {
      // A BACKLOG BIG ENOUGH THAT THE OLD SIGNAL WOULD HAVE FIRED, and of both kinds — the signal
      // named up to eight, oldest-first, and partitioned them by whether an action was recorded.
      for (let i = 0; i < 5; i++) readAndActed(path, `acted-${i}`);
      for (let i = 0; i < 5; i++) readNoAction(path, `unknown-${i}`);

      const result = await client.callTool({ name: "stage_lookup", arguments: { stage: "git force push" } });
      const parts = texts(result);

      // PRESENT FIRST, or every absence below passes on a broken response. The primary mechanism is
      // untouched: the key and its instruction still ride on every lookup that returns rules.
      const body = JSON.parse(parts[0]) as { momentId?: string; instruction?: string };
      expect(body.momentId).toBeDefined();
      expect(body.instruction).toContain("conformance_answer");
      // AND NAMES NO ASK. Without this the assertion above passes under the pre-#150 instruction
      // too — it also contained `conformance_answer` — so it would guard nothing it appears to.
      expect(body.instruction).not.toContain("conformance_ask");

      // AND NOTHING NAMES THE BACKLOG. Asserted three ways, because one alone is weak: no `Monet:`
      // notice at all, no moment id from the backlog anywhere in the payload, and no extra content
      // item beyond the one the response already carried.
      const payload = parts.join("\n");
      expect(payload).not.toContain("Monet: ");
      expect(payload).not.toContain("acted-0");
      expect(payload).not.toContain("unknown-0");
      expect(parts).toHaveLength(1);

      // THE POPULATION IS STILL RECORDED — removal was of the delivery, not of the record. Eleven,
      // not ten: the lookup that would have carried the signal returns rules, so it is itself a
      // moment with a read and no question put. That is the shape that made the old backlog grow
      // faster than it could ever be cleared.
      expect(core.momentConformance().notAsked).toBe(11);
      expect(core.momentConformance().notAskedWithAction).toBe(5);
    } finally {
      await cleanup();
    }
  });
});
