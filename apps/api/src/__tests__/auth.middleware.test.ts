import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import {
  generateApiKey,
} from "../services/api-key.service";
import type { AppEnv } from "../middleware/context";
import { authenticateAgentFromBearerToken } from "../services/agent-auth.service";

vi.mock("../services/agent-auth.service", () => ({
  authenticateAgentFromBearerToken: vi.fn(),
}));

// Mock agent data
const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const AGENT_ID = "00000000-0000-0000-0000-000000000002";
const EXTERNAL_ID = "test-agent";
const TENANT_SCHEMA = `tenant_${TENANT_ID.replace(/-/g, "_")}`;

const mockAuthenticate = vi.mocked(authenticateAgentFromBearerToken);

function createTestApp() {
  const app = new Hono<AppEnv>();

  // Mock SQL + tenant context injection
  app.use("*", async (c, next) => {
    c.set("sql", { begin: vi.fn(), unsafe: vi.fn() } as unknown as AppEnv["Variables"]["sql"]);
    c.set("tenantId", TENANT_ID);
    c.set("tenantSchemaName", TENANT_SCHEMA);
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
  beforeEach(() => {
    mockAuthenticate.mockReset();
  });

  it("returns 401 when no Authorization header", async () => {
    const app = createTestApp();
    mockAuthenticate.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Missing Authorization header",
    });
    const res = await app.request("/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  it("returns 401 for non-Bearer auth", async () => {
    const app = createTestApp();
    mockAuthenticate.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid Authorization header format",
    });
    const res = await app.request("/test", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid key format", async () => {
    const app = createTestApp();
    mockAuthenticate.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid API key format",
    });
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer not-a-valid-key" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the decoded agent id is not a UUID", async () => {
    const app = createTestApp();
    mockAuthenticate.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid API key",
    });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${generateApiKey("not-a-uuid")}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when agent not found in DB", async () => {
    const rawKey = generateApiKey(AGENT_ID);
    const app = createTestApp();
    mockAuthenticate.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid API key",
    });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when key hash does not match", async () => {
    const rawKey = generateApiKey(AGENT_ID);
    const app = createTestApp();
    mockAuthenticate.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid API key",
    });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(res.status).toBe(401);
  });

  it("sets agent context on success", async () => {
    const rawKey = generateApiKey(AGENT_ID);
    const app = createTestApp();
    mockAuthenticate.mockResolvedValueOnce({
      ok: true,
      rawKey,
      agent: {
        id: AGENT_ID,
        externalId: EXTERNAL_ID,
        tenantId: TENANT_ID,
        isAutonomous: false,
        userId: null,
        role: null,
      },
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
    const USER_ID = "00000000-0000-0000-0000-000000000099";

    const app = createTestApp();
    mockAuthenticate.mockResolvedValueOnce({
      ok: true,
      rawKey,
      agent: {
        id: AGENT_ID,
        externalId: EXTERNAL_ID,
        tenantId: TENANT_ID,
        isAutonomous: false,
        userId: USER_ID,
        role: null,
      },
    });

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent.userId).toBe(USER_ID);
  });
});
