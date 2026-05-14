import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv, AgentContext } from "../middleware/context";
import { memoriesRouter } from "../routes/memories";

const AGENT: AgentContext = {
  id: "00000000-0000-0000-0000-000000000001",
  externalId: "test-agent",
  tenantId: "00000000-0000-0000-0000-000000000010",
  isAutonomous: false,
  userId: null,
  role: null,
};

const SCHEMA_NAME = "tenant_00000000_0000_0000_0000_000000000010";

// Mock withTenantScope to call the function directly
vi.mock("@monet/db", () => ({
  withTenantScope: vi.fn(
    async (
      _sql: unknown,
      _schema: string,
      fn: (txSql: unknown) => Promise<unknown>,
    ) => fn({}),
  ),
}));

// Track service calls
const serviceMocks = {
  createMemory: vi.fn(),
  searchMemories: vi.fn(),
  listAgentMemories: vi.fn(),
  fetchMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  markOutdated: vi.fn(),
  promoteScope: vi.fn(),
  listTags: vi.fn(),
};

vi.mock("../services/memory.service.js", () => ({
  createMemory: (...args: unknown[]) => serviceMocks.createMemory(...args),
  searchMemories: (...args: unknown[]) => serviceMocks.searchMemories(...args),
  listAgentMemories: (...args: unknown[]) => serviceMocks.listAgentMemories(...args),
  fetchMemory: (...args: unknown[]) => serviceMocks.fetchMemory(...args),
  updateMemory: (...args: unknown[]) => serviceMocks.updateMemory(...args),
  deleteMemory: (...args: unknown[]) => serviceMocks.deleteMemory(...args),
  markOutdated: (...args: unknown[]) => serviceMocks.markOutdated(...args),
  promoteScope: (...args: unknown[]) => serviceMocks.promoteScope(...args),
  listTags: (...args: unknown[]) => serviceMocks.listTags(...args),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  resolveMemoryWritePreflight: vi.fn().mockResolvedValue(null),
}));

const enrichmentServiceMocks = {
  computeQueryEmbedding: vi.fn().mockResolvedValue(null),
  enqueueEnrichment: vi.fn(),
};

vi.mock("../services/enrichment.service.js", () => ({
  computeQueryEmbedding: (...args: unknown[]) => enrichmentServiceMocks.computeQueryEmbedding(...args),
  enqueueEnrichment: (...args: unknown[]) => enrichmentServiceMocks.enqueueEnrichment(...args),
}));

function createTestApp() {
  const app = new Hono<AppEnv>();

  // Inject mock context
  app.use("*", async (c, next) => {
    c.set("agent", AGENT);
    c.set("sql", {} as AppEnv["Variables"]["sql"]);
    c.set("tenantSchemaName", SCHEMA_NAME);
    await next();
  });

  app.route("/memories", memoriesRouter);
  return app;
}

describe("memories route", () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
    vi.clearAllMocks();
  });

  describe("POST /memories", () => {
    it("returns 400 on missing content", async () => {
      const res = await app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryType: "fact", tags: ["test"] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
    });

    it("returns 400 on missing tags", async () => {
      const res = await app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "test content",
          memoryType: "fact",
          tags: [],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when autonomous agent tries user scope", async () => {
      serviceMocks.createMemory.mockResolvedValue({
        error: "validation",
        message: "Autonomous agents cannot store user-scoped memories",
      });

      const res = await app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "test",
          memoryType: "fact",
          memoryScope: "user",
          tags: ["test"],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 409 when quota exceeded", async () => {
      serviceMocks.createMemory.mockResolvedValue({
        error: "quota_exceeded",
        limit: 100,
        current: 100,
      });

      const res = await app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "test",
          memoryType: "fact",
          tags: ["test"],
        }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("quota_exceeded");
    });

    it("returns 201 on valid input", async () => {
      serviceMocks.createMemory.mockResolvedValue({
        id: "new-id",
        content: "hello",
      });

      const res = await app.request("/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "hello",
          memoryType: "fact",
          tags: ["test"],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("new-id");
    });
  });

  describe("GET /memories", () => {
    it("returns search results", async () => {
      serviceMocks.searchMemories.mockResolvedValue({
        items: [
          {
            id: "mem-1",
            summary: "summary only",
            memoryType: "fact",
            tags: ["a"],
            autoTags: ["b"],
            usefulnessScore: 1,
            outdated: false,
            createdAt: "2026-03-03T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      });

      const res = await app.request(
        "/memories?tags=a,b&memoryType=fact&preferredMemoryType=decision&createdAfter=2026-03-01T00:00:00.000Z&accessedBefore=2026-03-04T00:00:00.000Z",
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items[0].summary).toBe("summary only");
      expect(body.items[0].content).toBeUndefined();
      expect(serviceMocks.searchMemories).toHaveBeenCalledWith(
        expect.anything(),
        AGENT,
        expect.objectContaining({
          createdAfter: "2026-03-01T00:00:00.000Z",
          accessedBefore: "2026-03-04T00:00:00.000Z",
          preferredMemoryType: "decision",
        }),
        null,
      );
    });
  });

  describe("GET /memories/agent/:agentId", () => {
    it("returns agent-specific Tier 1 results", async () => {
      serviceMocks.listAgentMemories.mockResolvedValue({
        items: [
          {
            id: "mem-2",
            summary: "agent memory",
            memoryType: "fact",
            tags: ["agent"],
            autoTags: [],
            usefulnessScore: 2,
            outdated: true,
            createdAt: "2026-03-03T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      });

      const res = await app.request(
        "/memories/agent/00000000-0000-0000-0000-000000000099?limit=5",
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].summary).toBe("agent memory");
      expect(serviceMocks.listAgentMemories).toHaveBeenCalled();
    });
  });

  describe("GET /memories/:id", () => {
    it("returns 404 for non-existent memory", async () => {
      serviceMocks.fetchMemory.mockResolvedValue({ error: "not_found" });

      const res = await app.request(
        "/memories/00000000-0000-0000-0000-000000000099",
      );
      expect(res.status).toBe(404);
    });

    it("returns 403 for forbidden scope", async () => {
      serviceMocks.fetchMemory.mockResolvedValue({ error: "forbidden" });

      const res = await app.request(
        "/memories/00000000-0000-0000-0000-000000000099",
      );
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /memories/:id", () => {
    it("returns 400 on invalid input", async () => {
      const res = await app.request(
        "/memories/00000000-0000-0000-0000-000000000099",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "new content" }),
          // missing expectedVersion
        },
      );
      expect(res.status).toBe(400);
    });

    it("returns 409 on version conflict", async () => {
      serviceMocks.updateMemory.mockResolvedValue({
        error: "conflict",
        currentVersion: 2,
      });

      const res = await app.request(
        "/memories/00000000-0000-0000-0000-000000000099",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: "new content",
            expectedVersion: 1,
          }),
        },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.currentVersion).toBe(2);
    });

    it("re-enqueues enrichment when update invalidates embeddings", async () => {
      serviceMocks.updateMemory.mockResolvedValue({
        entry: { id: "mem-1", content: "updated" },
        needsEnrichment: true,
      });

      const res = await app.request(
        "/memories/00000000-0000-0000-0000-000000000099",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: "updated",
            expectedVersion: 1,
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(enrichmentServiceMocks.enqueueEnrichment).toHaveBeenCalledWith(
        expect.anything(),
        SCHEMA_NAME,
        "00000000-0000-0000-0000-000000000099",
      );
    });
  });

  describe("DELETE /memories/:id", () => {
    it("returns 404 for non-existent memory", async () => {
      serviceMocks.deleteMemory.mockResolvedValue({ error: "not_found" });

      const res = await app.request(
        "/memories/00000000-0000-0000-0000-000000000099",
        { method: "DELETE" },
      );
      expect(res.status).toBe(404);
    });

    it("returns 403 when not the author", async () => {
      serviceMocks.deleteMemory.mockResolvedValue({ error: "forbidden" });

      const res = await app.request(
        "/memories/00000000-0000-0000-0000-000000000099",
        { method: "DELETE" },
      );
      expect(res.status).toBe(403);
    });
  });

  describe("GET /memories/tags", () => {
    it("returns tags", async () => {
      serviceMocks.listTags.mockResolvedValue(["tag-a", "tag-b"]);

      const res = await app.request("/memories/tags");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tags).toEqual(["tag-a", "tag-b"]);
    });
  });

  describe("PATCH /memories/:id/outdated", () => {
    it("returns 404 for non-existent memory", async () => {
      serviceMocks.markOutdated.mockResolvedValue({ error: "not_found" });

      const res = await app.request(
        "/memories/00000000-0000-0000-0000-000000000099/outdated",
        { method: "PATCH" },
      );
      expect(res.status).toBe(404);
    });
  });
});
