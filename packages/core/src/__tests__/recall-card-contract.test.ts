import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";

const circle = "recall-card-contract";
const RESULT_MAX_CHARS = 40_000;
const SEARCH_DESCRIPTION =
  "Find memories by similarity. Returns ranked pointer cards, not content; call memory_fetch with a card's id and non-default circle to read it. Omit circle for store-wide search. Empty results mean no match.";

const removedCardKeys = [
  "supportCount",
  "fetchHint",
  "score",
  "confidence",
  "matchedObservationId",
] as const;

type ToolResult = { content: Array<{ type: string; text: string }> };
type Payload = Record<string, unknown>;
type Harness = {
  core: MonetCore;
  client: Client;
  call: (name: "memory_search", args: Record<string, unknown>) => Promise<{ payload: Payload; text: string }>;
  close: () => Promise<void>;
};

const harnesses: Harness[] = [];

async function harness(core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 })): Promise<Harness> {
  const server = new McpServer({ name: "recall-card-contract-test", version: "1" });
  registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "recall-card-contract-client", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result: Harness = {
    core,
    client,
    call: async (name, args) => {
      const response = await client.callTool({ name, arguments: args }) as ToolResult;
      const text = response.content[0]!.text;
      return { payload: JSON.parse(text) as Payload, text };
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

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

function expectLeanCard(card: unknown, expected: {
  id: string;
  slug: string;
  kind: string;
  observationCount: number;
  contradictions?: number;
}): void {
  expect(card).toEqual({
    id: expected.id,
    slug: expected.slug,
    kind: expected.kind,
    circle,
    observationCount: expected.observationCount,
    ...(expected.contradictions !== undefined ? { contradictions: expected.contradictions } : {}),
  });
  for (const key of removedCardKeys) expect(card).not.toHaveProperty(key);
}

describe("recall pointer-card payload contract", () => {
  it("uses the lean search card shape with a correct observation count and no fixed guidance", async () => {
    const h = await harness();
    const stored = await h.core.store("Postgres pooling uses pgbouncer in transaction mode.", {
      circle,
      kind: "decision",
      sourceRefs: ["docs/database.md"],
    });
    await h.core.store("The pool mode is transaction, not session.", { circle, attachTo: stored.conceptId });
    await h.core.store("Pgbouncer fronts every application connection.", { circle, attachTo: stored.conceptId });

    const search = (await h.call("memory_search", { query: "pgbouncer transaction pooling", circle })).payload;
    const expected = {
      id: stored.conceptId,
      slug: "postgres-pooling-uses-pgbouncer-in-transaction-mode",
      kind: "decision",
      observationCount: 3,
    };

    expectLeanCard((search.results as unknown[])[0], expected);
    expect(search).not.toHaveProperty("guidance");
  });

  it("matches memory_fetch's full ledger count after one of two observations is terminally superseded", async () => {
    const h = await harness();
    const stored = await h.core.store("Postgres pooling uses pgbouncer in transaction mode.", { circle });
    const second = await h.core.store("The pgbouncer pool runs in transaction mode.", {
      circle,
      attachTo: stored.conceptId,
    });
    h.core.supersedeObservation(second.observationId, null);

    const search = (await h.call("memory_search", { query: "postgres pgbouncer pooling", circle })).payload;
    const fetchResponse = await h.client.callTool({
      name: "memory_fetch",
      arguments: { id: stored.conceptId, circle },
    }) as ToolResult;
    const fetched = JSON.parse(fetchResponse.content[0]!.text) as Payload;

    expect((search.results as Payload[])[0].observationCount).toBe(2);
    expect(fetched.observationCount).toBe(2);
  });

  it("omits zero contradictions and includes the nonzero count", async () => {
    const h = await harness();
    const stored = await h.core.store("Deployment rollback uses the prior artifact generation.", { circle });

    const beforeSearch = (await h.call("memory_search", { query: "deployment rollback artifact", circle })).payload;
    expect((beforeSearch.results as Payload[])[0]).not.toHaveProperty("contradictions");

    h.core.flagContradiction(stored.conceptId, { detail: "The registry no longer retains that generation." });
    h.core.flagContradiction(stored.conceptId, { detail: "The rollback controller now uses snapshots." });

    const afterSearch = (await h.call("memory_search", { query: "deployment rollback artifact", circle })).payload;
    expect((afterSearch.results as Payload[])[0].contradictions).toBe(2);
  });

  it("adds the nothing-matched line only to empty result sets", async () => {
    const h = await harness();
    const emptySearch = (await h.call("memory_search", { query: "anything", circle })).payload;
    expect(emptySearch).toEqual({ circle, results: [], note: "Nothing matched." });

    await h.core.store("Feature flags are evaluated once per request.", { circle });
    const nonemptySearch = (await h.call("memory_search", { query: "feature flags request", circle })).payload;
    expect((nonemptySearch.results as unknown[]).length).toBeGreaterThan(0);
    expect(nonemptySearch).not.toHaveProperty("note");
  });

  it.each([
    ["memory_search", "query", "results", "resultsTruncated", "resultsOmitted"],
  ] as const)("size-fits the complete %s envelope and reports an indivisible adversarial card's omission", async (
    tool,
    inputKey,
    cardsKey,
    truncatedKey,
    omittedKey,
  ) => {
    const h = await harness();
    await h.core.store("Adversarial card content remains findable by this exact query.", {
      circle,
      kind: "k".repeat(45_000),
    });

    const { payload, text } = await h.call(tool, { [inputKey]: "adversarial card content exact query" });
    expect(text.length).toBeLessThanOrEqual(RESULT_MAX_CHARS);
    expect(payload).not.toHaveProperty("truncated");
    expect(payload[cardsKey]).toEqual([]);
    expect(payload[truncatedKey]).toBe(true);
    expect(payload[omittedKey]).toBe(1);
    expect(payload).not.toHaveProperty("note");
  });

  it.each([
    ["memory_search", "query", "results", "resultsTruncated", "resultsOmitted"],
  ] as const)("omits a %s card with an oversized routing circle whole and reports it honestly", async (
    tool,
    inputKey,
    cardsKey,
    truncatedKey,
    omittedKey,
  ) => {
    const h = await harness();
    const longCircle = "c".repeat(45_000);
    await h.core.store("Feature flags are evaluated once per request.", { circle: longCircle });

    const { payload, text } = await h.call(tool, { [inputKey]: "feature flags request" });
    expect(text.length).toBeLessThanOrEqual(RESULT_MAX_CHARS);
    expect(payload.circle).toBe("(all circles)");
    expect(payload).not.toHaveProperty("circleTruncated");
    expect(payload).not.toHaveProperty("truncated");
    expect(payload[cardsKey]).toEqual([]);
    expect(payload[truncatedKey]).toBe(true);
    expect(payload[omittedKey]).toBe(1);
  });
});

describe("recall tool descriptions", () => {
  it("pins the fetching, circle, empty-result, and retrieval-mode teaching", async () => {
    const h = await harness();
    const tools = (await h.client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "memory_search")?.description).toBe(SEARCH_DESCRIPTION);
  });
});
