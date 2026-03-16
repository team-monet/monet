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
import type { RuleRecord } from "../services/rule.service";
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

interface CreateMcpServerOptions {
  activeRules?: RuleRecord[];
  onInitialized?: () => void | Promise<void>;
}

const MAX_RULE_NAME_INSTRUCTIONS_CHARS = 120;
const MAX_RULE_DESCRIPTION_INSTRUCTIONS_CHARS = 240;
const MAX_RULES_IN_INSTRUCTIONS = 20;
const MAX_INSTRUCTIONS_CHARS = 4000;

function normalizeInstructionText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateInstructionText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

function summarizeRuleForInstructions(rule: RuleRecord, index: number): string {
  const name = truncateInstructionText(
    normalizeInstructionText(rule.name),
    MAX_RULE_NAME_INSTRUCTIONS_CHARS,
  );
  const description = truncateInstructionText(
    normalizeInstructionText(rule.description),
    MAX_RULE_DESCRIPTION_INSTRUCTIONS_CHARS,
  );

  return `${index + 1}. ${name}: ${description}`;
}

function formatActiveRulesInstructions(activeRules: RuleRecord[]): string | undefined {
  if (activeRules.length === 0) {
    return undefined;
  }

  const header = `The following is a bounded summary of the ${activeRules.length} Monet tenant rule(s) active for this agent. Treat them as required guidance whenever you use this server.`;
  const footer =
    "Full active rules are also sent after initialization via notifications/rules/updated. If later updates arrive, replace this summary with the latest rules.";
  const candidateRules = activeRules.slice(0, MAX_RULES_IN_INSTRUCTIONS);
  const ruleLines: string[] = [];
  let omittedCount = activeRules.length - candidateRules.length;

  for (const [index, rule] of candidateRules.entries()) {
    const nextLine = summarizeRuleForInstructions(rule, index);
    const nextInstructions = [
      header,
      "",
      ...ruleLines,
      nextLine,
      "",
      footer,
    ].join("\n");

    if (nextInstructions.length > MAX_INSTRUCTIONS_CHARS) {
      omittedCount += candidateRules.length - index;
      break;
    }

    ruleLines.push(nextLine);
  }

  const lines = [header, "", ...ruleLines];

  if (omittedCount > 0) {
    lines.push(
      "",
      `Only ${ruleLines.length} rule summary item(s) are included here; ${omittedCount} additional active rule(s) are omitted to keep MCP initialization bounded.`,
    );
  }

  lines.push("", footer);
  return lines.join("\n");
}

export function createMcpServer(
  agentContext: AgentContext,
  tenantSchemaName: string,
  sql: postgres.Sql,
  options: CreateMcpServerOptions = {},
) {
  const instructions = formatActiveRulesInstructions(options.activeRules ?? []);
  const server = new McpServer({
    name: "monet",
    version: packageJson.version,
  }, instructions ? { instructions } : undefined);

  if (options.onInitialized) {
    server.server.oninitialized = () => {
      void options.onInitialized?.();
    };
  }

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
