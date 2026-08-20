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

    expect(momentStageReads(db, spoolPath).get("stage-alpha")).toBe(1);
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
    expect(momentStageReads(db, spoolPath).get("stage-beta")).toBe(1);
    expect(momentStageReads(db, spoolPath).has("stage-1")).toBe(false);
  });

  it("leaves a stage nobody named absent from the map, which is what makes the zero visible", () => {
    const dir = mkTmp();
    const spoolPath = join(dir, "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(spoolPath);
    core.recordRuleReads(null, ["rule-a"], "stage-alpha");

    const reads = momentStageReads(db, spoolPath);
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
    expect(momentStageReads(db, spoolPath).get("stage-alpha")).toBe(1);

    db.prepare(`UPDATE moment_fold_cursor SET byte_offset = 0 WHERE singleton = 1`).run();
    expect(momentStageReads(db, spoolPath).get("stage-alpha")).toBe(1);
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
      species: "rule", stage: "terraform apply", patterns: ["Bash:terraform apply"],
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

    const reads = momentStageReads(db, spoolPath);
    // Some stage was named, and it is the one the caller asked for — not null, not the gate's.
    expect([...reads.values()].reduce((a, b) => a + b, 0)).toBe(1);
    expect([...reads.keys()][0]).toEqual(expect.any(String));
  });
});
