import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { withTenantScope } from "@monet/db";
import {
  registerAllTools,
  type McpToolHandlers,
} from "@monet/mcp-tools";
import type postgres from "postgres";
import type { AgentContext } from "../middleware/context";
import { computeQueryEmbedding, enqueueEnrichment } from "../services/enrichment.service";
import {
  createMemory,
  deleteMemory,
  fetchMemory,
  listTags,
  markOutdated,
  promoteScope,
  resolveMemoryWritePreflight,
  searchMemories,
  updateMemory,
} from "../services/memory.service";
import packageJson from "../../package.json" with { type: "json" };

function asToolResult(data: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data),
      },
    ],
  };
}

function asToolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function hasError(result: unknown): result is { error: string; message?: string } {
  return typeof result === "object" && result !== null && "error" in result;
}

function describeServiceError(result: { error: string; message?: string }): string {
  switch (result.error) {
    case "validation":
      return result.message ?? "Validation error";
    case "quota_exceeded":
      return "Memory quota exceeded";
    case "not_found":
      return "Memory not found";
    case "forbidden":
      return "Access denied";
    case "conflict":
      return `Version conflict${"currentVersion" in result ? ` (current version: ${String((result as { currentVersion?: number }).currentVersion)})` : ""}`;
    case "no_change":
      return "Scope is already set to this value";
    default:
      return result.message ?? result.error;
  }
}

export function createMcpServer(
  agentContext: AgentContext,
  tenantSchemaName: string,
  sql: postgres.Sql,
) {
  const server = new McpServer({
    name: "monet",
    version: packageJson.version,
  });

  const handlers: McpToolHandlers = {
    memoryStore: async (args) => {
      try {
        const preflight = await resolveMemoryWritePreflight(sql, agentContext);
        const result = await withTenantScope(sql, tenantSchemaName, (txSql) =>
          createMemory(txSql, agentContext, args, preflight),
        );

        if (hasError(result)) {
          return asToolError(describeServiceError(result));
        }

        const created = result as { id: string };
        enqueueEnrichment(sql, tenantSchemaName, created.id);
        return asToolResult(result);
      } catch (error) {
        return asToolError(error instanceof Error ? error.message : "Internal server error");
      }
    },
    memorySearch: async (args) => {
      try {
        const queryEmbedding = args.query ? await computeQueryEmbedding(args.query) : null;
        const result = await withTenantScope(sql, tenantSchemaName, (txSql) =>
          searchMemories(txSql, agentContext, args, queryEmbedding),
        );
        return asToolResult(result);
      } catch (error) {
        return asToolError(error instanceof Error ? error.message : "Internal server error");
      }
    },
    memoryFetch: async (args) => {
      try {
        const result = await withTenantScope(sql, tenantSchemaName, (txSql) =>
          fetchMemory(txSql, agentContext, args.id),
        );
        if (hasError(result)) {
          return asToolError(describeServiceError(result));
        }
        return asToolResult(result);
      } catch (error) {
        return asToolError(error instanceof Error ? error.message : "Internal server error");
      }
    },
    memoryUpdate: async (args) => {
      try {
        const result = await withTenantScope(sql, tenantSchemaName, (txSql) =>
          updateMemory(txSql, agentContext, args.id, {
            content: args.content,
            tags: args.tags,
            expectedVersion: args.expectedVersion,
          }),
        );
        if (hasError(result)) {
          return asToolError(describeServiceError(result));
        }
        return asToolResult(result);
      } catch (error) {
        return asToolError(error instanceof Error ? error.message : "Internal server error");
      }
    },
    memoryDelete: async (args) => {
      try {
        const result = await withTenantScope(sql, tenantSchemaName, (txSql) =>
          deleteMemory(txSql, agentContext, args.id),
        );
        if (hasError(result)) {
          return asToolError(describeServiceError(result));
        }
        return asToolResult(result);
      } catch (error) {
        return asToolError(error instanceof Error ? error.message : "Internal server error");
      }
    },
    memoryPromoteScope: async (args) => {
      try {
        const result = await withTenantScope(sql, tenantSchemaName, (txSql) =>
          promoteScope(txSql, agentContext, args.id, args.scope),
        );
        if (hasError(result)) {
          return asToolError(describeServiceError(result));
        }
        return asToolResult(result);
      } catch (error) {
        return asToolError(error instanceof Error ? error.message : "Internal server error");
      }
    },
    memoryMarkOutdated: async (args) => {
      try {
        const result = await withTenantScope(sql, tenantSchemaName, (txSql) =>
          markOutdated(txSql, agentContext, args.id),
        );
        if (hasError(result)) {
          return asToolError(describeServiceError(result));
        }
        return asToolResult(result);
      } catch (error) {
        return asToolError(error instanceof Error ? error.message : "Internal server error");
      }
    },
    memoryListTags: async (args) => {
      try {
        const result = await withTenantScope(sql, tenantSchemaName, (txSql) =>
          listTags(txSql, agentContext, args),
        );
        return asToolResult({ tags: result });
      } catch (error) {
        return asToolError(error instanceof Error ? error.message : "Internal server error");
      }
    },
  };

  registerAllTools(server, handlers);
  return server;
}
