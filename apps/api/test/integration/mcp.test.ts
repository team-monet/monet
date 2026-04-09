import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { withTenantScope } from "@monet/db";
import { createApp } from "../../src/app";
import { createMcpHandler } from "../../src/mcp/handler";
import { SessionStore } from "../../src/mcp/session-store";
import {
  cleanupTestData,
  closeTestDb,
  getTestDb,
  getTestSql,
  provisionTestTenant,
} from "./helpers/setup";
import {
  resetEnrichmentStateForTests,
  setEnrichmentProviderForTests,
} from "../../src/services/enrichment.service";
import {
  EMBEDDING_DIMENSIONS,
  type EnrichmentProvider,
} from "../../src/providers/enrichment";

function embedding(fill: number) {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);
}

function provider(): EnrichmentProvider {
  return {
    generateSummary: async (content) => `summary:${content.slice(0, 24)}`,
    computeEmbedding: async (content) => {
      if (content.includes("banana")) return embedding(0.9);
      if (content.includes("apple")) return embedding(0.1);
      return embedding(0.5);
    },
    extractTags: async (content) =>
      content
        .split(/\s+/)
        .map((part) => part.toLowerCase().replace(/[^a-z0-9]/g, ""))
        .filter(Boolean)
        .slice(0, 4),
  };
}

function parseToolText(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

describe("MCP integration", () => {
  const db = getTestDb();
  const sql = getTestSql();
  const app = createApp(db as unknown as Parameters<typeof createApp>[0], sql);
  const appRequest = app.request.bind(app);
  app.request = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && tenantSlug && input.startsWith("/api/") && !input.startsWith("/api/tenants/")) {
      return appRequest(`/api/tenants/${tenantSlug}${input.slice(4)}`, init);
    }
    return appRequest(input, init);
  }) as typeof app.request;
  const sessionStore = new SessionStore();
  const mcpHandler = createMcpHandler({ db, sql, sessionStore });
  const honoListener = getRequestListener(app.fetch);
  let server: Server;
  let baseUrl: URL;
  let apiKey: string;
  let agentId: string;
  let tenantId: string;
  let schemaName: string;
  let groupId: string;
  let tenantSlug: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith("/mcp")) {
        void mcpHandler.handle(req, res);
        return;
      }
      honoListener(req, res);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${address.port}`);
  });

  beforeEach(async () => {
    resetEnrichmentStateForTests();
    setEnrichmentProviderForTests(provider());
    await cleanupTestData();

    const { body } = await provisionTestTenant({ name: "mcp-test" });
    apiKey = body.apiKey as string;
    agentId = (body.agent as { id: string }).id;
    tenantId = (body.tenant as { id: string }).id;
    schemaName = `tenant_${tenantId.replace(/-/g, "_")}`;
    tenantSlug = (body.tenant as { slug: string }).slug;

    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test-group" }),
    });
    const group = (await groupRes.json()) as { id: string };
    groupId = group.id;

    await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
  });

  afterAll(async () => {
    resetEnrichmentStateForTests();
    await cleanupTestData();
    await closeTestDb();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  async function connectClient(key = apiKey) {
    const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`/mcp/${tenantSlug}`, baseUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${key}`,
        },
      },
    });
    await client.connect(transport);
    return { client, transport };
  }

  it("connects with a valid API key and lists all tools", async () => {
    const { client } = await connectClient();
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

    await client.close();
  });

  it("rejects connection with an invalid API key", async () => {
    const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`/mcp/${tenantSlug}`, baseUrl), {
      requestInit: {
        headers: {
          Authorization: "Bearer mnt_invalid.invalid",
        },
      },
    });

    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("stores, searches, fetches, updates, deletes, and lists tags through MCP", async () => {
    const { client } = await connectClient();

    const storeResult = await client.callTool({
      name: "memory_store",
      arguments: {
        content: "banana decision from MCP",
        memoryType: "decision",
        tags: ["mcp", "banana"],
      },
    });
    const stored = parseToolText(storeResult);
    expect(stored.id).toBeDefined();

    const searchResult = await client.callTool({
      name: "memory_search",
      arguments: {
        query: "banana",
        tags: ["mcp"],
        includePrivate: false,
      },
    });
    const search = parseToolText(searchResult);
    expect(search.items).toHaveLength(1);
    expect(search.items[0].summary).toContain("banana");
    expect(search.items[0].content).toBeUndefined();

    const fetchResult = await client.callTool({
      name: "memory_fetch",
      arguments: { id: stored.id },
    });
    const fetched = parseToolText(fetchResult);
    expect(fetched.entry.content).toBe("banana decision from MCP");

    const updateResult = await client.callTool({
      name: "memory_update",
      arguments: {
        id: stored.id,
        content: "banana decision updated via MCP",
        expectedVersion: 0,
      },
    });
    const updated = parseToolText(updateResult);
    expect(updated.entry.version).toBe(1);

    const tagsResult = await client.callTool({
      name: "memory_list_tags",
      arguments: {},
    });
    const tags = parseToolText(tagsResult);
    expect(tags.tags).toContain("mcp");

    const deleteResult = await client.callTool({
      name: "memory_delete",
      arguments: { id: stored.id },
    });
    expect(parseToolText(deleteResult).success).toBe(true);

    const searchAgain = await client.callTool({
      name: "memory_search",
      arguments: { tags: ["mcp"] },
    });
    expect(parseToolText(searchAgain).items).toHaveLength(0);

    await client.close();
  });

  it("promotes scope so another agent can find the memory", async () => {
    const { client } = await connectClient();

    const storeResult = await client.callTool({
      name: "memory_store",
      arguments: {
        content: "share this MCP memory",
        memoryType: "fact",
        memoryScope: "private",
        tags: ["shareable"],
      },
    });
    const stored = parseToolText(storeResult);

    const regRes = await app.request("/api/agents/register", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ externalId: "agent-2", groupId }),
    });
    const regBody = await regRes.json();
    const secondKey = regBody.apiKey as string;
    const secondClient = await connectClient(secondKey);

    const hiddenResult = await secondClient.client.callTool({
      name: "memory_search",
      arguments: { query: "share this", includePrivate: true },
    });
    expect(parseToolText(hiddenResult).items).toHaveLength(0);

    const promoteResult = await client.callTool({
      name: "memory_promote_scope",
      arguments: { id: stored.id, scope: "group" },
    });
    expect(parseToolText(promoteResult).scope).toBe("group");

    const visibleResult = await secondClient.client.callTool({
      name: "memory_search",
      arguments: { query: "share this" },
    });
    expect(parseToolText(visibleResult).items).toHaveLength(1);

    await Promise.all([client.close(), secondClient.client.close()]);
  });

  it("marks memories outdated and keeps them searchable", async () => {
    const { client } = await connectClient();

    const first = parseToolText(await client.callTool({
      name: "memory_store",
      arguments: {
        content: "banana fresh memory",
        memoryType: "fact",
        tags: ["ranking"],
      },
    }));

    const second = parseToolText(await client.callTool({
      name: "memory_store",
      arguments: {
        content: "banana outdated memory",
        memoryType: "fact",
        tags: ["ranking"],
      },
    }));

    const outdatedResult = await client.callTool({
      name: "memory_mark_outdated",
      arguments: { id: second.id },
    });
    expect(parseToolText(outdatedResult).success).toBe(true);

    const searchResult = await client.callTool({
      name: "memory_search",
      arguments: { query: "banana", tags: ["ranking"] },
    });
    const search = parseToolText(searchResult);
    expect(search.items).toHaveLength(2);
    expect(search.items.map((item: { id: string }) => item.id)).toContain(first.id);
    expect(search.items.map((item: { id: string }) => item.id)).toContain(second.id);

    await client.close();
  });

  it("supports concurrent sessions for the same agent and explicit disconnect", async () => {
    const first = await connectClient();
    const second = await connectClient();

    const firstTools = await first.client.listTools();
    const secondTools = await second.client.listTools();
    expect(firstTools.tools).toHaveLength(8);
    expect(secondTools.tools).toHaveLength(8);

    await first.transport.terminateSession();
    expect(sessionStore.count()).toBeGreaterThanOrEqual(1);

    await Promise.all([first.client.close(), second.client.close()]);
  });

  it("rejects the next request when an API key is revoked mid-session", async () => {
    const { client } = await connectClient();

    const initialTools = await client.listTools();
    expect(initialTools.tools).toHaveLength(8);

    await withTenantScope(sql, schemaName, async (txSql) => {
      await txSql`
        UPDATE agents
        SET revoked_at = NOW()
        WHERE id = ${agentId}
      `;
    });

    await expect(client.listTools()).rejects.toThrow();

    await client.close();
  });
});
