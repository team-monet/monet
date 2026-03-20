import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type postgres from "postgres";
import type { Database } from "@monet/db";
import { checkRateLimit } from "../middleware/rate-limit";
import { tenantSchemaName } from "../middleware/tenant";
import { authenticateAgentFromBearerToken } from "../services/agent-auth.service";
import { pushRulesToAgent } from "../services/rule-notification.service";
import { getActiveRulesForAgent } from "../services/rule.service";
import { logRequest } from "../lib/log";
import { createMcpServer } from "./server";
import { SessionLimitError } from "./session-store";
import type { SessionStore } from "./session-store";

interface McpHandlerDeps {
  db: Database;
  sql: postgres.Sql;
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

export function createMcpHandler({ db, sql, sessionStore }: McpHandlerDeps) {
  return {
    async handle(req: IncomingMessage, res: ServerResponse) {
      const method = req.method ?? "GET";
      const path = requestPath(req);
      const sessionId = headerValue(req.headers["mcp-session-id"]);
      const requestId = randomUUID();
      const startedAt = performance.now();
      let agentId: string | undefined;
      let tenantId: string | undefined;

      if (!res.headersSent) {
        res.setHeader("X-Request-Id", requestId);
      }

      try {
        if (method === "POST") {
          const auth = await authenticateAgentFromBearerToken(
            db,
            headerValue(req.headers.authorization),
          );
          if (!auth.ok) {
            writeJson(res, auth.status, {
              error: auth.error,
              message: auth.message,
            });
            return;
          }
          agentId = auth.agent.id;
          tenantId = auth.agent.tenantId;

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
            const schemaName = tenantSchemaName(auth.agent.tenantId);
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
              sessionStore.remove(newSessionId);
            };
            transport.onerror = (error) => {
              console.error("MCP transport error", error);
            };

            await server.connect(transport);
            try {
              sessionStore.add(newSessionId, {
                transport,
                server,
                agentContext: auth.agent,
                tenantSchemaName: schemaName,
                connectedAt: new Date(),
                lastActivityAt: new Date(),
              });
            } catch (error) {
              if (error instanceof SessionLimitError) {
                writeJson(res, 429, {
                  error: "session_limit",
                  message: error.message,
                });
                return;
              }
              throw error;
            }

            try {
              // The MCP SDK reads POST request bodies from the raw Node stream.
              // Do not pre-consume req here.
              await transport.handleRequest(req, res);
              if (res.statusCode >= 400) {
                await sessionStore.closeSession(newSessionId);
                return;
              }
              sessionStore.touch(newSessionId);
              return;
            } catch (error) {
              console.error("MCP request error (new session)", error);
              await sessionStore.closeSession(newSessionId);
              writeJson(res, 500, {
                error: "internal",
                message: "An internal error occurred",
              });
              return;
            }
          }

          const session = sessionStore.get(sessionId);
          if (!session) {
            writeJson(res, 404, { error: "not_found", message: "Session not found" });
            return;
          }

          if (session.agentContext.id !== auth.agent.id) {
            writeJson(res, 401, { error: "unauthorized", message: "Session authentication mismatch" });
            return;
          }

          sessionStore.touch(sessionId);
          try {
            await session.transport.handleRequest(req, res);
            return;
          } catch (error) {
            console.error("MCP request error (existing session)", error);
            writeJson(res, 500, {
              error: "internal",
              message: "An internal error occurred",
            });
            return;
          }
        }

        if (method === "GET") {
          if (!sessionId) {
            writeJson(res, 400, { error: "validation_error", message: "Missing Mcp-Session-Id header" });
            return;
          }

          const auth = await authenticateAgentFromBearerToken(
            db,
            headerValue(req.headers.authorization),
          );
          if (!auth.ok) {
            writeJson(res, auth.status, {
              error: auth.error,
              message: auth.message,
            });
            return;
          }
          agentId = auth.agent.id;
          tenantId = auth.agent.tenantId;

          const session = sessionStore.get(sessionId);
          if (!session) {
            writeJson(res, 404, { error: "not_found", message: "Session not found" });
            return;
          }

          if (session.agentContext.id !== auth.agent.id) {
            writeJson(res, 401, { error: "unauthorized", message: "Session authentication mismatch" });
            return;
          }

          sessionStore.touch(sessionId);
          try {
            await session.transport.handleRequest(req, res);
            return;
          } catch (error) {
            console.error("MCP request error (GET session)", error);
            writeJson(res, 500, {
              error: "internal",
              message: "An internal error occurred",
            });
            return;
          }
        }

        if (method === "DELETE") {
          if (!sessionId) {
            writeJson(res, 400, { error: "validation_error", message: "Missing Mcp-Session-Id header" });
            return;
          }

          const auth = await authenticateAgentFromBearerToken(
            db,
            headerValue(req.headers.authorization),
          );
          if (!auth.ok) {
            writeJson(res, auth.status, {
              error: auth.error,
              message: auth.message,
            });
            return;
          }
          agentId = auth.agent.id;
          tenantId = auth.agent.tenantId;

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

          const session = sessionStore.get(sessionId);
          if (!session) {
            writeJson(res, 404, { error: "not_found", message: "Session not found" });
            return;
          }

          if (session.agentContext.id !== auth.agent.id) {
            writeJson(res, 401, { error: "unauthorized", message: "Session authentication mismatch" });
            return;
          }

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
