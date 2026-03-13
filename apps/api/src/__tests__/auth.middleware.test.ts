import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import {
  generateApiKey,
  hashApiKey,
} from "../services/api-key.service";
import type { AppEnv } from "../middleware/context";

// Mock agent data
const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const AGENT_ID = "00000000-0000-0000-0000-000000000002";
const EXTERNAL_ID = "test-agent";

function createTestApp(mockAgentRow: Record<string, unknown> | null) {
  const app = new Hono<AppEnv>();

  // Mock DB injection
  app.use("*", async (c, next) => {
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve(mockAgentRow ? [mockAgentRow] : []),
          }),
        }),
      }),
    };
    c.set("db", mockDb as unknown as AppEnv["Variables"]["db"]);
    await next();
  });

  app.use("*", authMiddleware);

  app.get("/test", (c) => {
    const agent = c.get("agent");
    return c.json({ agent });
  });

  return app;
}

describe("auth middleware", () => {
  it("returns 401 when no Authorization header", async () => {
    const app = createTestApp(null);
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("returns 401 for non-Bearer auth", async () => {
    const app = createTestApp(null);
    const res = await app.request("/test", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid key format", async () => {
    const app = createTestApp(null);
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer not-a-valid-key" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the decoded agent id is not a UUID", async () => {
    const app = createTestApp(null);
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${generateApiKey("not-a-uuid")}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when agent not found in DB", async () => {
    const rawKey = generateApiKey(AGENT_ID);
    const app = createTestApp(null);
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when key hash does not match", async () => {
    const rawKey = generateApiKey(AGENT_ID);
    // Hash a different key
    const wrongKey = generateApiKey(AGENT_ID);
    const { hash, salt } = hashApiKey(wrongKey);

    const app = createTestApp({
      id: AGENT_ID,
      externalId: EXTERNAL_ID,
      tenantId: TENANT_ID,
      isAutonomous: false,
      apiKeyHash: hash,
      apiKeySalt: salt,
    });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(res.status).toBe(401);
  });

  it("sets agent context on success", async () => {
    const rawKey = generateApiKey(AGENT_ID);
    const { hash, salt } = hashApiKey(rawKey);

    const app = createTestApp({
      id: AGENT_ID,
      externalId: EXTERNAL_ID,
      tenantId: TENANT_ID,
      isAutonomous: false,
      apiKeyHash: hash,
      apiKeySalt: salt,
    });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent.id).toBe(AGENT_ID);
    expect(body.agent.tenantId).toBe(TENANT_ID);
    expect(body.agent.externalId).toBe(EXTERNAL_ID);
    expect(body.agent.isAutonomous).toBe(false);
    expect(body.agent.userId).toBeNull();
  });

  it("sets userId when agent has a userId", async () => {
    const rawKey = generateApiKey(AGENT_ID);
    const { hash, salt } = hashApiKey(rawKey);
    const USER_ID = "00000000-0000-0000-0000-000000000099";

    const app = createTestApp({
      id: AGENT_ID,
      externalId: EXTERNAL_ID,
      tenantId: TENANT_ID,
      isAutonomous: false,
      userId: USER_ID,
      apiKeyHash: hash,
      apiKeySalt: salt,
    });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent.userId).toBe(USER_ID);
  });
});
