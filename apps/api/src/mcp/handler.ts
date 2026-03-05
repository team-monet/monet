import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type postgres from "postgres";
import type { Database } from "@monet/db";
import { checkRateLimit } from "../middleware/rate-limit.js";
import { tenantSchemaName } from "../middleware/tenant.js";
import { authenticateAgentFromBearerToken } from "../services/agent-auth.service.js";
import { pushRulesToAgent } from "../services/rule-notification.service.js";
import { createMcpServer } from "./server.js";
import type { SessionStore } from "./session-store.js";

interface McpHandlerDeps {
  db: Database;
  sql: postgres.Sql;
  sessionStore: SessionStore;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

async function closeSession(
  sessionStore: SessionStore,
  sessionId: string,
) {
  const session = sessionStore.get(sessionId);
  if (!session) return;

  sessionStore.remove(sessionId);
  await Promise.allSettled([
    session.transport.close(),
    session.server.close(),
  ]);
}

export function createMcpHandler({ db, sql, sessionStore }: McpHandlerDeps) {
  return {
    async handle(req: IncomingMessage, res: ServerResponse) {
      const method = req.method ?? "GET";
      const sessionId = headerValue(req.headers["mcp-session-id"]);

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
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
          });
          const server = createMcpServer(auth.agent, schemaName, sql);

          transport.onclose = () => {
            sessionStore.remove(newSessionId);
          };
          transport.onerror = (error) => {
            console.error("MCP transport error", error);
          };

          await server.connect(transport);
          sessionStore.add(newSessionId, {
            transport,
            server,
            agentContext: auth.agent,
            tenantSchemaName: schemaName,
            connectedAt: new Date(),
            lastActivityAt: new Date(),
          });
          await pushRulesToAgent(auth.agent.id, sessionStore, sql, schemaName);

          try {
            // The MCP SDK reads POST request bodies from the raw Node stream.
            // Do not pre-consume req here.
            await transport.handleRequest(req, res);
            if (res.statusCode >= 400) {
              await closeSession(sessionStore, newSessionId);
              return;
            }
            sessionStore.touch(newSessionId);
            return;
          } catch (error) {
            await closeSession(sessionStore, newSessionId);
            writeJson(res, 500, {
              error: "internal",
              message: error instanceof Error ? error.message : "Internal server error",
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
          writeJson(res, 500, {
            error: "internal",
            message: error instanceof Error ? error.message : "Internal server error",
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
          writeJson(res, 500, {
            error: "internal",
            message: error instanceof Error ? error.message : "Internal server error",
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

        await closeSession(sessionStore, sessionId);
        writeJson(res, 200, { success: true });
        return;
      }

      writeJson(res, 405, { error: "method_not_allowed", message: "Method not allowed" });
    },
  };
}
