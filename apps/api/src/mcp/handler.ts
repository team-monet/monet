import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { tenantSchemaNameFromId, type Database, type SqlClient } from "@monet/db";
import { checkRateLimit } from "../middleware/rate-limit";
import { resolveTenantBySlug } from "../middleware/tenant";
import { authenticateAgentFromBearerToken } from "../services/agent-auth.service";
import { pushRulesToAgent } from "../services/rule-notification.service";
import { getActiveRulesForAgent } from "../services/rule.service";
import { logRequest, writeStructuredLog } from "../lib/log";
import { createMcpServer } from "./server";
import { SessionLimitError, maxSessionsPerAgent } from "./session-store";
import type { SessionStore } from "./session-store";
import type { McpSession } from "./session-store";

const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;

class McpRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRequestTimeoutError";
  }
}

interface McpHandlerDeps {
  db: Database;
  sql: SqlClient;
  sessionStore: SessionStore;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestPath(req: IncomingMessage): string {
  if (!req.url) return "/mcp";

  try {
    return new URL(req.url, "http://127.0.0.1").pathname;
  } catch {
    return "/mcp";
  }
}

function tenantSlugFromPath(path: string): string | null {
  const match = path.match(/^\/mcp\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  if (res.headersSent) {
    console.warn("MCP handler attempted to write JSON after headers were already sent", {
      statusCode,
      body,
    });
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(body));
}

function currentRequestTimeoutMs(): number {
  const raw = process.env.MCP_REQUEST_TIMEOUT_MS;
  if (!raw) return DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  return Math.floor(parsed);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new McpRequestTimeoutError(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function createMcpHandler({ db, sql, sessionStore }: McpHandlerDeps) {
  function formatAgentIdPrefix(id: string | undefined): string | undefined {
    if (!id) return undefined;
    return id.slice(0, 8);
  }

  function logSessionEvent(input: {
    level: "info" | "warn" | "error";
    message: string;
    requestId?: string;
    method?: string;
    path?: string;
    tenantSlug?: string;
    sessionId?: string;
    session?: McpSession;
    reason?: string;
    error?: unknown;
  }) {
    writeStructuredLog({
      level: input.level,
      message: input.message,
      requestId: input.requestId,
      method: input.method,
      path: input.path,
      tenantSlug: input.tenantSlug,
      agentId: input.session?.agentContext.id,
      agentIdPrefix: formatAgentIdPrefix(input.session?.agentContext.id),
      sessionId: input.sessionId,
      sessionState: input.session?.state,
      activeRequestCount: input.sessionId ? sessionStore.getInFlightCount(input.sessionId) : undefined,
      reason: input.reason,
      error: input.error instanceof Error ? input.error.message : input.error,
    });
  }

  async function failAndCloseSession(
    sessionId: string,
    session: McpSession,
    reason: string,
    error?: unknown,
  ): Promise<void> {
    sessionStore.setState(
      sessionId,
      "failed",
      { error: error instanceof Error ? error.message : reason },
    );
    logSessionEvent({
      level: "error",
      message: "mcp.session.failed",
      sessionId,
      session,
      reason,
      error,
      tenantSlug: session.tenantSlug,
    });
    await sessionStore.closeSession(sessionId);
  }

  function resolveExistingSessionOrWriteError(input: {
    sessionId: string;
    requestedTenantSlug: string | null;
    tenantId?: string;
    authAgentId: string;
    reqMeta: { requestId: string; method: string; path: string };
    res: ServerResponse;
  }): McpSession | null {
    const session = sessionStore.get(input.sessionId);
    if (!session) {
      logSessionEvent({
        level: "warn",
        message: "mcp.session.missing",
        requestId: input.reqMeta.requestId,
        method: input.reqMeta.method,
        path: input.reqMeta.path,
        tenantSlug: input.requestedTenantSlug ?? undefined,
        sessionId: input.sessionId,
        reason: "missing",
      });
      writeJson(input.res, 404, { error: "not_found", message: "Session not found" });
      return null;
    }

    if (session.agentContext.id !== input.authAgentId) {
      logSessionEvent({
        level: "warn",
        message: "mcp.session.missing",
        requestId: input.reqMeta.requestId,
        method: input.reqMeta.method,
        path: input.reqMeta.path,
        tenantSlug: input.requestedTenantSlug ?? undefined,
        sessionId: input.sessionId,
        session,
        reason: "agent_mismatch",
      });
      writeJson(input.res, 404, { error: "not_found", message: "Session not found" });
      return null;
    }

    const sessionTenantMatches = session.tenantSlug
      ? session.tenantSlug === input.requestedTenantSlug
      : (session.tenantId ?? session.agentContext.tenantId) === input.tenantId;
    if (input.requestedTenantSlug && !sessionTenantMatches) {
      logSessionEvent({
        level: "warn",
        message: "mcp.session.missing",
        requestId: input.reqMeta.requestId,
        method: input.reqMeta.method,
        path: input.reqMeta.path,
        tenantSlug: input.requestedTenantSlug,
        sessionId: input.sessionId,
        session,
        reason: "tenant_mismatch",
      });
      writeJson(input.res, 404, { error: "not_found", message: "Session not found" });
      return null;
    }

    const sessionState = session.state ?? "ready";

    if (sessionState === "initializing") {
      writeJson(input.res, 503, { error: "unavailable", message: "Session is initializing" });
      return null;
    }

    if (sessionState === "failed" || sessionState === "closed" || sessionState === "closing") {
      logSessionEvent({
        level: "warn",
        message: "mcp.session.missing",
        requestId: input.reqMeta.requestId,
        method: input.reqMeta.method,
        path: input.reqMeta.path,
        tenantSlug: input.requestedTenantSlug ?? undefined,
        sessionId: input.sessionId,
        session,
        reason: `state_${sessionState}`,
      });
      writeJson(input.res, 404, { error: "not_found", message: "Session not found" });
      return null;
    }

    return session;
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse) {
      const method = req.method ?? "GET";
      const path = requestPath(req);
      const sessionId = headerValue(req.headers["mcp-session-id"]);
      const userAgent = headerValue(req.headers["user-agent"]);
      const requestId = randomUUID();
      const startedAt = performance.now();
      let agentId: string | undefined;
      let tenantId: string | undefined;

      if (!res.headersSent) {
        res.setHeader("X-Request-Id", requestId);
      }

      try {
        const requestedTenantSlug = tenantSlugFromPath(path);
        const tenant = requestedTenantSlug
          ? await resolveTenantBySlug(db, requestedTenantSlug)
          : null;
        if (requestedTenantSlug && !tenant) {
          writeJson(res, 404, { error: "not_found", message: "Tenant not found" });
          return;
        }
        tenantId = tenant?.tenantId;

        if (method === "POST") {
          const auth = await authenticateAgentFromBearerToken(
            sql,
            headerValue(req.headers.authorization),
            tenant ?? undefined,
          );
          if (!auth.ok) {
            writeStructuredLog({
              level: "warn",
              message: "mcp_auth_failure",
              requestId,
              method,
              path,
              tenantSlug: requestedTenantSlug ?? undefined,
              statusCode: auth.status,
            });
            writeJson(res, auth.status, {
              error: auth.error,
              message: auth.message,
            });
            return;
          }
          agentId = auth.agent.id;
          tenantId = tenantId ?? auth.agent.tenantId;

          const limit = checkRateLimit(auth.agent.id);
          if (!limit.allowed) {
            // Intentionally count every POST request (session init + tool invocation),
            // matching the shared MCP/REST budget defined in the M5 plan.
            writeJson(
              res,
              429,
              { error: "rate_limited", message: "Too many requests" },
              { "Retry-After": String(limit.retryAfterSeconds) },
            );
            return;
          }

          if (!sessionId) {
            const newSessionId = randomUUID();
            const schemaName = tenant?.tenantSchemaName ?? tenantSchemaNameFromId(auth.agent.tenantId);
            const activeRules = await getActiveRulesForAgent(sql, schemaName, auth.agent.id);
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => newSessionId,
            });
            const server = createMcpServer(auth.agent, schemaName, sql, {
              activeRules,
              onInitialized: async () => {
                try {
                  await pushRulesToAgent(auth.agent.id, sessionStore, sql, schemaName);
                } catch (error) {
                  console.error("Failed to push initial rules after MCP initialization", error);
                }
              },
            });

            transport.onclose = () => {
              logSessionEvent({
                level: "info",
                message: "mcp.session.closed",
                sessionId: newSessionId,
                reason: "client",
              });
              sessionStore.remove(newSessionId);
            };
            transport.onerror = (error) => {
              const existing = sessionStore.get(newSessionId);
              if (!existing) return;
              void failAndCloseSession(newSessionId, existing, "transport_error", error);
            };

            await server.connect(transport);
            try {
              sessionStore.add(newSessionId, {
                transport,
                server,
                agentContext: auth.agent,
                tenantId: tenant?.tenantId ?? auth.agent.tenantId,
                tenantSlug: requestedTenantSlug ?? undefined,
                tenantSchemaName: schemaName,
                connectedAt: new Date(),
                lastActivityAt: new Date(),
                state: "ready",
                initializedAt: new Date(),
              });
              logSessionEvent({
                level: "info",
                message: "mcp.session.created",
                requestId,
                method,
                path,
                tenantSlug: requestedTenantSlug ?? undefined,
                sessionId: newSessionId,
                session: sessionStore.get(newSessionId),
              });
              logSessionEvent({
                level: "info",
                message: "mcp.session.ready",
                requestId,
                method,
                path,
                tenantSlug: requestedTenantSlug ?? undefined,
                sessionId: newSessionId,
                session: sessionStore.get(newSessionId),
              });
            } catch (error) {
              if (error instanceof SessionLimitError) {
                writeStructuredLog({
                  level: "warn",
                  message: "mcp_session_limit",
                  requestId,
                  method,
                  path,
                  tenantSlug: requestedTenantSlug ?? undefined,
                  agentId,
                  userAgent,
                  activeSessionCount: agentId ? sessionStore.getByAgentId(agentId).length : undefined,
                  maxSessions: maxSessionsPerAgent(),
                });
                await Promise.allSettled([transport.close(), server.close()]);
                writeJson(res, 429, {
                  error: "session_limit",
                  message: "Session limit exceeded",
                });
                return;
              }
              throw error;
            }

            try {
              // The MCP SDK reads POST request bodies from the raw Node stream.
              // Do not pre-consume req here.
              const began = sessionStore.beginRequest(newSessionId);
              if (!began) {
                writeJson(res, 503, { error: "unavailable", message: "Session is not ready" });
                return;
              }
              await withTimeout(
                transport.handleRequest(req, res),
                currentRequestTimeoutMs(),
                "MCP request timed out",
              );
              if (res.statusCode >= 400) {
                await sessionStore.closeSession(newSessionId);
                return;
              }
              sessionStore.touch(newSessionId);
              return;
            } catch (error) {
              const createdSession = sessionStore.get(newSessionId);
              if (error instanceof McpRequestTimeoutError) {
                logSessionEvent({
                  level: "warn",
                  message: "mcp.request.timeout",
                  requestId,
                  method,
                  path,
                  tenantSlug: requestedTenantSlug ?? undefined,
                  sessionId: newSessionId,
                  session: createdSession,
                  reason: "request_timeout",
                });
                if (createdSession) {
                  await failAndCloseSession(newSessionId, createdSession, "request_timeout", error);
                }
                writeJson(res, 504, { error: "timeout", message: "MCP request timed out" });
                return;
              }
              if (createdSession) {
                await failAndCloseSession(newSessionId, createdSession, "request_error", error);
              }
              writeJson(res, 500, {
                error: "internal",
                message: "An internal error occurred",
              });
              return;
            } finally {
              sessionStore.endRequest(newSessionId);
            }
          }

          const session = resolveExistingSessionOrWriteError({
            sessionId,
            requestedTenantSlug,
            tenantId,
            authAgentId: auth.agent.id,
            reqMeta: { requestId, method, path },
            res,
          });
          if (!session) return;

          sessionStore.touch(sessionId);
          try {
            const began = sessionStore.beginRequest(sessionId);
            if (!began) {
              writeJson(res, 503, { error: "unavailable", message: "Session is not ready" });
              return;
            }
            await withTimeout(
              session.transport.handleRequest(req, res),
              currentRequestTimeoutMs(),
              "MCP request timed out",
            );
            return;
          } catch (error) {
            if (error instanceof McpRequestTimeoutError) {
              logSessionEvent({
                level: "warn",
                message: "mcp.request.timeout",
                requestId,
                method,
                path,
                tenantSlug: requestedTenantSlug ?? undefined,
                sessionId,
                session,
              });
              await failAndCloseSession(sessionId, session, "request_timeout", error);
              writeJson(res, 504, { error: "timeout", message: "MCP request timed out" });
              return;
            }
            await failAndCloseSession(sessionId, session, "transport_request_error", error);
            writeJson(res, 500, {
              error: "internal",
              message: "An internal error occurred",
            });
            return;
          } finally {
            sessionStore.endRequest(sessionId);
          }
        }

        if (method === "GET") {
          if (!sessionId) {
            writeJson(res, 400, { error: "validation_error", message: "Missing Mcp-Session-Id header" });
            return;
          }

          const auth = await authenticateAgentFromBearerToken(
            sql,
            headerValue(req.headers.authorization),
            tenant ?? undefined,
          );
          if (!auth.ok) {
            writeStructuredLog({
              level: "warn",
              message: "mcp_auth_failure",
              requestId,
              method,
              path,
              tenantSlug: requestedTenantSlug ?? undefined,
              statusCode: auth.status,
            });
            writeJson(res, auth.status, {
              error: auth.error,
              message: auth.message,
            });
            return;
          }
          agentId = auth.agent.id;
          tenantId = tenantId ?? auth.agent.tenantId;

          const session = resolveExistingSessionOrWriteError({
            sessionId,
            requestedTenantSlug,
            tenantId,
            authAgentId: auth.agent.id,
            reqMeta: { requestId, method, path },
            res,
          });
          if (!session) return;

          sessionStore.touch(sessionId);
          try {
            const began = sessionStore.beginRequest(sessionId);
            if (!began) {
              writeJson(res, 503, { error: "unavailable", message: "Session is not ready" });
              return;
            }
            await session.transport.handleRequest(req, res);
            return;
          } catch (error) {
            await failAndCloseSession(sessionId, session, "transport_request_error", error);
            writeJson(res, 500, {
              error: "internal",
              message: "An internal error occurred",
            });
            return;
          } finally {
            sessionStore.endRequest(sessionId);
          }
        }

        if (method === "DELETE") {
          if (!sessionId) {
            writeJson(res, 400, { error: "validation_error", message: "Missing Mcp-Session-Id header" });
            return;
          }

          const auth = await authenticateAgentFromBearerToken(
            sql,
            headerValue(req.headers.authorization),
            tenant ?? undefined,
          );
          if (!auth.ok) {
            writeStructuredLog({
              level: "warn",
              message: "mcp_auth_failure",
              requestId,
              method,
              path,
              tenantSlug: requestedTenantSlug ?? undefined,
              statusCode: auth.status,
            });
            writeJson(res, auth.status, {
              error: auth.error,
              message: auth.message,
            });
            return;
          }
          agentId = auth.agent.id;
          tenantId = tenantId ?? auth.agent.tenantId;

          const limit = checkRateLimit(auth.agent.id);
          if (!limit.allowed) {
            // DELETE is explicitly counted by design, while GET /mcp is not.
            writeJson(
              res,
              429,
              { error: "rate_limited", message: "Too many requests" },
              { "Retry-After": String(limit.retryAfterSeconds) },
            );
            return;
          }

          const session = resolveExistingSessionOrWriteError({
            sessionId,
            requestedTenantSlug,
            tenantId,
            authAgentId: auth.agent.id,
            reqMeta: { requestId, method, path },
            res,
          });
          if (!session) return;

          logSessionEvent({
            level: "info",
            message: "mcp.session.closed",
            requestId,
            method,
            path,
            tenantSlug: requestedTenantSlug ?? undefined,
            sessionId,
            session,
            reason: "client",
          });
          await sessionStore.closeSession(sessionId);
          writeJson(res, 200, { success: true });
          return;
        }

        writeJson(res, 405, { error: "method_not_allowed", message: "Method not allowed" });
      } finally {
        logRequest({
          requestId,
          method,
          path,
          statusCode: res.statusCode || 200,
          latencyMs: performance.now() - startedAt,
          tenantId,
          agentId,
          message: "mcp_request",
        });
      }
    },
  };
}
