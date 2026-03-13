import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionStore } from "../mcp/session-store";
import { createMcpHandler } from "../mcp/handler";

const authMock = vi.fn();
const rateLimitMock = vi.fn();
const createMcpServerMock = vi.fn();
const pushRulesToAgentMock = vi.fn();

const transportHandleRequestMock = vi.fn();
const transportCloseMock = vi.fn();

vi.mock("../services/agent-auth.service.js", () => ({
  authenticateAgentFromBearerToken: (...args: unknown[]) => authMock(...args),
}));

vi.mock("../middleware/rate-limit.js", () => ({
  checkRateLimit: (...args: unknown[]) => rateLimitMock(...args),
}));

vi.mock("../mcp/server.js", () => ({
  createMcpServer: (...args: unknown[]) => createMcpServerMock(...args),
}));

vi.mock("../services/rule-notification.service.js", () => ({
  pushRulesToAgent: (...args: unknown[]) => pushRulesToAgentMock(...args),
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    onclose: (() => void) | undefined;
    onerror: ((error: Error) => void) | undefined;
    handleRequest = transportHandleRequestMock;
    close = transportCloseMock;
  },
}));

function createReq(
  method: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  return {
    method,
    headers,
    url: "/mcp",
  } as unknown as IncomingMessage;
}

function createRes() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: (key: string, value: string) => {
      headers.set(key, value);
    },
    end: vi.fn(function end(this: { headersSent: boolean }) {
      this.headersSent = true;
    }),
  } as unknown as ServerResponse;

  return { res, headers };
}

const agent = {
  id: "agent-1",
  externalId: "agent-1",
  tenantId: "00000000-0000-0000-0000-000000000010",
  isAutonomous: false,
  userId: null,
  role: null,
};

describe("mcp handler", () => {
  let sessionStore: SessionStore;
  let handler: ReturnType<typeof createMcpHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore = new SessionStore();
    handler = createMcpHandler({
      db: {} as never,
      sql: {} as never,
      sessionStore,
    });

    authMock.mockResolvedValue({ ok: true, agent, rawKey: "raw-key" });
    rateLimitMock.mockReturnValue({ allowed: true });
    createMcpServerMock.mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });
    pushRulesToAgentMock.mockResolvedValue(undefined);
    transportHandleRequestMock.mockImplementation(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
    });
    transportCloseMock.mockResolvedValue(undefined);
  });

  it("returns 401 when auth fails", async () => {
    authMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: "unauthorized",
      message: "Invalid API key",
    });
    const { res } = createRes();

    await handler.handle(
      createReq("POST", { authorization: "Bearer bad" }),
      res,
    );

    expect(res.statusCode).toBe(401);
  });

  it("creates a new session on POST without Mcp-Session-Id", async () => {
    const { res } = createRes();

    await handler.handle(
      createReq("POST", { authorization: "Bearer valid" }),
      res,
    );

    expect(sessionStore.count()).toBe(1);
    expect(rateLimitMock).toHaveBeenCalledWith("agent-1");
    expect(transportHandleRequestMock).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing session on POST with session id", async () => {
    sessionStore.add("session-1", {
      transport: {
        handleRequest: transportHandleRequestMock,
        close: transportCloseMock,
      } as never,
      server: { close: vi.fn().mockResolvedValue(undefined) } as never,
      agentContext: agent,
      tenantSchemaName: "tenant_00000000_0000_0000_0000_000000000010",
      connectedAt: new Date(),
      lastActivityAt: new Date(),
    });

    const { res } = createRes();
    await handler.handle(
      createReq("POST", {
        authorization: "Bearer valid",
        "mcp-session-id": "session-1",
      }),
      res,
    );

    expect(sessionStore.count()).toBe(1);
    expect(transportHandleRequestMock).toHaveBeenCalledTimes(1);
  });

  it("returns 401 for session ownership mismatch without closing the foreign session", async () => {
    sessionStore.add("session-foreign", {
      transport: {
        handleRequest: transportHandleRequestMock,
        close: transportCloseMock,
      } as never,
      server: { close: vi.fn().mockResolvedValue(undefined) } as never,
      agentContext: {
        ...agent,
        id: "agent-2",
      },
      tenantSchemaName: "tenant_00000000_0000_0000_0000_000000000010",
      connectedAt: new Date(),
      lastActivityAt: new Date(),
    });

    const { res } = createRes();
    await handler.handle(
      createReq("POST", {
        authorization: "Bearer valid",
        "mcp-session-id": "session-foreign",
      }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(sessionStore.get("session-foreign")).toBeDefined();
    expect(transportCloseMock).not.toHaveBeenCalled();
  });

  it("deletes session on DELETE /mcp", async () => {
    const serverClose = vi.fn().mockResolvedValue(undefined);
    sessionStore.add("session-1", {
      transport: {
        handleRequest: transportHandleRequestMock,
        close: transportCloseMock,
      } as never,
      server: { close: serverClose } as never,
      agentContext: agent,
      tenantSchemaName: "tenant_00000000_0000_0000_0000_000000000010",
      connectedAt: new Date(),
      lastActivityAt: new Date(),
    });

    const { res } = createRes();
    await handler.handle(
      createReq("DELETE", {
        authorization: "Bearer valid",
        "mcp-session-id": "session-1",
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(sessionStore.count()).toBe(0);
    expect(transportCloseMock).toHaveBeenCalled();
    expect(serverClose).toHaveBeenCalled();
  });

  it("returns 404 for GET with unknown session", async () => {
    const { res } = createRes();

    await handler.handle(
      createReq("GET", {
        authorization: "Bearer valid",
        "mcp-session-id": "missing-session",
      }),
      res,
    );

    expect(res.statusCode).toBe(404);
  });
});
