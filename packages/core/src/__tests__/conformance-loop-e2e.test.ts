/**
 * THE WHOLE LOOP, ONCE, THROUGH THE REAL SURFACE.
 *
 * Every link in the conformance cycle already has its own unit test, and until this file existed
 * the CYCLE had never run: a stage declared, its rules looked up, the key handed back, the question
 * asked, the user's answer recorded, and the debt cleared. Each of those tests holds one link at
 * arm's length with a hand-written spool fixture, which is exactly the shape that can stay green
 * while the chain between them is broken — a momentId that never reaches the response, an ask that
 * attaches to nothing, an answer that does not persist. Nothing here is a fixture: a real
 * `MonetCore` over a real spool file, the real `registerMonetCoreTools` roster, a real MCP client
 * over an in-memory transport, and every fact read back out of the durable record afterwards.
 *
 * READ BACK THROUGH A SECOND, INDEPENDENT DATABASE. `auditDb` never sees a write from these calls;
 * it folds the same spool FILE the server wrote to. So an assertion here is a claim about what
 * landed on disk, not about what one process happens to be holding in memory — the distinction the
 * spool exists to make, and the one an in-process read would quietly erase.
 *
 * THE ORDER OF THE ASSERTIONS IS THE ORDER OF THE CHAIN, and each step asserts the state BEFORE it
 * as well as the state after. Step 5 ("no longer owes a question") is worthless without step 3's
 * "it owed one a moment ago": an id that was never in the list disappears from it for free.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";
import { BetterSqlitePort } from "../storage";
import type { StoragePort } from "../storage";
import { readGovernedMoment } from "../moment-ledger";
import type { GovernedMomentRow } from "../moment-ledger";

const CIRCLE = "acme-widgets";
const STAGE = "deploying to production";

const dirs: string[] = [];
const cores: MonetCore[] = [];
const ports: StoragePort[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const core of cores.splice(0)) core.close();
  for (const port of ports.splice(0)) port.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Loop {
  client: Client;
  core: MonetCore;
  /** Reads the durable record without ever writing to it. See this file's header. */
  moment: (momentId: string) => GovernedMomentRow | null;
}

/** A real core, a real spool file, the real tool roster, a real MCP client. No fixtures. */
async function loop(): Promise<Loop> {
  const dir = mkdtempSync(join(tmpdir(), "monet-loop-e2e-"));
  dirs.push(dir);
  const spoolPath = join(dir, "moments.jsonl");
  const core = new MonetCore(":memory:", { momentSpoolPath: spoolPath, defaultCircle: CIRCLE });
  cores.push(core);
  const server = new McpServer({ name: "monet-core-e2e", version: "1" }, { capabilities: { tools: {} } });
  // autoPrewarm off so the assertions read the tool's own payload rather than a session-start block.
  registerMonetCoreTools(server, core, { autoPrewarm: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "e2e-client", version: "1" });
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); });
  const auditDb = new BetterSqlitePort(":memory:");
  ports.push(auditDb);
  return { client, core, moment: (momentId) => readGovernedMoment(auditDb, spoolPath, momentId) };
}

const texts = (result: unknown): string[] =>
  ((result as { content: Array<{ type: string; text?: string }> }).content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "");

/** content[0] is always the pure JSON payload — the same contract every other caller relies on. */
function payload(result: unknown): Record<string, unknown> {
  const first = texts(result)[0];
  expect(first, "the tool returned no text content").toBeDefined();
  return JSON.parse(first!) as Record<string, unknown>;
}

function expectOk(result: unknown, what: string): void {
  expect((result as { isError?: boolean }).isError ?? false, `${what} returned an error: ${texts(result).join("\n")}`)
    .toBe(false);
}

/**
 * STEP 1 — a stage with rules, declared the way a user declares one.
 *
 * TWO RULES, NOT ONE, and that is load-bearing rather than thorough: the `not-followed` follow-up
 * exists precisely because a moment normally delivers several rules and neither the response nor
 * the agent can tell which one the user meant. A single-rule fixture would make that instruction
 * look redundant and would let a version that guesses pass.
 */
async function declareStageWithRules(client: Client): Promise<string[]> {
  const stage = await client.callTool({
    name: "memory_declare",
    arguments: { species: "stage", stage: STAGE, patterns: ["terraform apply"] },
  });
  expectOk(stage, "memory_declare(stage)");

  const conceptIds: string[] = [];
  for (const { content, reason } of [
    {
      content: "Run the plan and show it to the user before applying.",
      reason: "An unreviewed apply can destroy live infrastructure.",
    },
    {
      content: "Name the environment out loud before you apply.",
      reason: "Applying to the wrong environment is not recoverable.",
    },
  ]) {
    const rule = await client.callTool({
      name: "memory_declare",
      // `domain` scope so no model tag is required — the loop under test is the same either way.
      arguments: { species: "rule", stage: STAGE, content, reason, scope: "domain" },
    });
    expectOk(rule, "memory_declare(rule)");
    conceptIds.push((payload(rule) as { conceptId: string }).conceptId);
  }
  expect(conceptIds).toHaveLength(2);
  return conceptIds;
}

/**
 * STEP 2 — the lookup that hands the agent the rules AND the key to answer about them.
 *
 * Returns the momentId, having asserted everything the response owes: the rules themselves, the key,
 * the instruction that says what the key is for, and — read back out of the record — that the rules
 * this response carried were credited as READ against this very moment. That last one is the link
 * nothing else in the chain can substitute for: without a recorded read there is nothing to owe a
 * question about, and the rest of the cycle would refuse.
 */
async function lookupAndAssert(loopUnderTest: Loop, ruleIds: readonly string[]): Promise<string> {
  const result = await loopUnderTest.client.callTool({ name: "stage_lookup", arguments: { stage: STAGE } });
  expectOk(result, "stage_lookup");
  const body = payload(result) as {
    matched?: boolean;
    momentId?: string;
    instruction?: string;
    rules?: Array<{ conceptId: string; text: string; reason: string | null }>;
  };

  // THE RULES. A lookup that matched a stage and returned nothing is a broken link that still
  // serializes cleanly, so the rules are asserted by identity, not by count alone.
  expect(body.matched).toBe(true);
  expect(body.rules?.map((rule) => rule.conceptId).sort()).toEqual([...ruleIds].sort());
  for (const rule of body.rules ?? []) expect(rule.reason).toBeTruthy();

  // THE KEY. Nothing else in this system hands one out; without it the two conformance tools have
  // no argument an agent could honestly supply.
  expect(typeof body.momentId, "stage_lookup returned no momentId — the chain stops here").toBe("string");
  expect(body.momentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // WHAT THE KEY IS FOR. Both tools named — naming only the answer leaves an obedient agent's
  // `asked_at` null and counts it as a defect it did not commit.
  expect(body.instruction).toContain("conformance_ask");
  expect(body.instruction).toContain("conformance_answer");
  expect(body.instruction).toContain("followed these rules");
  // It asks whether the action FOLLOWED the rule, never whether the rule CAUSED it.
  expect(body.instruction?.toLowerCase()).not.toContain("because");
  expect(body.instruction?.toLowerCase()).not.toContain("caused");

  // RECEIVED, IN THE DURABLE RECORD. The read is recorded over the rules this response actually
  // carried, so this is also the assertion that the response and the record agree.
  const recorded = loopUnderTest.moment(body.momentId!);
  expect(recorded?.opened).toBe(true);
  expect(Object.keys(recorded?.ruleReads ?? {}).sort()).toEqual([...ruleIds].sort());
  // And the call closed: an ask cannot attach to a moment that never produced an outcome.
  expect(recorded?.outcomeAt).not.toBeNull();

  return body.momentId!;
}

describe("the conformance loop, end to end", () => {
  it("closes the cycle on a `followed` answer, and clears the debt", async () => {
    const l = await loop();
    const ruleIds = await declareStageWithRules(l.client);
    const momentId = await lookupAndAssert(l, ruleIds);

    // STEP 3 — the debt exists BEFORE the ask. Without this, step 5 proves nothing.
    expect(l.core.momentsOwingAQuestion(50)).toContain(momentId);
    expect(l.core.momentConformance()).toMatchObject({ followed: 0, notFollowed: 0, unanswered: 0, notAsked: 1 });
    expect(l.moment(momentId)?.askedAt).toBeNull();

    // STEP 3 — the ask lands.
    const ask = await l.client.callTool({ name: "conformance_ask", arguments: { momentId } });
    expectOk(ask, "conformance_ask");
    expect(payload(ask)).toMatchObject({ recorded: "ask", momentId });
    expect(l.moment(momentId)?.askedAt, "conformance_ask did not persist asked_at").not.toBeNull();
    // The moment moved from the agent's defect to the user's queue — two states, not one "pending".
    expect(l.core.momentConformance()).toMatchObject({ unanswered: 1, notAsked: 0 });

    // STEP 4 — the answer lands.
    const answer = await l.client.callTool({
      name: "conformance_answer",
      arguments: { momentId, answer: "followed" },
    });
    expectOk(answer, "conformance_answer");
    expect(payload(answer)).toMatchObject({ recorded: "answer", momentId, answer: "followed" });
    const settled = l.moment(momentId);
    expect(settled?.answer, "conformance_answer did not persist the answer").toBe("followed");
    expect(settled?.answeredAt, "conformance_answer did not persist answered_at").not.toBeNull();

    // STEP 5 — answered, and the debt is gone.
    expect(l.core.momentConformance()).toMatchObject({ followed: 1, notFollowed: 0, unanswered: 0, notAsked: 0 });
    expect(l.core.momentsOwingAQuestion(50)).not.toContain(momentId);

    // STEP 6, the silent arm. A `followed` answer has nothing to follow up, so it carries nothing
    // extra — asking every time is pure context cost on the arm that is supposed to be quiet.
    expect(payload(answer)).not.toHaveProperty("instruction");
  });

  it("closes the cycle on a `not-followed` answer, and sends the result to the rule", async () => {
    const l = await loop();
    const ruleIds = await declareStageWithRules(l.client);
    const momentId = await lookupAndAssert(l, ruleIds);

    expect(l.core.momentsOwingAQuestion(50)).toContain(momentId);
    expectOk(await l.client.callTool({ name: "conformance_ask", arguments: { momentId } }), "conformance_ask");
    expect(l.moment(momentId)?.askedAt).not.toBeNull();

    const answer = await l.client.callTool({
      name: "conformance_answer",
      arguments: { momentId, answer: "not-followed" },
    });
    expectOk(answer, "conformance_answer");
    const body = payload(answer) as { answer?: string; instruction?: string };
    expect(body.answer).toBe("not-followed");

    const settled = l.moment(momentId);
    expect(settled?.answer).toBe("not-followed");
    expect(settled?.answeredAt).not.toBeNull();
    expect(l.core.momentConformance()).toMatchObject({ followed: 0, notFollowed: 1, unanswered: 0, notAsked: 0 });
    expect(l.core.momentsOwingAQuestion(50)).not.toContain(momentId);

    // THE FOLLOW-UP. A `not-followed` that stops at a tally entry is a dead end: nothing says which
    // rule was broken, and the outcome that should come of a rule being broken — changing it, or
    // retiring it — has no prompt and no home.
    expect(body.instruction, "a `not-followed` answer carried no follow-up instruction").toBeDefined();
    // IT ASKS WHICH RULE. The moment delivered two; guessing, or recording against both, would
    // manufacture a verdict against a rule that was followed.
    expect(body.instruction).toContain("which of the rules");
    // AND THE RESULT GOES ON THE RULE, not into a note field beside the answer.
    expect(body.instruction).toContain("rule's own record");
    // ONE LINE, and the same wording discipline as the lookup's instruction: the ACTION did not
    // follow the rule; nothing here claims the rule caused, or failed to cause, anything.
    expect(body.instruction).not.toContain("\n");
    expect(body.instruction?.toLowerCase()).not.toContain("because");
    expect(body.instruction?.toLowerCase()).not.toContain("caused");
    // NO BAKED-IN CALL SEQUENCE. It names where the record belongs; the agent knows its own tools,
    // and a procedure copied into a payload rots the first time the surface moves.
    for (const toolName of ["memory_declare", "memory_store", "memory_retire", "memory_ratify"]) {
      expect(body.instruction).not.toContain(toolName);
    }
  });

  it("carries the follow-up on the not-followed arm and nothing extra on the followed arm", async () => {
    // BOTH ARMS IN ONE STORE, so the difference cannot be an artifact of two different fixtures.
    // Two lookups mint two distinct moments, and each is settled independently.
    const l = await loop();
    const ruleIds = await declareStageWithRules(l.client);

    const first = await lookupAndAssert(l, ruleIds);
    const second = await lookupAndAssert(l, ruleIds);
    expect(first).not.toBe(second);
    expect(l.core.momentsOwingAQuestion(50)).toEqual(expect.arrayContaining([first, second]));

    for (const momentId of [first, second]) {
      expectOk(await l.client.callTool({ name: "conformance_ask", arguments: { momentId } }), "conformance_ask");
      // Asserted here too, not just in the two single-arm tests above: an answer attaches to a
      // moment whether or not it was ever asked about, so a contrast test that only called the ask
      // tool would stay green while the ask link was severed.
      expect(l.moment(momentId)?.askedAt, "conformance_ask did not persist asked_at").not.toBeNull();
    }
    const followed = await l.client.callTool({
      name: "conformance_answer",
      arguments: { momentId: first, answer: "followed" },
    });
    const notFollowed = await l.client.callTool({
      name: "conformance_answer",
      arguments: { momentId: second, answer: "not-followed" },
    });

    expect(payload(followed)).not.toHaveProperty("instruction");
    expect(payload(notFollowed)).toHaveProperty("instruction");

    // Both settled, in the direction the user gave, and neither owes anything further.
    expect(l.moment(first)?.answer).toBe("followed");
    expect(l.moment(second)?.answer).toBe("not-followed");
    expect(l.core.momentConformance()).toMatchObject({ followed: 1, notFollowed: 1, unanswered: 0, notAsked: 0 });
    expect(l.core.momentsOwingAQuestion(50)).toEqual([]);
  });

  it("withholds the backlog on the one response that cannot explain it, and names it again on the next that can", async () => {
    // THE TWO HALVES ONLY WORK TOGETHER. The response's `instruction` says what asking means and
    // which two tools take the key; the appended backlog says WHICH earlier moments had no question
    // put. Candidates, not debts — the record does not say whether an action followed any of them.
    // Neither is a copy of the other, which is exactly why neither stands alone: a bare list of
    // uuids, on a response whose instruction was deliberately withheld, is not a reminder the agent
    // can act on — nothing on it, or anywhere else, names a tool that takes them.
    const l = await loop();
    const ruleIds = await declareStageWithRules(l.client);
    const owed = await lookupAndAssert(l, ruleIds);
    expect(l.core.momentsOwingAQuestion(50)).toContain(owed);

    // A LOOKUP THAT DELIVERS NO RULE. The key and its instruction are withheld here by design (a
    // conformance_ask against it is guaranteed to be refused), and that is the condition.
    const miss = await l.client.callTool({ name: "stage_lookup", arguments: { stage: "a moment nobody ever declared" } });
    expectOk(miss, "stage_lookup(miss)");
    expect(payload(miss)).not.toHaveProperty("momentId");
    expect(payload(miss)).not.toHaveProperty("instruction");
    // Asserted over EVERY content item, not just the payload: the backlog rides as a later text
    // item precisely so it survives beside the JSON, so checking content[0] alone would prove
    // nothing about it.
    expect(texts(miss).join("\n")).not.toContain(owed);

    // AND NOT LOST. The debt is persistent and clears only by asking, so the next lookup that DOES
    // hand over rules names it again — beside the instruction that says what to do with it.
    const hit = await l.client.callTool({ name: "stage_lookup", arguments: { stage: STAGE } });
    expectOk(hit, "stage_lookup(hit)");
    expect(payload(hit).instruction).toContain("conformance_ask");
    expect(texts(hit).join("\n")).toContain(owed);
  });
});
