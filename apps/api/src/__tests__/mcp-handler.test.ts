import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SessionStore } from "../mcp/session-store";
import { createMcpHandler } from "../mcp/handler";

const authMock = vi.fn();
const rateLimitMock = vi.fn();
const createMcpServerMock = vi.fn();
const pushRulesToAgentMock = vi.fn();
const getActiveRulesForAgentMock = vi.fn();

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

vi.mock("../services/rule.service.js", () => ({
  getActiveRulesForAgent: (...args: unknown[]) => getActiveRulesForAgentMock(...args),
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
  let sql: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStore = new SessionStore();
    sql = {} as never;
    handler = createMcpHandler({
      db: {} as never,
      sql: sql as never,
      sessionStore,
    });

    authMock.mockResolvedValue({ ok: true, agent, rawKey: "raw-key" });
    rateLimitMock.mockReturnValue({ allowed: true });
    getActiveRulesForAgentMock.mockResolvedValue([]);
    createMcpServerMock.mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      server: {},
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

  it("pushes initial rules only after the MCP client finishes initialization", async () => {
    let onInitialized: (() => void | Promise<void>) | undefined;
    createMcpServerMock.mockImplementation(
      (_agent: unknown, _schemaName: string, _sql: unknown, options?: { onInitialized?: () => void | Promise<void> }) => {
        onInitialized = options?.onInitialized;
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          server: {},
        };
      },
    );

    const { res } = createRes();

    await handler.handle(
      createReq("POST", { authorization: "Bearer valid" }),
      res,
    );

    expect(pushRulesToAgentMock).not.toHaveBeenCalled();
    expect(onInitialized).toBeTypeOf("function");

    await onInitialized?.();

    expect(pushRulesToAgentMock).toHaveBeenCalledTimes(1);
    expect(pushRulesToAgentMock).toHaveBeenCalledWith(
      "agent-1",
      sessionStore,
      sql,
      "tenant_00000000_0000_0000_0000_000000000010",
    );
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

  it("returns 404 for session ownership mismatch without closing the foreign session", async () => {
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

    expect(res.statusCode).toBe(404);
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

  it("logs mcp_auth_failure on POST when auth fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(log.message).toBe("mcp_auth_failure");
    expect(log.level).toBe("warn");
    expect(log.statusCode).toBe(401);
    expect(log).not.toHaveProperty("authorization");

    warnSpy.mockRestore();
  });

  it("logs mcp_session_limit when per-agent limit is reached", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    for (let i = 0; i < 5; i++) {
      sessionStore.add(`session-${i}`, {
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
    }

    const { res } = createRes();
    await handler.handle(createReq("POST", { authorization: "Bearer valid" }), res);

    expect(res.statusCode).toBe(429);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(log.message).toBe("mcp_session_limit");
    expect(log.level).toBe("warn");
    expect(log.activeSessionCount).toBe(5);
    expect(log.maxSessions).toBe(5);
    expect(log.agentId).toBe("agent-1");

    warnSpy.mockRestore();
  });

  it("logs mcp_session_not_found on POST with unknown session id", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { res } = createRes();

    await handler.handle(
      createReq("POST", {
        authorization: "Bearer valid",
        "mcp-session-id": "missing-session",
      }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(log.message).toBe("mcp.session.missing");
    expect(log.level).toBe("warn");
    expect(log.sessionId).toBe("missing-session");

    warnSpy.mockRestore();
  });

  it("logs mcp_session_not_found on GET with unknown session id", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { res } = createRes();

    await handler.handle(
      createReq("GET", {
        authorization: "Bearer valid",
        "mcp-session-id": "missing-session",
      }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(log.message).toBe("mcp.session.missing");
    expect(log.level).toBe("warn");
    expect(log.sessionId).toBe("missing-session");

    warnSpy.mockRestore();
  });

  it("logs mcp_session_not_found on DELETE with unknown session id", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { res } = createRes();

    await handler.handle(
      createReq("DELETE", {
        authorization: "Bearer valid",
        "mcp-session-id": "missing-session",
      }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(log.message).toBe("mcp.session.missing");
    expect(log.level).toBe("warn");
    expect(log.sessionId).toBe("missing-session");

    warnSpy.mockRestore();
  });

  it("logs mcp.session.missing on POST when agent does not match", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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

    expect(res.statusCode).toBe(404);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(log.message).toBe("mcp.session.missing");
    expect(log.level).toBe("warn");
    expect(log.agentId).toBe("agent-2");

    warnSpy.mockRestore();
  });

  it("logs mcp.session.missing on GET when agent does not match", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
      createReq("GET", {
        authorization: "Bearer valid",
        "mcp-session-id": "session-foreign",
      }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(log.message).toBe("mcp.session.missing");
    expect(log.level).toBe("warn");
    expect(log.agentId).toBe("agent-2");

    warnSpy.mockRestore();
  });

  it("returns 503 when session is initializing", async () => {
    sessionStore.add("session-init", {
      transport: { handleRequest: transportHandleRequestMock, close: transportCloseMock } as never,
      server: { close: vi.fn().mockResolvedValue(undefined) } as never,
      agentContext: agent,
      tenantSchemaName: "tenant_00000000_0000_0000_0000_000000000010",
      connectedAt: new Date(),
      lastActivityAt: new Date(),
      state: "initializing",
    });
    const { res } = createRes();
    await handler.handle(createReq("POST", {
      authorization: "Bearer valid",
      "mcp-session-id": "session-init",
    }), res);
    expect(res.statusCode).toBe(503);
  });

  it("returns 404 when session is failed", async () => {
    sessionStore.add("session-failed", {
      transport: { handleRequest: transportHandleRequestMock, close: transportCloseMock } as never,
      server: { close: vi.fn().mockResolvedValue(undefined) } as never,
      agentContext: agent,
      tenantSchemaName: "tenant_00000000_0000_0000_0000_000000000010",
      connectedAt: new Date(),
      lastActivityAt: new Date(),
      state: "failed",
    });
    const { res } = createRes();
    await handler.handle(createReq("POST", {
      authorization: "Bearer valid",
      "mcp-session-id": "session-failed",
    }), res);
    expect(res.statusCode).toBe(404);
  });

  it("marks and cleans up sessions when transport request throws", async () => {
    transportHandleRequestMock.mockRejectedValueOnce(new Error("transport blew up"));
    sessionStore.add("session-1", {
      transport: { handleRequest: transportHandleRequestMock, close: transportCloseMock } as never,
      server: { close: vi.fn().mockResolvedValue(undefined) } as never,
      agentContext: agent,
      tenantSchemaName: "tenant_00000000_0000_0000_0000_000000000010",
      connectedAt: new Date(),
      lastActivityAt: new Date(),
      state: "ready",
    });

    const { res } = createRes();
    await handler.handle(createReq("POST", {
      authorization: "Bearer valid",
      "mcp-session-id": "session-1",
    }), res);

    expect(res.statusCode).toBe(500);
    expect(sessionStore.get("session-1")).toBeUndefined();
  });

  it("returns timeout response and cleans up sessions", async () => {
    process.env.MCP_REQUEST_TIMEOUT_MS = "1";
    transportHandleRequestMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    }));
    sessionStore.add("session-timeout", {
      transport: { handleRequest: transportHandleRequestMock, close: transportCloseMock } as never,
      server: { close: vi.fn().mockResolvedValue(undefined) } as never,
      agentContext: agent,
      tenantSchemaName: "tenant_00000000_0000_0000_0000_000000000010",
      connectedAt: new Date(),
      lastActivityAt: new Date(),
      state: "ready",
    });

    const { res } = createRes();
    await handler.handle(createReq("POST", {
      authorization: "Bearer valid",
      "mcp-session-id": "session-timeout",
    }), res);

    expect(res.statusCode).toBe(504);
    expect(sessionStore.get("session-timeout")).toBeUndefined();
    delete process.env.MCP_REQUEST_TIMEOUT_MS;
  });
});
