/**
 * The store intercepting itself.
 *
 * WHY THIS IS NOT THE HOST PATH WITH A DIFFERENT NAME. A host tool call is opened by one process and
 * closed by another, so it needs the host's `tool_use_id` to join the two halves. A call into the
 * store is opened and closed by the process that already holds the database handle, so it needs no
 * join at all — the moment id is enough.
 *
 * WHAT IT STILL SHARES, and the reason it must: it goes through the SPOOL rather than straight to
 * sqlite. The spool carries the per-run sequence that proves completeness, and a path that bypassed
 * it would be a second population with no proof — the exact fault this record exists to remove.
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
import { foldMomentSpool, observedMomentLosses, readGovernedMoment } from "../moment-ledger";
import { readMomentSpool } from "../moment-spool";

const dirs: string[] = [];
const ports: StoragePort[] = [];
const cores: MonetCore[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "monet-moment-store-"));
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

function coreWithSpool(spoolPath: string): MonetCore {
  const core = new MonetCore(":memory:", { momentSpoolPath: spoolPath, defaultCircle: "acme-widgets" });
  cores.push(core);
  return core;
}

describe("a call into the store opens and closes its own moment", () => {
  it("opens one, closes it with the outcome, and needs no tool call to join them", () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(spoolPath);

    const momentId = core.openStoreMoment("memory_search");
    expect(momentId).toEqual(expect.any(String));
    core.closeStoreMoment(momentId, JSON.stringify({ cards: 3 }));

    const moment = readGovernedMoment(db, spoolPath, momentId as string);
    expect(moment).toMatchObject({ opened: true, surface: "memory_search" });
    // Closed by moment id alone — there is no second process, so no tool_use_id is involved.
    expect(moment?.toolUseId).toBeNull();
    expect(moment?.outcomeSha256).toEqual(expect.any(String));
    expect(moment?.outcomeAt).toEqual(expect.any(String));
    // Nothing was lost on either half.
    expect(observedMomentLosses(db, spoolPath)).toEqual([]);
  });

  it("records ungoverned rather than silent, because nothing looked", () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(spoolPath);

    const momentId = core.openStoreMoment("memory_store");
    const moment = readGovernedMoment(db, spoolPath, momentId as string);
    // `silent` would claim the gate looked and found nothing bound. No gate evaluates calls into
    // the store at all, so the honest word is ungoverned and the rule sets are NOT KNOWN.
    expect(moment?.disposition).toBe("ungoverned");
    expect(moment?.ruleIds).toBeNull();
    expect(moment?.deliveredRuleIds).toBeNull();
    expect(moment?.stageId).toBeNull();
  });

  it("does not render the call's arguments", () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(spoolPath);

    const momentId = core.openStoreMoment("memory_store");
    const moment = readGovernedMoment(db, spoolPath, momentId as string);
    // Minimization: no consumer has been named for a store call's arguments, and they carry the
    // memory content this store exists to hold. The surface and the moment id identify the call.
    expect(moment?.actionRendering).toBeNull();
    expect(moment?.actionSha256).toBeNull();
    expect(moment?.actionChars).toBeNull();
  });

  it("goes through the spool, never straight to sqlite", () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    const core = coreWithSpool(spoolPath);

    const momentId = core.openStoreMoment("memory_fetch");
    core.closeStoreMoment(momentId, "{}");

    // The records exist on the SPOOL before any fold — which is what carries the sequence that
    // proves completeness. A store-side path that wrote sqlite directly would leave this empty.
    const read = readMomentSpool(spoolPath, 0);
    expect(read.records.map((record) => record.kind)).toEqual(["run-start", "interception", "outcome"]);
    expect(read.records.map((record) => record.seq)).toEqual([0, 1, 2]);
  });

  it("shares one run with the reads this process records", () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(spoolPath);

    const momentId = core.openStoreMoment("stage_lookup");
    core.recordRuleReads(momentId, ["rule-a"], "stage-1");
    core.closeStoreMoment(momentId, "{}");
    foldMomentSpool(db, spoolPath);

    // ONE run for the process. Two runs here would mean two sequences over one process's writes,
    // and the completeness proof is scoped to a run.
    const runs = db.prepare(`SELECT run_id, max_seq FROM moment_runs`).all() as Array<{ max_seq: number }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].max_seq).toBe(3); // run-start, interception, read, outcome
    expect(observedMomentLosses(db, spoolPath)).toEqual([]);
  });

  it("is a no-op, and never throws, when no spool is configured", () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme-widgets" });
    cores.push(core);
    // The default everywhere: with a default path, every core ever constructed would append into
    // the user's real store.
    expect(core.openStoreMoment("memory_search")).toBeNull();
    expect(() => core.closeStoreMoment(null, "{}")).not.toThrow();
  });
});

/**
 * The wiring, exercised through a REAL MCP round trip rather than by calling the methods directly.
 * The two methods above are the mechanism; this is the proof that every tool call actually reaches
 * it, which is the part a future tool registration could silently miss.
 */
describe("every MCP tool call opens and closes a moment", () => {
  async function makeMcpPair(core: MonetCore): Promise<{ client: Client; cleanup: () => Promise<void> }> {
    const server = new McpServer({ name: "monet-core-test", version: "0.6.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
    return { client, cleanup: async () => { await client.close(); } };
  }

  it("records the moment for a tool call nobody wired by hand", async () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(spoolPath);
    const { client, cleanup } = await makeMcpPair(core);
    try {
      await client.callTool({ name: "memory_search", arguments: { query: "anything at all" } });
    } finally {
      await cleanup();
    }

    foldMomentSpool(db, spoolPath);
    const rows = db
      .prepare(`SELECT surface, disposition, outcome_sha256, action_rendering FROM governed_moments`)
      .all() as Array<{ surface: string; disposition: string; outcome_sha256: string | null; action_rendering: string | null }>;
    const searched = rows.filter((row) => row.surface === "memory_search");
    expect(searched).toHaveLength(1);
    // Opened AND closed by the wrapper, with no per-tool code.
    expect(searched[0].disposition).toBe("ungoverned");
    expect(searched[0].outcome_sha256).toEqual(expect.any(String));
    // And the arguments — a live query string — were not written down.
    expect(searched[0].action_rendering).toBeNull();
    expect(observedMomentLosses(db, spoolPath)).toEqual([]);
  });

  it("closes the moment when the handler THROWS, not just when it reports a failure", async () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(spoolPath);
    const server = new McpServer({ name: "t", version: "1" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core);
    // Registered AFTER the wrapper is installed, so it goes through the same one every real tool
    // does. A handler that throws is a different branch from one that returns an error result, and
    // only this exercises it.
    server.tool("boom_for_test", "throws", {}, async () => {
      throw new Error("boom");
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "c", version: "1" });
    await client.connect(ct);
    try {
      await client.callTool({ name: "boom_for_test", arguments: {} }).catch(() => undefined);
    } finally {
      await client.close();
    }

    foldMomentSpool(db, spoolPath);
    const rows = db
      .prepare(`SELECT outcome_sha256 FROM governed_moments WHERE surface = 'boom_for_test'`)
      .all() as Array<{ outcome_sha256: string | null }>;
    expect(rows).toHaveLength(1);
    // A call that threw still HAPPENED. Leaving it open would make it indistinguishable from a
    // process that died mid-call, which is a different finding entirely.
    expect(rows[0].outcome_sha256).toEqual(expect.any(String));
  });

  it("closes the moment when the handler reports a failure", async () => {
    const spoolPath = join(mkTmp(), "moments.jsonl");
    const db = mkDb();
    const core = coreWithSpool(spoolPath);
    const { client, cleanup } = await makeMcpPair(core);
    try {
      // A well-formed call for a concept that does not exist — the handler RUNS and reports a
      // failure. (A call the SDK rejects on schema validation never reaches the handler at all, so
      // it opens no moment; the interception point is the handler, not the transport.)
      await client.callTool({ name: "memory_fetch", arguments: { id: "no-such-concept-at-all" } });
    } finally {
      await cleanup();
    }

    foldMomentSpool(db, spoolPath);
    const rows = db
      .prepare(`SELECT surface, outcome_sha256 FROM governed_moments WHERE surface = 'memory_fetch'`)
      .all() as Array<{ outcome_sha256: string | null }>;
    expect(rows).toHaveLength(1);
    // A call that failed still HAPPENED. An opened-but-never-closed moment means something else
    // entirely — the process died mid-call — and the two must stay distinguishable.
    expect(rows[0].outcome_sha256).toEqual(expect.any(String));
  });
});
