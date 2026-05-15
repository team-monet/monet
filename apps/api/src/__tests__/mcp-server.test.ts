import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp/server";

const { withTenantScopeMock, tenantSettingsMock } = vi.hoisted(() => ({
  withTenantScopeMock: vi.fn(
    async (
      _sql: unknown,
      _schemaName: string,
      fn: (txSql: unknown) => Promise<unknown>,
    ) => fn({}),
  ),
  tenantSettingsMock: { tenantAgentInstructions: Symbol("tenantAgentInstructions") },
}));

vi.mock("@monet/db", () => ({
  withTenantScope: withTenantScopeMock,
  asDrizzleSqlClient: vi.fn(() => ({})),
  tenantSettings: tenantSettingsMock,
}));

const drizzleSelectLimitMock = vi.fn().mockResolvedValue([]);
const drizzleSelectFromMock = vi.fn(() => ({
  limit: drizzleSelectLimitMock,
}));
const drizzleSelectMock = vi.fn(() => ({
  from: drizzleSelectFromMock,
}));
const drizzleMock = vi.fn(() => ({
  select: drizzleSelectMock,
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (...args: Parameters<typeof drizzleMock>) => drizzleMock(...args),
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
  getAgentGroupMemberships: vi.fn().mockResolvedValue([]),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
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
  getAgentGroupMemberships: (...args: unknown[]) => memoryServiceMocks.getAgentGroupMemberships(...args),
  writeAuditLog: (...args: unknown[]) => memoryServiceMocks.writeAuditLog(...args),
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

const ACTIVE_RULES = [
  {
    id: "00000000-0000-0000-0000-000000000101",
    name: "Stay Within Tenant Scope",
    description: "Only use tenant-scoped data and ask before guessing beyond it.",
    ownerUserId: null,
    updatedAt: "2026-03-16T00:00:00.000Z",
    createdAt: "2026-03-16T00:00:00.000Z",
  },
] as const;

function parseToolText(result: unknown) {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.find((entry) => entry.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

describe("MCP server factory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleSelectLimitMock.mockResolvedValue([]);
  });

  it("registers all eight tools", async () => {
    const server = await createMcpServer(AGENT, "tenant_test", {} as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(9);
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "memory_store",
      "memory_search",
      "memory_fetch",
      "memory_update",
      "memory_delete",
      "memory_promote_scope",
      "memory_mark_outdated",
      "memory_list_tags",
      "agent_context",
    ]));

    await Promise.all([client.close(), server.close()]);
  });

  it("exposes scope and type semantics in tool schemas", async () => {
    const server = await createMcpServer(AGENT, "tenant_test", {} as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const tools = await client.listTools();
    const memoryStore = tools.tools.find((tool) => tool.name === "memory_store");
    const memorySearch = tools.tools.find((tool) => tool.name === "memory_search");
    const memoryUpdate = tools.tools.find((tool) => tool.name === "memory_update");
    const memoryPromoteScope = tools.tools.find((tool) => tool.name === "memory_promote_scope");

    const memoryStoreSchema = memoryStore?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    } | undefined;
    const memorySearchSchema = memorySearch?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    } | undefined;
    const memoryUpdateSchema = memoryUpdate?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    } | undefined;
    const memoryPromoteScopeSchema = memoryPromoteScope?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    } | undefined;

    expect(memoryStoreSchema?.properties?.memoryScope?.description).toContain("only the creating agent can access");
    expect(memoryStoreSchema?.properties?.memoryScope?.description).toContain("same user can access across agent groups");
    expect(memoryStoreSchema?.properties?.memoryScope?.description).toContain("all agents in this agent's group can access");
    expect(memoryStoreSchema?.properties?.memoryScope?.description).toContain("Scope controls who can access");
    expect(memoryStoreSchema?.properties?.memoryScope?.description).toContain("user-level preferences");
    expect(memoryStoreSchema?.properties?.memoryScope?.description).toContain("team, project, workspace");
    expect(memoryStoreSchema?.properties?.memoryType?.description).toContain("a chosen course of action");
    expect(memoryStoreSchema?.properties?.memoryType?.description).toContain("step-by-step instructions");
    expect(memoryStoreSchema?.properties?.memoryType?.description).toContain("does not control who can access");
    expect(memoryStoreSchema?.properties?.summary?.description).toContain("Required when chat enrichment is disabled");
    expect(memoryStoreSchema?.properties?.groupId).toBeUndefined();
    expect(memoryStore?.description).toContain("Choose memoryScope by access boundary first");
    expect(memoryStore?.description).toContain("you must provide both summary and tags");

    expect(memorySearchSchema?.properties?.includeUser?.description).toContain("same user's agents across agent groups");
    expect(memorySearchSchema?.properties?.includePrivate?.description).toContain("only to the creating agent");
    expect(memorySearchSchema?.properties?.memoryType?.description).toContain("Soft preference");
    expect(memorySearchSchema?.properties?.memoryType?.description).toContain("a chosen course of action");
    expect(memorySearchSchema?.properties?.preferredMemoryType).toBeUndefined();

    expect(memoryUpdateSchema?.properties?.memoryScope?.description).toContain("only the creating agent can access");
    expect(memoryUpdateSchema?.properties?.memoryType?.description).toContain("a chosen course of action");
    expect(memoryUpdateSchema?.properties?.expectedVersion?.description).toContain("optimistic concurrency");

    expect(memoryPromoteScope?.description).toContain("creating agent only");
    expect(memoryPromoteScope?.description).toContain("same user's agents across agent groups");
    expect(memoryPromoteScope?.description).toContain("removes same-user cross-group visibility");
    expect(memoryPromoteScope?.description).toContain("same-user agents outside that group may no longer be able to search or fetch it");
    expect(memoryPromoteScope?.description).toContain("private scope restricts it to the creating agent");
    expect(memoryPromoteScopeSchema?.properties?.scope?.description).toContain("all agents in this agent's group can access");
    expect(memoryPromoteScopeSchema?.properties?.scope?.description).toContain("removes same-user cross-group visibility");

    await Promise.all([client.close(), server.close()]);
  });

  it("delivers base governance instructions even with no active rules", async () => {
    const server = await createMcpServer(AGENT, "tenant_test", {} as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toContain("enterprise AI agent governance platform");
    expect(instructions).toContain("COMPLY with all active rules provided by this server");
    expect(instructions).not.toContain("Active rules");

    await Promise.all([client.close(), server.close()]);
  });

  it("publishes active rules through MCP initialize instructions", async () => {
    const server = await createMcpServer(AGENT, "tenant_test", {} as never, {
      activeRules: [...ACTIVE_RULES],
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const instructions = client.getInstructions();
    expect(instructions).toContain("enterprise AI agent governance platform");
    expect(instructions).toContain("Stay Within Tenant Scope");
    expect(instructions).toContain("Only use tenant-scoped data");

    await Promise.all([client.close(), server.close()]);
  });

  it("returns agent_context payload with tenant and memberships", async () => {
    memoryServiceMocks.getAgentGroupMemberships.mockResolvedValueOnce([
      {
        id: "00000000-0000-0000-0000-000000000301",
        name: "Core Agents",
        description: "Default group",
      },
    ]);

    const server = await createMcpServer(AGENT, "tenant_test", {} as never, {
      tenantSlug: "acme",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: "agent_context", arguments: {} });
    expect(result.isError).toBeUndefined();
    expect(parseToolText(result)).toEqual({
      agentId: AGENT.id,
      externalId: AGENT.externalId,
      tenantSlug: "acme",
      userBinding: null,
      groupMemberships: [
        {
          id: "00000000-0000-0000-0000-000000000301",
          name: "Core Agents",
          description: "Default group",
        },
      ],
    });

    await Promise.all([client.close(), server.close()]);
  });

  it("bounds active rule instructions when rules are large", async () => {
    const activeRules = Array.from({ length: 30 }, (_, index) => ({
      id: `00000000-0000-0000-0000-${String(index + 200).padStart(12, "0")}`,
      name: `Rule ${index + 1} ${"name ".repeat(20)}`,
      description: `Description ${index + 1} ${"detail ".repeat(500)}`,
      ownerUserId: null,
      updatedAt: "2026-03-16T00:00:00.000Z",
      createdAt: "2026-03-16T00:00:00.000Z",
    }));

    const server = await createMcpServer(AGENT, "tenant_test", {} as never, {
      activeRules,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions?.length).toBeLessThanOrEqual(5000);
    expect(instructions).toContain("omitted to keep initialization bounded");
    expect(instructions).toContain("notifications/rules/updated");

    await Promise.all([client.close(), server.close()]);
  });

  it("truncates tenant instructions with visible marker", async () => {
    drizzleSelectLimitMock.mockResolvedValueOnce([
      { tenantAgentInstructions: "A".repeat(7000) },
    ]);

    const server = await createMcpServer(AGENT, "tenant_test", {} as never, {
      activeRules: [...ACTIVE_RULES],
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const instructions = client.getInstructions();
    expect(instructions).toContain("Tenant instructions:");
    expect(instructions).toContain("[TRUNCATED]");
    expect(instructions?.length).toBeLessThanOrEqual(5000);

    await Promise.all([client.close(), server.close()]);
  });

  it("memory_store enqueues enrichment after successful create", async () => {
    memoryServiceMocks.createMemory.mockResolvedValue({
      id: "mem-1",
      content: "hello",
      version: 0,
    });

    const server = await createMcpServer(AGENT, "tenant_test", {} as never);
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

  it("treats memory_search memoryType as a soft preference", async () => {
    memoryServiceMocks.searchMemories.mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    const server = await createMcpServer(AGENT, "tenant_test", {} as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "memory_search",
      arguments: {
        query: "banana",
        memoryType: "decision",
        tags: ["test"],
      },
    });

    expect(result.isError).toBeUndefined();
    expect(memoryServiceMocks.searchMemories).toHaveBeenCalledWith(
      expect.anything(),
      AGENT,
      expect.objectContaining({
        query: "banana",
        tags: ["test"],
        preferredMemoryType: "decision",
      }),
      null,
    );
    expect(memoryServiceMocks.searchMemories.mock.calls[0][2]).not.toHaveProperty("memoryType");

    await Promise.all([client.close(), server.close()]);
  });

  it("maps service errors to MCP tool errors", async () => {
    memoryServiceMocks.updateMemory.mockResolvedValue({
      error: "conflict",
      currentVersion: 4,
    });

    const server = await createMcpServer(AGENT, "tenant_test", {} as never);
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

  it("memory_update re-enqueues enrichment when update invalidates embeddings", async () => {
    memoryServiceMocks.updateMemory.mockResolvedValue({
      entry: { id: "mem-2", content: "updated" },
      needsEnrichment: true,
    });

    const server = await createMcpServer(AGENT, "tenant_test", {} as never);
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

    expect(result.isError).toBeUndefined();
    expect(enqueueEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      "tenant_test",
      "00000000-0000-0000-0000-000000000099",
    );

    await Promise.all([client.close(), server.close()]);
  });
});
