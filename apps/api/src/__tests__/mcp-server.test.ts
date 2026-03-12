import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp/server.js";

vi.mock("@monet/db", () => ({
  withTenantScope: vi.fn(
    async (
      _sql: unknown,
      _schemaName: string,
      fn: (txSql: unknown) => Promise<unknown>,
    ) => fn({}),
  ),
}));

const memoryServiceMocks = {
  createMemory: vi.fn(),
  searchMemories: vi.fn(),
  fetchMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  promoteScope: vi.fn(),
  markOutdated: vi.fn(),
  listTags: vi.fn(),
};

const enqueueEnrichment = vi.fn();
const computeQueryEmbedding = vi.fn().mockResolvedValue(null);

vi.mock("../services/memory.service.js", () => ({
  createMemory: (...args: unknown[]) => memoryServiceMocks.createMemory(...args),
  searchMemories: (...args: unknown[]) => memoryServiceMocks.searchMemories(...args),
  fetchMemory: (...args: unknown[]) => memoryServiceMocks.fetchMemory(...args),
  updateMemory: (...args: unknown[]) => memoryServiceMocks.updateMemory(...args),
  deleteMemory: (...args: unknown[]) => memoryServiceMocks.deleteMemory(...args),
  promoteScope: (...args: unknown[]) => memoryServiceMocks.promoteScope(...args),
  markOutdated: (...args: unknown[]) => memoryServiceMocks.markOutdated(...args),
  listTags: (...args: unknown[]) => memoryServiceMocks.listTags(...args),
  resolveMemoryWritePreflight: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/enrichment.service.js", () => ({
  computeQueryEmbedding: (...args: unknown[]) => computeQueryEmbedding(...args),
  enqueueEnrichment: (...args: unknown[]) => enqueueEnrichment(...args),
}));

const AGENT = {
  id: "00000000-0000-0000-0000-000000000001",
  externalId: "agent-1",
  tenantId: "00000000-0000-0000-0000-000000000010",
  isAutonomous: false,
  userId: null,
  role: null,
};

function parseToolText(result: unknown) {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.find((entry) => entry.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

describe("MCP server factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers all eight tools", async () => {
    const server = createMcpServer(AGENT, "tenant_test", {} as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(8);
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "memory_store",
      "memory_search",
      "memory_fetch",
      "memory_update",
      "memory_delete",
      "memory_promote_scope",
      "memory_mark_outdated",
      "memory_list_tags",
    ]));

    await Promise.all([client.close(), server.close()]);
  });

  it("memory_store enqueues enrichment after successful create", async () => {
    memoryServiceMocks.createMemory.mockResolvedValue({
      id: "mem-1",
      content: "hello",
      version: 0,
    });

    const server = createMcpServer(AGENT, "tenant_test", {} as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "memory_store",
      arguments: {
        content: "hello",
        memoryType: "fact",
        tags: ["test"],
      },
    });

    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual(expect.objectContaining({ id: "mem-1" }));
    expect(enqueueEnrichment).toHaveBeenCalledWith(expect.anything(), "tenant_test", "mem-1");

    await Promise.all([client.close(), server.close()]);
  });

  it("maps service errors to MCP tool errors", async () => {
    memoryServiceMocks.updateMemory.mockResolvedValue({
      error: "conflict",
      currentVersion: 4,
    });

    const server = createMcpServer(AGENT, "tenant_test", {} as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "memory_update",
      arguments: {
        id: "00000000-0000-0000-0000-000000000099",
        content: "updated",
        expectedVersion: 0,
      },
    });

    expect(result.isError).toBe(true);
    const content = (result as { content?: Array<{ text?: string }> }).content;
    expect(content?.[0]?.text).toContain("Version conflict");

    await Promise.all([client.close(), server.close()]);
  });
});
