import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { asDrizzleSqlClient, tenantSettings, withTenantScope } from "@monet/db";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  registerAllTools,
  type McpToolHandlers,
} from "@monet/mcp-tools";
import type { SqlClient } from "@monet/db";
import type { AgentContext } from "../middleware/context";
import { computeQueryEmbedding, enqueueEnrichment } from "../services/enrichment.service";
import {
  createMemory,
  deleteMemory,
  fetchMemory,
  getAgentGroupMemberships,
  listTags,
  markOutdated,
  promoteScope,
  resolveMemoryWritePreflight,
  searchMemories,
  updateMemory,
  writeAuditLog,
} from "../services/memory.service";
import type { RuleRecord } from "../services/rule.service";
import { writeStructuredLog } from "../lib/log";
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

const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000;

class McpToolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolTimeoutError";
  }
}

function currentToolTimeoutMs(): number {
  const raw = process.env.MCP_REQUEST_TIMEOUT_MS;
  if (!raw) return DEFAULT_MCP_TOOL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MCP_TOOL_TIMEOUT_MS;
  return Math.floor(parsed);
}

async function withToolTimeout<T>(
  operation: string,
  tenantSchemaName: string,
  agentId: string,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = currentToolTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await Promise.race([
      execute(controller.signal),
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new McpToolTimeoutError(`${operation} timed out after ${timeoutMs}ms`));
        }, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      writeStructuredLog({
        level: "warn",
        message: "mcp.request.timeout",
        tenantSchemaName,
        agentId,
        operation,
        timeoutMs,
      });
    }
  }
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
  tenantSlug?: string;
  onInitialized?: () => void | Promise<void>;
}

const MAX_RULE_NAME_INSTRUCTIONS_CHARS = 120;
const MAX_RULE_DESCRIPTION_INSTRUCTIONS_CHARS = 240;
const MAX_RULES_IN_INSTRUCTIONS = 20;
const MAX_INSTRUCTIONS_CHARS = 5000;
const INSTRUCTION_TRUNCATION_MARKER = " [TRUNCATED]";

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

const BASE_INSTRUCTIONS = `You are connected to Monet, an enterprise AI agent governance platform. Monet defines how you operate within this organization through rules, policies, and shared memory.

Your responsibilities:
- COMPLY with all active rules provided by this server. These are organizational policies that govern your behavior — treat them as mandatory, not advisory.
- USE shared memory proactively. Before starting non-trivial tasks, search for relevant prior context (decisions, known issues, patterns, preferences). After completing meaningful work, store durable takeaways for future sessions.
- MAINTAIN memory quality. Update outdated entries rather than creating duplicates. Use descriptive tags consistently (check memory_list_tags first). Choose the narrowest appropriate scope and promote later if needed.
- RESPECT scope boundaries. Private memories are yours alone; user-scoped memories are visible to your operator; group-scoped memories are shared across all agents in your group.`;

const AGENT_CONTEXT_INSTRUCTION = "USE the agent_context tool early to understand your current tenant, user, and group permissions before storing or searching memory.";

function truncateSectionWithMarker(
  value: string,
  maxChars: number,
  forceMarker: boolean,
): string {
  if (maxChars <= 0) {
    return "";
  }

  const marker = INSTRUCTION_TRUNCATION_MARKER;

  if (value.length > maxChars) {
    if (maxChars <= marker.length) {
      return marker.slice(0, maxChars);
    }

    return `${value.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
  }

  if (!forceMarker) {
    return value;
  }

  if (value.length + marker.length <= maxChars) {
    return `${value}${marker}`;
  }

  if (maxChars <= marker.length) {
    return marker.slice(0, maxChars);
  }

  return `${value.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
}

function formatRulesSection(
  activeRules: RuleRecord[],
  maxChars: number,
): { section: string | null; truncated: boolean } {
  if (activeRules.length === 0) {
    return { section: null, truncated: false };
  }

  const header = `Active rules (${activeRules.length}):`;
  const footer =
    "Full active rules are also sent after initialization via notifications/rules/updated. If later updates arrive, replace this summary with the latest rules.";
  const candidateRules = activeRules.slice(0, MAX_RULES_IN_INSTRUCTIONS);
  const ruleLines: string[] = [];
  let omittedCount = activeRules.length - candidateRules.length;

  for (const [index, rule] of candidateRules.entries()) {
    const nextLine = summarizeRuleForInstructions(rule, index);
    const nextRulesSection = [header, "", ...ruleLines, nextLine, "", footer].join("\n");

    if (nextRulesSection.length > maxChars) {
      omittedCount += candidateRules.length - index;
      break;
    }

    ruleLines.push(nextLine);
  }

  const rulesSection = [header, "", ...ruleLines];

  if (omittedCount > 0) {
    rulesSection.push(
      "",
      `Only ${ruleLines.length} of ${activeRules.length} rule(s) included here; ${omittedCount} omitted to keep initialization bounded.`,
    );
  }

  rulesSection.push("", footer);
  const composed = rulesSection.join("\n");
  const wasTrimmed = omittedCount > 0 || composed.length > maxChars;
  const bounded = truncateSectionWithMarker(composed, maxChars, wasTrimmed);

  return {
    section: bounded.length > 0 ? bounded : null,
    truncated: wasTrimmed,
  };
}

function formatInstructions(activeRules: RuleRecord[], tenantAgentInstructions: string | null): string {
  const baseSections: string[] = [BASE_INSTRUCTIONS, AGENT_CONTEXT_INSTRUCTION];
  const baseInstructions = baseSections.join("\n\n");
  let instructions = baseInstructions;

  const appendSection = (section: string): void => {
    instructions = `${instructions}\n\n${section}`;
  };

  if (tenantAgentInstructions?.trim()) {
    const normalizedTenantInstructions = normalizeInstructionText(tenantAgentInstructions);
    const tenantSection = `Tenant instructions:\n${normalizedTenantInstructions}`;
    const tenantBudget = MAX_INSTRUCTIONS_CHARS - instructions.length - 2;
    const tenantTruncated = tenantSection.length > tenantBudget;
    const boundedTenantSection = truncateSectionWithMarker(tenantSection, tenantBudget, tenantTruncated);

    if (boundedTenantSection.length > 0) {
      appendSection(boundedTenantSection);
    }

    if (tenantTruncated) {
      writeStructuredLog({
        level: "warn",
        message: "mcp.tenant_instructions.truncated",
        tenantInstructionChars: normalizedTenantInstructions.length,
        allowedChars: Math.max(0, tenantBudget),
      });
    }
  }

  const rulesBudget = MAX_INSTRUCTIONS_CHARS - instructions.length - 2;
  const { section: rulesSection, truncated: rulesTruncated } = formatRulesSection(activeRules, rulesBudget);
  if (rulesSection) {
    appendSection(rulesSection);
  }

  if (rulesTruncated) {
    writeStructuredLog({
      level: "warn",
      message: "mcp.rules_instructions.truncated",
      activeRuleCount: activeRules.length,
      allowedChars: Math.max(0, rulesBudget),
    });
  }

  return instructions;
}

async function fetchTenantAgentInstructions(
  sql: SqlClient,
  tenantSchemaName: string,
): Promise<string | null> {
  try {
    return await withTenantScope(sql, tenantSchemaName, async (txSql) => {
      const db = drizzle(asDrizzleSqlClient(txSql, sql.options));
      const rows = await db
        .select({
          tenantAgentInstructions: tenantSettings.tenantAgentInstructions,
        })
        .from(tenantSettings)
        .limit(1);
      return rows[0]?.tenantAgentInstructions ?? null;
    });
  } catch {
    return null;
  }
}

export async function createMcpServer(
  agentContext: AgentContext,
  tenantSchemaName: string,
  sql: SqlClient,
  options: CreateMcpServerOptions = {},
) {
  const tenantAgentInstructions = await fetchTenantAgentInstructions(sql, tenantSchemaName);
  const instructions = formatInstructions(options.activeRules ?? [], tenantAgentInstructions);
  const server = new McpServer({
    name: options.tenantSlug ? `monet-${options.tenantSlug}` : "monet",
    version: packageJson.version,
  }, { instructions });

  if (options.onInitialized) {
    server.server.oninitialized = () => {
      void options.onInitialized?.();
    };
  }

  const handlers: McpToolHandlers = {
    memoryStore: async (args) => {
      try {
        const preflight = await resolveMemoryWritePreflight(sql, tenantSchemaName, agentContext);
        const result = await withTenantScope(sql, tenantSchemaName, (txSql) =>
          createMemory(txSql, agentContext, {
            content: args.content,
            summary: args.summary,
            memoryType: args.memoryType,
            memoryScope: args.memoryScope,
            groupId: args.groupId,
            tags: args.tags,
            ttlSeconds: args.ttlSeconds,
          }, preflight),
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
        const result = await withTenantScope(sql, tenantSchemaName, async (txSql) => {
          const searchResult = await searchMemories(txSql, agentContext, args, queryEmbedding);
          if (hasError(searchResult)) {
            return searchResult;
          }
          await writeAuditLog(
            txSql as unknown as SqlClient,
            agentContext.tenantId,
            agentContext.id,
            "memory.search",
            null,
            "success",
            {
              resultCount: (searchResult as { items: unknown[] }).items.length,
              searchType: queryEmbedding ? "vector" : "text",
            },
          );
          return searchResult;
        });
        if (hasError(result)) {
          return asToolError(describeServiceError(result));
        }
        return asToolResult(result);
      } catch (error) {
        return asToolError(error instanceof Error ? error.message : "Internal server error");
      }
    },
    memoryFetch: async (args) => {
      try {
        const result = await withTenantScope(sql, tenantSchemaName, async (txSql) => {
          const fetchResult = await fetchMemory(txSql, agentContext, args.id);
          if (!hasError(fetchResult)) {
            await writeAuditLog(
              txSql as unknown as SqlClient,
              agentContext.tenantId,
              agentContext.id,
              "memory.get",
              args.id,
              "success",
            );
          }
          return fetchResult;
        });
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

        const updated = result as { entry: unknown; needsEnrichment?: boolean };
        if (updated.needsEnrichment) {
          enqueueEnrichment(sql, tenantSchemaName, args.id);
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
    agentContext: async () => {
      try {
        const groupMemberships = await withTenantScope(sql, tenantSchemaName, (txSql) =>
          getAgentGroupMemberships(txSql, agentContext.id),
        );
        return asToolResult({
          agentId: agentContext.id,
          externalId: agentContext.externalId,
          tenantSlug: options.tenantSlug,
          userBinding: agentContext.userId,
          groupMemberships,
        });
      } catch (error) {
        return asToolError(error instanceof Error ? error.message : "Internal server error");
      }
    },
  };

  const wrap = <TArgs,>(name: string, handler: (args: TArgs) => Promise<CallToolResult>) =>
    async (args: TArgs): Promise<CallToolResult> => {
      try {
        return await withToolTimeout(name, tenantSchemaName, agentContext.id, () => handler(args));
      } catch (error) {
        if (error instanceof McpToolTimeoutError) {
          return asToolError("Tool execution timed out");
        }
        throw error;
      }
    };

  const timedHandlers: McpToolHandlers = {
    memoryStore: wrap("memoryStore", handlers.memoryStore),
    memorySearch: wrap("memorySearch", handlers.memorySearch),
    memoryFetch: wrap("memoryFetch", handlers.memoryFetch),
    memoryUpdate: wrap("memoryUpdate", handlers.memoryUpdate),
    memoryDelete: wrap("memoryDelete", handlers.memoryDelete),
    memoryPromoteScope: wrap("memoryPromoteScope", handlers.memoryPromoteScope),
    memoryMarkOutdated: wrap("memoryMarkOutdated", handlers.memoryMarkOutdated),
    memoryListTags: wrap("memoryListTags", handlers.memoryListTags),
    agentContext: wrap("agentContext", handlers.agentContext),
  };

  registerAllTools(server, timedHandlers);
  return server;
}
