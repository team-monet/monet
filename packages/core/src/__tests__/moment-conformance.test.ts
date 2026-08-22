/**
 * The fourth fact — the one a machine may not produce.
 *
 * Applicable, Delivered and Received are mechanical. Conformance is a judgement about the act, and
 * the user makes it. So the assertions here are mostly about what the record says when the user has
 * NOT answered — because that is where the two states with different owners live, and collapsing
 * them into one "pending" bucket is the failure this surface exists to prevent:
 *
 *   `unanswered` — asked, waiting on the user. A queue. The agent did its part.
 *   `not asked`  — read, acted, never asked. A defect. The agent did not.
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
 * clear of every needle the assertions count — `conformance_ask`, `followed these rules` — because
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
describe("the signal that tells the agent it owes a question", () => {
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

  it("says nothing at all when nothing is owed", async () => {
    const path = join(mkTmp(), "moments.jsonl");
    const core = coreWithSpool(path);
    // A DELIVERING LOOKUP, for the same reason the key-and-instruction round already moved its
    // sibling below off an arbitrary miss: the signal now ships only where the instruction that
    // explains it ships, and that is a lookup that actually handed over a rule. Asserted on a miss,
    // this would be silent whatever the debt was — silence proving nothing, which is the exact
    // green-that-cannot-fail these tests are written against.
    await declareRuleAt(core, "git force push");
    const { client, cleanup } = await pair(core);
    try {
      // Asserted on the surface that CAN speak. On any other tool this would be trivially silent
      // and would prove nothing about the debt being empty.
      const result = await client.callTool({ name: "stage_lookup", arguments: { stage: "git force push" } });
      // SILENCE IS THE HEALTHY STATE. Most moments are silent and owe nothing, so the ordinary
      // response carries no Monet instruction whatsoever.
      expect(texts(result).some((text) => text.includes("Monet: you read a rule"))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("rides stage_lookup and no other tool, even with a debt standing", async () => {
    const path = join(mkTmp(), "moments.jsonl");
    const core = coreWithSpool(path);
    seq = 0;
    readAndActed(path, "owed-one");
    // DELIVERING, not a miss — see the first test in this block.
    await declareRuleAt(core, "git force push");
    const { client, cleanup } = await pair(core);
    try {
      // The debt is real and unpaid — the same fixture the next test finds the signal for.
      expect(core.momentsOwingAQuestion(10)).toEqual(["owed-one"]);
      // ...and an ordinary tool response still says nothing about it. The agent is told to collect
      // confirmations where it is being handed rules; on a `memory_search` reply there is no rule
      // in front of it and the instruction is an interruption with nothing to attach to.
      for (const call of [
        { name: "memory_search", arguments: { query: "anything" } },
        { name: "memory_overview", arguments: {} },
      ]) {
        const result = await client.callTool(call);
        expect(texts(result).some((text) => text.includes("Monet: you read a rule"))).toBe(false);
      }
      // The same debt, on the one surface that carries it.
      const lookup = await client.callTool({ name: "stage_lookup", arguments: { stage: "git force push" } });
      expect(texts(lookup).some((text) => text.includes("owed-one"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("names the moment, and carries none of its content", async () => {
    const path = join(mkTmp(), "moments.jsonl");
    const core = coreWithSpool(path);
    seq = 0;
    readAndActed(path, "owed-one");
    // A DELIVERING LOOKUP, because the key and its instruction only ship when the response actually
    // carried a rule. This used to look up "nothing-here" — an arbitrary miss — and still expect the
    // instruction, which was the defect: the agent was told to ask about "these rules" when none
    // were on the response, and the `conformance_ask` it named would have been refused outright.
    // The miss was never this test's subject; the debt it asserts on comes from `readAndActed`
    // above, not from the lookup.
    await declareRuleAt(core, "git force push");
    const { client, cleanup } = await pair(core);
    try {
      const result = await client.callTool({ name: "stage_lookup", arguments: { stage: "git force push" } });
      const signal = texts(result).find((text) => text.includes("Monet: you read a rule"));
      expect(signal).toBeDefined();
      // A signal naming a moment...
      expect(signal).toContain("owed-one");
      // BOTH tools are still named on this response — on the `instruction` field that now ships
      // beside the key on every lookup, rather than in the signal that used to be the only thing
      // saying either. The naming had to survive that move, not be dropped by it: the ask is its own
      // event, and an instruction that omits it produces the F2 defect where an obedient agent is
      // counted as having never asked.
      const instruction = (JSON.parse(texts(result)[0]) as { instruction?: string }).instruction;
      expect(instruction).toContain("conformance_ask");
      expect(instruction).toContain("conformance_answer");
      // ...and NOT a payload carrying it. The agent already has the action in its own transcript;
      // re-sending it would be paying context to tell the model what it just did.
      expect(signal).not.toContain("terraform apply");
      expect(signal).not.toContain("rule-a");
      // And the wording asks whether the action FOLLOWED the rule — never whether the rule caused
      // it, which is unobservable and is not what this measures. The signal keeps the same line for
      // its own half of the sentence: read a rule, then acted.
      expect(instruction).toContain("followed these rules");
      expect(instruction?.toLowerCase()).not.toContain("because of");
      expect(signal?.toLowerCase()).not.toContain("because of");
    } finally {
      await cleanup();
    }
  });

  it("says each thing once when the standing instruction and the debt signal ride the same response", async () => {
    const path = join(mkTmp(), "moments.jsonl");
    const core = coreWithSpool(path);
    seq = 0;
    readAndActed(path, "owed-one");
    // Delivering, for the reason the previous test states: both halves can only ride one response
    // if the response is one that carries a rule at all.
    await declareRuleAt(core, "git force push");
    const { client, cleanup } = await pair(core);
    try {
      const result = await client.callTool({ name: "stage_lookup", arguments: { stage: "git force push" } });
      const parts = texts(result);
      // BOTH halves are on this one response: the standing instruction, which ships with the key on
      // every lookup, and the debt signal, which fires only because a moment is outstanding.
      const instruction = (JSON.parse(parts[0]) as { instruction?: string }).instruction;
      expect(instruction).toContain("conformance_ask");
      const signal = parts.find((text) => text.includes("Monet: you read a rule"));
      expect(signal).toContain("owed-one");

      // AND NEITHER IS A SECOND COPY OF THE OTHER. They carry different facts — what asking means,
      // and which earlier ids still need it — so the tool names, the key, and the question each
      // appear exactly ONCE across the whole payload. Two overlapping notices would be the same
      // context cost paid twice on the one response that already carries the most.
      const payload = parts.join("\n");
      const occurrences = (needle: string): number => payload.split(needle).length - 1;
      expect(occurrences("conformance_ask")).toBe(1);
      expect(occurrences("conformance_answer")).toBe(1);
      expect(occurrences("followed these rules")).toBe(1);
      // Stated from the signal's side too, so a failure says which half grew the duplicate.
      expect(signal).not.toContain("conformance_ask");
      expect(signal).not.toContain("conformance_answer");
    } finally {
      await cleanup();
    }
  });

  it("keeps naming a moment until the debt is cleared, because delivery cannot be confirmed", async () => {
    const path = join(mkTmp(), "moments.jsonl");
    const core = coreWithSpool(path);
    seq = 0;
    readAndActed(path, "owed-one");
    // DELIVERING on both calls — see the first test in this block.
    await declareRuleAt(core, "git force push");
    const { client, cleanup } = await pair(core);
    try {
      const first = await client.callTool({ name: "stage_lookup", arguments: { stage: "git force push" } });
      expect(texts(first).some((t) => t.includes("owed-one"))).toBe(true);
      const second = await client.callTool({ name: "stage_lookup", arguments: { stage: "git force push" } });
      // ANNOUNCE-ONCE WAS WRONG, and this assertion is its reversal. The signal rides as a secondary
      // content item; a host that exposes only content[0] shows it to nobody, and marking it
      // delivered anyway then counting the silence as `notAsked` is the conflation between "ignored
      // it" and "was never told" that these counts exist to remove. Nothing here can confirm
      // delivery, so the debt stays named until the agent clears it by asking.
      expect(texts(second).some((t) => t.includes("owed-one"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("still counts an ignored signal as the agent's defect", async () => {
    const path = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(path);
    seq = 0;
    readAndActed(path, "owed-one");
    // DELIVERING, and here that is the whole premise rather than a detail. This test is named for an
    // IGNORED signal, so a miss lookup — which no longer carries one — would leave it asserting that
    // a signal nobody was shown was ignored: true, and about nothing.
    await declareRuleAt(core, "git force push");
    const { client, cleanup } = await pair(core);
    try {
      const shown = await client.callTool({ name: "stage_lookup", arguments: { stage: "git force push" } });
      // THE SIGNAL WAS SHOWN, asserted rather than assumed — and then the agent did not act on it.
      expect(texts(shown).some((t) => t.includes("owed-one"))).toBe(true);
    } finally {
      await cleanup();
    }
    // TWO, and both are the same defect: the seeded debt the agent ignored, plus this lookup's own
    // moment, which delivered a rule and was likewise never asked about. The count is what makes
    // ignoring the signal mechanically detectable, which is what lets the signal be a notice rather
    // than an enforcement.
    expect(momentConformance(db, path, "acme-widgets").notAsked).toBe(2);
  });
});
