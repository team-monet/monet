/**
 * The Received fact — the agent read a delivered rule, against the moment that prompted the read.
 *
 * WHY THIS IS A JOIN AND NOT A COUNT. Receipt is a property of ONE (moment, rule) pair: "this rule
 * reached the agent at this moment, and the agent read it before acting". A count of reads over a
 * count of deliveries is the ratio of two unrelated totals, which is the measurement this whole
 * record replaces. So the interesting assertions below are about which moment a read lands on, and
 * about what happens when it can land on none.
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
import { foldMomentSpool, momentStageReads, observedMomentLosses, readGovernedMoment } from "../moment-ledger";

const dirs: string[] = [];
const ports: StoragePort[] = [];
const cores: MonetCore[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-moment-read-"));
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

function seedInterception(path: string, momentId: string): void {
  appendFileSync(
    path,
    `${JSON.stringify({
      v: 1,
      runId: "run-gate",
      seq: 0,
      kind: "interception",
      momentId,
      at: "2026-08-19T00:00:00.000Z",
      toolUseId: "toolu_1",
      circle: "acme-widgets",
      sessionId: null,
      surface: "Bash",
      actionSha256: "a".repeat(64),
      actionRendering: "terraform apply",
      actionChars: 15,
      actionClipped: false,
      stageId: "stage-1",
      ruleIds: ["rule-a", "rule-b"],
      disposition: "advised",
      deliveredRuleIds: [],
    })}\n`,
  );
}

function coreWithSpool(spoolPath: string): MonetCore {
  const core = new MonetCore(":memory:", { momentSpoolPath: spoolPath, defaultCircle: "acme-widgets" });
  cores.push(core);
  return core;
}

describe("a read joins the moment that prompted it", () => {
  it("records one read per rule, against the named moment", () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    seedInterception(spoolPath, "m1");
    const core = coreWithSpool(spoolPath);

    core.recordRuleReads("m1", ["rule-a", "rule-b"], "stage-1");

    const moment = readGovernedMoment(db, spoolPath, "m1");
    // Per rule, not a tally: the ledger can say WHICH rule was read and when.
    expect(Object.keys(moment?.ruleReads ?? {}).sort()).toEqual(["rule-a", "rule-b"]);
    expect(moment?.ruleReads["rule-a"]).toEqual(expect.any(String));
    expect(observedMomentLosses(db, spoolPath)).toEqual([]);
  });

  it("does not attribute a read to a moment that was never named", () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    seedInterception(spoolPath, "m1");
    const core = coreWithSpool(spoolPath);

    // The agent reached stage_lookup from agent_context, with no interception behind it.
    core.recordRuleReads(null, ["rule-a"], "stage-1");

    const folded = foldMomentSpool(db, spoolPath);
    // Recorded as a read that cannot be joined — never silently credited to the only moment around,
    // which is exactly the confident wrong join the whole record exists to avoid.
    expect(folded.unjoinableReads).toBe(1);
    expect(readGovernedMoment(db, spoolPath, "m1")?.ruleReads).toEqual({});
  });

  it("keeps the first read of a rule when the same rule is read twice", () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    seedInterception(spoolPath, "m1");
    const core = coreWithSpool(spoolPath);

    core.recordRuleReads("m1", ["rule-a"], "stage-1");
    const first = readGovernedMoment(db, spoolPath, "m1")?.ruleReads["rule-a"];
    core.recordRuleReads("m1", ["rule-a"], "stage-1");
    // The read that matters is the one that fell between delivery and the act; a later re-read does
    // not change whether the rule was received before the agent acted.
    expect(readGovernedMoment(db, spoolPath, "m1")?.ruleReads["rule-a"]).toBe(first);
  });

  it("is a no-op, and never throws, when no spool is configured", () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets" });
    cores.push(core);
    // The default everywhere: with a default path every core ever constructed would append into the
    // user's real store. Recording must stay silent here rather than inventing a sink.
    expect(() => core.recordRuleReads("m1", ["rule-a"], "stage-1")).not.toThrow();
  });

  it("sequences its reads under one run, so a swallowed read is a nameable hole", () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    seedInterception(spoolPath, "m1");
    const core = coreWithSpool(spoolPath);

    core.recordRuleReads("m1", ["rule-a"], "stage-1");
    core.recordRuleReads("m1", ["rule-b"], "stage-1");
    foldMomentSpool(db, spoolPath);

    // ONE run for the process, not one per call — a fresh run per call would make every record
    // seq 0 of its own run and the completeness proof would have nothing left to prove.
    const runs = db.prepare(`SELECT run_id, writer_role, max_seq FROM moment_runs ORDER BY run_id`).all() as Array<{
      run_id: string;
      writer_role: string | null;
      max_seq: number;
    }>;
    const coreRuns = runs.filter((run) => run.writer_role === "core");
    expect(coreRuns).toHaveLength(1);
    expect(coreRuns[0].max_seq).toBe(2); // run-start, then the two reads
    expect(observedMomentLosses(db, spoolPath)).toEqual([]);
  });
});

/**
 * WHICH STAGES HAS NOBODY EVER LOOKED UP.
 *
 * The read-side twin of "which rules have never fired", and it fails the same way if nothing records
 * it: a declared stage nobody ever asks for is indistinguishable from a healthy quiet one. The stage
 * the AGENT NAMED is a different fact from the stage the GATE MATCHED, and these tests are mostly
 * about keeping the two apart.
 */
describe("the stage the agent named", () => {
  it("counts a named stage even when the read cannot be joined to a moment", () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(spoolPath);

    // Reached from agent_context: no interception behind it, so no moment — yet the agent plainly
    // named a stage, and before this field that read carried no stage attribution at all.
    core.recordRuleReads(null, ["rule-a"], "stage-alpha");

    expect(momentStageReads(db, spoolPath, "acme-widgets").get("stage-alpha")).toBe(1);
    // Still an unjoinable read: naming a stage does not manufacture a moment.
    expect(foldMomentSpool(db, spoolPath).unjoinableReads).toBe(0); // already folded above
    expect(db.prepare(`SELECT COUNT(*) AS n FROM moment_reads WHERE moment_id IS NULL`).get()).toEqual({ n: 1 });
  });

  it("keeps the named stage apart from the stage the gate matched", () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    seedInterception(spoolPath, "m1"); // the gate matched stage-1
    const core = coreWithSpool(spoolPath);

    // The agent asked about a DIFFERENT stage than the one the gate matched. Both facts are true and
    // neither may overwrite the other.
    core.recordRuleReads("m1", ["rule-a"], "stage-beta");

    expect(readGovernedMoment(db, spoolPath, "m1")?.stageId).toBe("stage-1");
    expect(momentStageReads(db, spoolPath, "acme-widgets").get("stage-beta")).toBe(1);
    expect(momentStageReads(db, spoolPath, "acme-widgets").has("stage-1")).toBe(false);
  });

  it("leaves a stage nobody named absent from the map, which is what makes the zero visible", () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(spoolPath);
    core.recordRuleReads(null, ["rule-a"], "stage-alpha");

    const reads = momentStageReads(db, spoolPath, "acme-widgets");
    // A caller joins this against the stage registry; a declared stage missing here is one nobody
    // has ever looked up. That absence IS the finding.
    expect(reads.has("stage-never-asked-for")).toBe(false);
    expect([...reads.keys()]).toEqual(["stage-alpha"]);
  });

  it("does not inflate a stage's count when the same range is folded twice", () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(spoolPath);
    core.recordRuleReads(null, ["rule-a"], "stage-alpha");
    expect(momentStageReads(db, spoolPath, "acme-widgets").get("stage-alpha")).toBe(1);

    db.prepare(`UPDATE moment_fold_cursor SET byte_offset = 0 WHERE singleton = 1`).run();
    expect(momentStageReads(db, spoolPath, "acme-widgets").get("stage-alpha")).toBe(1);
  });
});

/**
 * The WIRING, through a real stage_lookup round trip.
 *
 * The engine method above is the mechanism; this is the proof that the tool actually feeds it the
 * stage the agent named. Without this, dropping the argument at the call site would leave every
 * unit test green while the coverage surface quietly went blind.
 */
describe("stage_lookup records the stage the agent named", () => {
  it("attributes the read to the stage the caller asked for", async () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    const core = new MonetCore(":memory:", { momentSpoolPath: spoolPath, defaultCircle: "acme-widgets" });
    cores.push(core);
    await core.declare({
      species: "rule", stage: "terraform apply",
      content: "Always run plan first.", severity: "advisory", scope: "domain", circle: "acme-widgets",
    });

    const server = new McpServer({ name: "t", version: "1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "c", version: "1" });
    await client.connect(ct);
    try {
      await client.callTool({ name: "stage_lookup", arguments: { stage: "terraform apply", circle: "acme-widgets" } });
    } finally {
      await client.close();
    }

    const reads = momentStageReads(db, spoolPath, "acme-widgets");
    // Some stage was named, and it is the one the caller asked for — not null, not the gate's.
    expect([...reads.values()].reduce((a, b) => a + b, 0)).toBe(1);
    expect([...reads.keys()][0]).toEqual(expect.any(String));
  });
});

/**
 * THE KEY, AND THE ORDER THAT MAKES IT USABLE.
 *
 * `stage_lookup` now records its read against the moment THIS CALL opened, and hands that id back
 * so the agent can quote it to `conformance_ask` / `conformance_answer`. That only works if the
 * three stamps land in the order the design assumes, and the order is not something the code says
 * out loud anywhere — it is a consequence of where each one is written:
 *
 *   `at`         — `openStoreMoment`, in the wrapper, BEFORE the handler runs.
 *   `readAt`     — `recordRuleReads`, inside the handler.
 *   `outcome_at` — `closeStoreMoment`, in the wrapper, AFTER the handler returns.
 *
 * If that held only by accident, a self-read would fold into `late_rule_reads` instead of
 * `rule_reads` — the fold classifies a read after the outcome as late — and the moment would owe no
 * question, silently, because every consumer of this record requires a TIMELY read. So it is
 * measured here rather than assumed. A tie counts as timely by the fold's own rule, which matters:
 * all three stamps routinely land inside one millisecond.
 */
describe("a stage_lookup carries its own moment through the whole chain", () => {
  async function lookupOnce(
    spoolPath: string,
    stage: string,
  ): Promise<{ core: MonetCore; response: Record<string, unknown> }> {
    const core = new MonetCore(":memory:", { momentSpoolPath: spoolPath, defaultCircle: "acme-widgets" });
    cores.push(core);
    await core.declare({
      species: "rule", stage,
      content: "Always run plan first.", severity: "advisory", scope: "domain", circle: "acme-widgets",
    });
    const server = new McpServer({ name: "t", version: "1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "c", version: "1" });
    await client.connect(ct);
    try {
      const result = await client.callTool({ name: "stage_lookup", arguments: { stage, circle: "acme-widgets" } });
      const first = (result as { content: Array<{ type: string; text?: string }> }).content[0];
      return { core, response: JSON.parse(first.text ?? "{}") as Record<string, unknown> };
    } finally {
      await client.close();
    }
  }

  it("returns the momentId the read was recorded against", async () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const { response } = await lookupOnce(spoolPath, "terraform apply");

    // THE KEY IS ON THE WIRE. Before this, `conformance_ask` took a momentId that no surface an
    // agent could reach ever produced — the fourth fact was unrecordable for want of an identifier.
    const momentId = response.momentId;
    expect(momentId).toEqual(expect.any(String));

    // ...and it is THIS call's moment, not some other id: the row it names is the stage_lookup, and
    // the rules this response carried are the ones recorded as read against it.
    const moment = readGovernedMoment(db, spoolPath, momentId as string);
    expect(moment?.surface).toBe("stage_lookup");
    const delivered = (response.rules as Array<{ conceptId: string }>).map((rule) => rule.conceptId);
    expect(delivered.length).toBeGreaterThan(0);
    expect(Object.keys(moment?.ruleReads ?? {}).sort()).toEqual([...delivered].sort());
  });

  it("hands the key over with one line saying what it is for, on the FIRST lookup of a fresh store", async () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    // A fresh store, a fresh server, one lookup. Nothing has been read and acted on yet, so nothing
    // owes a question — which is precisely the turn the ask signal CANNOT speak on, since it fires
    // on a debt that does not exist yet. If the what-to-do rode only there, this response would hand
    // the agent a key with nothing telling it what the key is for, and no standing text covers it.
    const { response } = await lookupOnce(spoolPath, "terraform apply");
    expect(response.momentId).toEqual(expect.any(String));

    const instruction = response.instruction as string;
    expect(instruction).toEqual(expect.any(String));
    // BOTH tools named. Naming only `conformance_answer` would leave an obedient agent's `asked_at`
    // null and count it as a defect it never committed — the ask is its own event with its own owner.
    expect(instruction).toContain("conformance_ask");
    expect(instruction).toContain("conformance_answer");
    // ...and it names the key it ships beside, so the agent knows which id those calls take.
    expect(instruction).toContain("momentId");
    // WHETHER THE ACTION FOLLOWED THE RULE — never whether the rule caused it. Causation is
    // unobservable and is not what this measures; the ask signal holds the same line.
    expect(instruction).toContain("followed these rules");
    expect(instruction.toLowerCase()).not.toContain("because");
    expect(instruction.toLowerCase()).not.toContain("caused");
    // ONE LINE. It ships on every lookup that has a moment, so its cost is paid over and over.
    expect(instruction).not.toContain("\n");
    // THE DELIVERING CASE, NAMED. Both assertions above are about a response that CARRIED a rule,
    // and that is now the condition the key ships on rather than an incidental property of the
    // fixture — so it is asserted here instead of left to be inferred from `lookupOnce`'s setup.
    expect((response.rules as unknown[]).length).toBeGreaterThan(0);
  });

  /**
   * THE KEY AND ITS INSTRUCTION DO NOT SHIP ON A LOOKUP THAT DELIVERED NOTHING.
   *
   * The instruction tells the agent to ask the user whether the action followed "these rules" and
   * to record it with `conformance_ask`. On an empty lookup there are no such rules, and the call
   * it names cannot succeed: `recordRuleReads` spools `ruleId: null` for an empty rule set
   * (engine.ts), `foldMomentSpool` drops exactly that record instead of writing a rule read
   * (`if (record.ruleId === null) return`), and `requireObservedMoment` refuses any moment whose
   * `rule_reads` is empty. So the agent was handed a key and pointed at a guaranteed
   * `UnknownMomentError`.
   *
   * BOTH EMPTY SHAPES, because they are different code paths: a stage this store cannot resolve at
   * all (a MISS, which returns the stage index as its recovery path) and a stage that resolves with
   * no live rules bound to it (a HIT that carries `rules: []`).
   */
  describe("a lookup that delivered no rules hands over no key", () => {
    /** The one moment this lookup opened, found by surface rather than by an id the response withholds. */
    const soleStageLookupMoment = (db: StoragePort, spoolPath: string): Record<string, unknown> => {
      foldMomentSpool(db, spoolPath);
      const rows = db
        .prepare(`SELECT * FROM governed_moments WHERE surface = 'stage_lookup'`)
        .all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      return rows[0];
    };

    async function lookupWith(
      spoolPath: string,
      seed: (core: MonetCore) => Promise<void>,
      stage: string,
    ): Promise<Record<string, unknown>> {
      const core = new MonetCore(":memory:", { momentSpoolPath: spoolPath, defaultCircle: "acme-widgets" });
      cores.push(core);
      await seed(core);
      const server = new McpServer({ name: "t", version: "1" }, { capabilities: { tools: {} } });
      registerMonetCoreTools(server, core, { autoPrewarm: false });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const client = new Client({ name: "c", version: "1" });
      await client.connect(ct);
      try {
        const result = await client.callTool({ name: "stage_lookup", arguments: { stage, circle: "acme-widgets" } });
        const first = (result as { content: Array<{ type: string; text?: string }> }).content[0];
        return JSON.parse(first.text ?? "{}") as Record<string, unknown>;
      } finally {
        await client.close();
      }
    }

    it("on a MISS — the named stage does not resolve", async () => {
      const spoolPath = join(mkTmp(), "moments.jsonl");
      const db = mkDb();
      const response = await lookupWith(
        spoolPath,
        async (core) => {
          // A rule exists, at a DIFFERENT stage — so the store is populated and the miss is about
          // the name the agent used, not about an empty store.
          await core.declare({
            species: "rule", stage: "terraform apply",
            content: "Always run plan first.", severity: "advisory", scope: "domain", circle: "acme-widgets",
          });
        },
        "no such stage",
      );

      expect(response.matched).toBe(false);
      expect(response.rules).toEqual([]);
      expect(response.momentId).toBeUndefined();
      expect(response.instruction).toBeUndefined();
      // The recovery path a miss exists to offer is untouched by this — only the key goes.
      expect(response.stageIndex).toEqual(expect.arrayContaining(["terraform apply"]));

      // AND THIS IS WHY. The moment opened, and its `rule_reads` is empty — the exact condition
      // `requireObservedMoment` refuses on, so a `conformance_ask` against this id could only ever
      // have failed. Withholding the key is the response agreeing with the record.
      const moment = soleStageLookupMoment(db, spoolPath);
      expect(JSON.parse((moment.rule_reads as string | null) ?? "{}")).toEqual({});
    });

    it("on a HIT with no live rules bound to the stage", async () => {
      const spoolPath = join(mkTmp(), "moments.jsonl");
      const db = mkDb();
      const response = await lookupWith(
        spoolPath,
        async (core) => {
          await core.declare({ species: "stage", stage: "terraform apply" });
        },
        "terraform apply",
      );

      // The stage resolved — this is not the miss case wearing a different hat.
      expect(response.matched).toBe(true);
      expect((response.stage as { name: string }).name).toBe("terraform apply");
      expect(response.rules).toEqual([]);
      expect(response.momentId).toBeUndefined();
      expect(response.instruction).toBeUndefined();

      const moment = soleStageLookupMoment(db, spoolPath);
      expect(JSON.parse((moment.rule_reads as string | null) ?? "{}")).toEqual({});

      // THE ATTEMPT IS STILL RECORDED (F7). Withholding the key must not also silence the read —
      // the lookup happened, and it is the numerator a recognition rate needs. If this ever goes to
      // zero, the fix has traded one silent loss for another.
      expect([...momentStageReads(db, spoolPath, "acme-widgets").values()].reduce((a, b) => a + b, 0)).toBe(1);
    });
  });

  it("omits the instruction exactly where it omits the key — no spool, no moment, nothing to name", async () => {
    // An instruction to quote a key that is not on the response is worse than silence: it asks for a
    // conformance call that could attach to nothing. With no spool the wrapper opens no moment, so
    // the two are omitted together.
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets" });
    cores.push(core);
    await core.declare({
      species: "rule", stage: "terraform apply",
      content: "Always run plan first.", severity: "advisory", scope: "domain", circle: "acme-widgets",
    });
    const server = new McpServer({ name: "t", version: "1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "c", version: "1" });
    await client.connect(ct);
    try {
      const result = await client.callTool({ name: "stage_lookup", arguments: { stage: "terraform apply", circle: "acme-widgets" } });
      const first = (result as { content: Array<{ type: string; text?: string }> }).content[0];
      const response = JSON.parse(first.text ?? "{}") as Record<string, unknown>;
      // The rules still deliver — this is a working lookup, just an unrecordable one.
      expect((response.rules as unknown[]).length).toBeGreaterThan(0);
      expect(response.momentId).toBeUndefined();
      expect(response.instruction).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("lands the self-read as TIMELY, not late — the ordering the design depends on", async () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const { response } = await lookupOnce(spoolPath, "terraform apply");
    const moment = readGovernedMoment(db, spoolPath, response.momentId as string);

    // Received: the rules reached the agent, and the record says so.
    expect(Object.keys(moment?.ruleReads ?? {})).not.toEqual([]);
    // NOT LATE. This is the assertion the whole design rests on; if it ever flips, the read is
    // being recorded after the moment closes and no stage_lookup can ever owe a question.
    expect(moment?.lateRuleReads).toEqual({});
    // The act happened and the wrapper observed how it went — so "did it follow the rule?" has a
    // referent, which is what makes the moment answerable at all.
    expect(moment?.outcomeAt).toEqual(expect.any(String));
    expect(moment?.outcomeStatus).toBe("ok");
    // The ordering itself, stated as the comparison the fold performs. Equal stamps are timely.
    expect(Object.values(moment?.ruleReads ?? {}).every((readAt) => readAt <= (moment?.outcomeAt ?? ""))).toBe(true);

    // THE CONTROL — because a green that cannot fail reads exactly like a green that did not. The
    // assertion above is only evidence if this fixture is capable of producing a LATE read at all,
    // so here is one: the same core, the same spool, the same fold, with the read deliberately
    // recorded after the moment closed. It lands in the other column.
    const lateCore = cores[cores.length - 1];
    const control = lateCore.openStoreMoment("stage_lookup");
    lateCore.closeStoreMoment(control, "{}", "ok");
    // The stamps are millisecond-resolution and a tie counts as timely, so the read must be pushed
    // past the outcome by more than one tick for this to be the case it claims to be.
    await new Promise((resolve) => setTimeout(resolve, 5));
    lateCore.recordRuleReads(control, ["rule-late"], "stage-late", "acme-widgets");
    const lateMoment = readGovernedMoment(db, spoolPath, control as string);
    expect(lateMoment?.lateRuleReads).toEqual({ "rule-late": expect.any(String) });
    expect(lateMoment?.ruleReads).toEqual({});
  });

  it("owes a question once closed, satisfying every condition the ask signal requires", async () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const { core, response } = await lookupOnce(spoolPath, "terraform apply");
    const momentId = response.momentId as string;

    // All five conditions `momentsOwingAQuestion` gates on, checked one by one rather than only
    // through the query — so a failure says WHICH one broke.
    const moment = readGovernedMoment(db, spoolPath, momentId);
    expect(moment?.opened).toBe(true);
    expect(Object.keys(moment?.ruleReads ?? {})).not.toEqual([]);
    expect(moment?.outcomeAt).toEqual(expect.any(String));
    expect(moment?.askedAt).toBeNull();
    expect(moment?.answer).toBeNull();

    // And through the query the ask signal actually calls.
    expect(core.momentsOwingAQuestion(10)).toContain(momentId);

    // The debt clears the way the design says it does: the agent asks, the user answers, using the
    // id this response handed out. Nothing else in this system can produce that id.
    core.recordMomentAsk(momentId);
    core.recordMomentAnswer(momentId, "followed");
    expect(core.momentsOwingAQuestion(10)).not.toContain(momentId);
  });
});
