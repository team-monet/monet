import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";

type ToolResult = { content: Array<{ type: string; text: string }> };

type FetchHarness = {
  core: MonetCore;
  client: Client;
  call: (id: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
};

const harnesses: FetchHarness[] = [];

async function harness(): Promise<FetchHarness> {
  const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
  const server = new McpServer({ name: "memory-fetch-contract-test", version: "1" });
  registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "memory-fetch-contract-client", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result: FetchHarness = {
    core,
    client,
    call: async (id, args = {}) => {
      const response = await client.callTool({ name: "memory_fetch", arguments: { id, ...args } });
      return JSON.parse((response as ToolResult).content[0]!.text) as Record<string, unknown>;
    },
    close: async () => {
      await client.close();
      await server.close();
      core.close();
    },
  };
  harnesses.push(result);
  return result;
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close();
});

const removedFields = [
  "confidence",
  "version",
  "supportCount",
  "totalObservations",
  "synthesisInstruction",
  "synthesisDeferred",
  "observationsNote",
  "contradictionsNote",
  "bodyOmitted",
] as const;

function expectRemovedFieldsAbsent(payload: Record<string, unknown>): void {
  for (const field of removedFields) expect(payload).not.toHaveProperty(field);
}

describe("memory_fetch normal concept contract", () => {
  it("returns the body and unified count without observations, paging metadata, or removed fields", async () => {
    const { core, call } = await harness();
    const stored = await core.store("The normal read surface is the synthesized body.");
    await core.applySynthesis(stored.conceptId, "A concise synthesized body.");

    const fetched = await call(stored.conceptId);

    expect(fetched).toMatchObject({
      id: stored.conceptId,
      circle: "default",
      kind: "fact",
      body: "A concise synthesized body.",
      observationCount: 1,
      lastConfirmedAt: expect.any(Number),
    });
    expect(fetched).not.toHaveProperty("observations");
    expect(fetched).not.toHaveProperty("observationsOffset");
    expect(fetched).not.toHaveProperty("observationsTruncated");
    expect(fetched).not.toHaveProperty("needsSynthesis");
    expectRemovedFieldsAbsent(fetched);

    // includeBody no longer inverts a normal fetch into an evidence view; it remains source-only.
    const legacyIncludeBodyFalse = await call(stored.conceptId, { includeBody: false });
    expect(legacyIncludeBodyFalse.body).toBe("A concise synthesized body.");
    expect(legacyIncludeBodyFalse).not.toHaveProperty("observations");
  });

  it("returns explicit observation pages with the full count and paging metadata", async () => {
    const { core, client, call } = await harness();
    const total = 23;
    const first = await core.store("Observation 0.");
    const observationIds = [first.observationId];
    for (let i = 1; i < total; i++) {
      observationIds.push((await core.store(`Observation ${i}.`, { attachTo: first.conceptId })).observationId);
    }
    await core.applySynthesis(first.conceptId, "Body remains present while evidence is explicitly pulled.");

    const rawFirstPage = await client.callTool({
      name: "memory_fetch",
      arguments: { id: first.conceptId, observations: true },
    }) as ToolResult;
    const expectedFirstPage = {
      id: first.conceptId,
      circle: "default",
      kind: "fact",
      body: "Body remains present while evidence is explicitly pulled.",
      observationCount: total,
      lastConfirmedAt: undefined as unknown,
      observations: observationIds.slice(-20).map((id, index) => ({ id, content: `Observation ${index + 3}.` })),
      observationsOffset: 0,
    };
    const firstPage = JSON.parse(rawFirstPage.content[0]!.text) as Record<string, unknown>;
    const secondPage = await call(first.conceptId, { observations: true, observationsOffset: 20 });
    const firstIds = (firstPage.observations as Array<{ id: string }>).map((observation) => observation.id);
    const secondIds = (secondPage.observations as Array<{ id: string }>).map((observation) => observation.id);

    expectedFirstPage.lastConfirmedAt = firstPage.lastConfirmedAt;
    expect(firstPage).toEqual(expectedFirstPage);
    expect(rawFirstPage.content[0]!.text).toBe(JSON.stringify(expectedFirstPage, null, 2));
    expect(firstPage.observations).toHaveLength(20);
    expect(firstIds).toEqual(observationIds.slice(-20));
    expect(secondPage).toMatchObject({ observationCount: total, observationsOffset: 20 });
    expect(secondPage.observations).toHaveLength(3);
    expect(secondIds).toEqual(observationIds.slice(0, 3));
    expect(new Set([...firstIds, ...secondIds]).size).toBe(total);
    expect(firstPage).not.toHaveProperty("observationsOmitted");
    expect(secondPage).not.toHaveProperty("observationsOmitted");
    expectRemovedFieldsAbsent(firstPage);
    expectRemovedFieldsAbsent(secondPage);
  });

  it("fits an escaping-heavy observation page against the complete body envelope", async () => {
    const { core, client } = await harness();
    const escapingUnit = `${"\""}${"\\"}`;
    const observationIds: string[] = [];
    const first = await core.store(`Observation 0: ${escapingUnit.repeat(700)}`);
    observationIds.push(first.observationId);
    for (let i = 1; i < 20; i++) {
      observationIds.push((await core.store(`Observation ${i}: ${escapingUnit.repeat(700)}`, {
        attachTo: first.conceptId,
      })).observationId);
    }
    await core.applySynthesis(first.conceptId, `Near-cap body: ${"body ".repeat(1_400)}`);

    const response = await client.callTool({
      name: "memory_fetch",
      arguments: { id: first.conceptId, observations: true },
    }) as ToolResult;
    const text = response.content[0]!.text;
    const fetched = JSON.parse(text) as Record<string, unknown>;
    const delivered = fetched.observations as Array<{ id: string; content: string }>;

    expect(text.length).toBeLessThanOrEqual(40_000);
    expect(fetched.body).toBeTruthy();
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThan(20);
    expect(fetched.observationsOmitted).toBe(20 - delivered.length);
    expect(fetched.observationsTruncated).toBe(true);
    expect(delivered.map((observation) => observation.id)).toEqual(observationIds.slice(-delivered.length));
  });

  it("signals observation content truncation only on an explicitly requested page", async () => {
    const { core, call } = await harness();
    const stored = await core.store("Oversized evidence. ".repeat(100));

    const byDefault = await call(stored.conceptId);
    const withObservations = await call(stored.conceptId, { observations: true });

    expect(byDefault).not.toHaveProperty("observationsTruncated");
    expect(withObservations.observationsTruncated).toBe(true);
    expect((withObservations.observations as Array<{ content: string }>)[0]!.content).toContain("[truncated");
  });

  it("marks dirty concepts with needsSynthesis:true and omits the flag on clean concepts", async () => {
    const { core, call } = await harness();
    const stored = await core.store("Unsynthesized evidence starts dirty.");

    const dirty = await call(stored.conceptId);
    expect(dirty.needsSynthesis).toBe(true);
    expect(dirty).not.toHaveProperty("observations");

    await core.applySynthesis(stored.conceptId, "Evidence synthesized.");
    const clean = await call(stored.conceptId);
    expect(clean).not.toHaveProperty("needsSynthesis");
  });

  it("keeps disputed status and open contradictions conditional", async () => {
    const { core, call } = await harness();
    const disputed = await core.store("The release happens on Tuesday.");
    const contradiction = core.flagContradiction(disputed.conceptId, {
      kind: "value-conflict",
      detail: "The approved calendar says Wednesday.",
    });
    const clean = await core.store("The release train has one owner.");

    const disputedFetch = await call(disputed.conceptId);
    expect(disputedFetch).toMatchObject({
      status: "disputed",
      openContradictions: [{
        id: contradiction.id,
        kind: "value-conflict",
        detail: "The approved calendar says Wednesday.",
      }],
    });

    const cleanFetch = await call(clean.conceptId);
    expect(cleanFetch).not.toHaveProperty("status");
    expect(cleanFetch).not.toHaveProperty("openContradictions");
  });

  it("uses bodyTruncated:true as the clipped-body recovery signal", async () => {
    const { core, call } = await harness();
    const stored = await core.store("Seed evidence.");
    await core.applySynthesis(stored.conceptId, "Long body. ".repeat(1_000));

    const fetched = await call(stored.conceptId);

    expect(fetched.bodyTruncated).toBe(true);
    expect((fetched.body as string).length).toBeGreaterThan(0);
    expect(fetched).not.toHaveProperty("observations");
    expectRemovedFieldsAbsent(fetched);
  });

  it("keeps fetch usefulness touch semantics", async () => {
    const { core, call } = await harness();
    const stored = await core.store("A fetched concept records consumption.");
    const db = (core as unknown as { db: { prepare: (sql: string) => { get: (id: string) => { usefulness_score: number } } } }).db;
    const usefulness = () => db.prepare("SELECT usefulness_score FROM concepts WHERE id = ?").get(stored.conceptId).usefulness_score;

    const before = usefulness();
    await call(stored.conceptId);
    expect(usefulness()).toBe(before + 1);
  });
});
