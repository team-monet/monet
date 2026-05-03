import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MemoryScope,
  MemoryType,
  UpdateMemoryEntryInput,
} from "@monet/types";

/**
 * MCP tool definitions for the Monet.
 * These define the input schemas for each tool exposed by the MCP server.
 */

export const TOOL_MEMORY_STORE = "memory_store" as const;
export const TOOL_MEMORY_SEARCH = "memory_search" as const;
export const TOOL_MEMORY_FETCH = "memory_fetch" as const;
export const TOOL_MEMORY_UPDATE = "memory_update" as const;
export const TOOL_MEMORY_DELETE = "memory_delete" as const;
export const TOOL_MEMORY_PROMOTE_SCOPE = "memory_promote_scope" as const;
export const TOOL_MEMORY_MARK_OUTDATED = "memory_mark_outdated" as const;
export const TOOL_MEMORY_LIST_TAGS = "memory_list_tags" as const;

export const MemoryStoreInput = z.object({
  content: z.string().describe("The knowledge or information to store"),
  summary: z.string().max(200).optional().describe("Optional human/agent-provided summary of the memory entry. Required when chat enrichment is disabled. Maximum 200 characters. Safe to always provide regardless of provider mode."),
  memoryType: MemoryType.describe("Classification for the memory entry. \"decision\": a chosen course of action. \"pattern\": a repeatable best practice. \"issue\": a problem, failure, or incident record. \"preference\": a user or team preference. \"fact\": objective reference information. \"procedure\": step-by-step instructions."),
  memoryScope: MemoryScope.default("group").describe("Visibility scope for the memory entry. \"private\": only the creating agent can access. \"user\": all agents created by the same user, within the same group, can access. \"group\": all agents in the group can access, including those created by other users."),
  tags: z.array(z.string()).min(1).describe("Tags for categorization and retrieval"),
  ttlSeconds: z.number().positive().optional().describe("Optional expiry time in seconds"),
});

export const MemorySearchInput = z.object({
  query: z.string().optional().describe("Text query for semantic and full-text search"),
  tags: z.array(z.string()).optional().describe("Filter by tags"),
  memoryType: MemoryType.optional().describe("Filter by memory type. \"decision\": a chosen course of action. \"pattern\": a repeatable best practice. \"issue\": a problem, failure, or incident record. \"preference\": a user or team preference. \"fact\": objective reference information. \"procedure\": step-by-step instructions."),
  includeUser: z.boolean().default(false).describe("Include \"user\" scope memories (shared across the same user's agents within the same group)"),
  includePrivate: z.boolean().default(false).describe("Include \"private\" scope memories (visible only to the creating agent)"),
  createdAfter: z.string().datetime().optional().describe("Only include memories created on or after this timestamp"),
  createdBefore: z.string().datetime().optional().describe("Only include memories created on or before this timestamp"),
  accessedAfter: z.string().datetime().optional().describe("Only include memories accessed on or after this timestamp"),
  accessedBefore: z.string().datetime().optional().describe("Only include memories accessed on or before this timestamp"),
  cursor: z.string().optional().describe("Opaque cursor for ranked pagination"),
  limit: z.number().int().positive().max(50).default(10).describe("Max results to return"),
  groupId: z.string().uuid().optional().describe("Filter to a specific agent group"),
});

export const MemoryFetchInput = z.object({
  id: z.string().uuid().describe("Memory entry ID to fetch full content"),
});

export const MemoryUpdateInput = UpdateMemoryEntryInput.extend({
  id: z.string().uuid().describe("Memory entry ID to update"),
  memoryScope: MemoryScope.optional().describe("Visibility scope for the memory entry. \"private\": only the creating agent can access. \"user\": all agents created by the same user, within the same group, can access. \"group\": all agents in the group can access, including those created by other users."),
  memoryType: MemoryType.optional().describe("Classification for the memory entry. \"decision\": a chosen course of action. \"pattern\": a repeatable best practice. \"issue\": a problem, failure, or incident record. \"preference\": a user or team preference. \"fact\": objective reference information. \"procedure\": step-by-step instructions."),
  expectedVersion: z.number().int().nonnegative().describe("Current version of the memory entry for optimistic concurrency. The update will be rejected if the version does not match."),
});

export const MemoryDeleteInput = z.object({
  id: z.string().uuid().describe("Memory entry ID to delete"),
});

export const MemoryPromoteScopeInput = z.object({
  id: z.string().uuid().describe("Memory entry ID whose scope should change"),
  scope: MemoryScope.describe("New visibility scope for the memory entry. \"private\": only the creating agent can access. \"user\": all agents created by the same user, within the same group, can access. \"group\": all agents in the group can access, including those created by other users."),
});

export const MemoryMarkOutdatedInput = z.object({
  id: z.string().uuid().describe("Memory entry ID to mark as outdated"),
});

export const MemoryListTagsInput = z.object({
  includeUser: z.boolean().default(false).describe("Include \"user\" scope memories (shared across the same user's agents within the same group)"),
  includePrivate: z.boolean().default(false).describe("Include \"private\" scope memories (visible only to the creating agent)"),
});

export const toolDefinitions = [
  {
    name: TOOL_MEMORY_STORE,
    description:
      "Store a new memory entry. Use this PROACTIVELY whenever you discover something worth remembering: decisions made, problems solved, patterns identified, user preferences learned, procedures followed, or important facts encountered. The entry will be searchable by tag and full-text immediately; semantic search becomes available after enrichment completes. Choose memoryType carefully (decision, pattern, issue, preference, fact, procedure) and always include descriptive tags for future retrieval. When chat enrichment is disabled, you must provide both summary and tags.",
    inputSchema: MemoryStoreInput,
  },
  {
    name: TOOL_MEMORY_SEARCH,
    description:
      "Search for memories. Use this BEFORE starting any non-trivial task to check for relevant prior context — previous decisions, known issues, established patterns, or user preferences. Also use this when the user references something discussed in a prior session. Returns lightweight summaries (Tier 1); use memory_fetch to get full content for specific entries.",
    inputSchema: MemorySearchInput,
  },
  {
    name: TOOL_MEMORY_FETCH,
    description:
      "Fetch the full content and version history of a specific memory entry (Tier 2). Use this after memory_search returns a relevant result and you need the complete details to act on it. Increments the entry's usefulness score.",
    inputSchema: MemoryFetchInput,
  },
  {
    name: TOOL_MEMORY_UPDATE,
    description:
      "Update the content or tags of a memory entry using optimistic concurrency via expectedVersion. Use this when information has changed — a decision was revised, a procedure was updated, or a fact is now more complete. Always update rather than creating duplicates.",
    inputSchema: MemoryUpdateInput,
  },
  {
    name: TOOL_MEMORY_DELETE,
    description:
      "Delete a memory entry you authored. Use this to remove entries that are completely wrong or no longer relevant. For information that is simply outdated but still useful as historical context, prefer memory_mark_outdated instead.",
    inputSchema: MemoryDeleteInput,
  },
  {
    name: TOOL_MEMORY_PROMOTE_SCOPE,
    description:
      "Change a memory's visibility scope (\"private\" = creating agent only, \"user\" = same user's agents in the group, \"group\" = all agents in the group). Promotion widens visibility to a broader audience; demotion (narrowing) is allowed only by the original author. Use this when a memory should be shared more widely or restricted after reconsideration.",
    inputSchema: MemoryPromoteScopeInput,
  },
  {
    name: TOOL_MEMORY_MARK_OUTDATED,
    description:
      "Mark a memory entry as outdated. Use this when information is no longer current but still has historical value. The entry remains searchable but is ranked lower in results. Prefer this over deletion when the old context might still be useful for understanding past decisions.",
    inputSchema: MemoryMarkOutdatedInput,
  },
  {
    name: TOOL_MEMORY_LIST_TAGS,
    description:
      "List all unique tags across memories in your accessible scopes. Use this to discover the existing tag vocabulary before storing new memories, so you can reuse established tags and maintain consistency.",
    inputSchema: MemoryListTagsInput,
  },
] as const;

function toolDescription(name: (typeof toolDefinitions)[number]["name"]) {
  const def = toolDefinitions.find((tool) => tool.name === name);
  if (!def) {
    throw new Error(`Missing tool definition for ${name}`);
  }
  return def.description;
}

export interface McpToolHandlers {
  memoryStore: (args: z.infer<typeof MemoryStoreInput>) => Promise<CallToolResult>;
  memorySearch: (args: z.infer<typeof MemorySearchInput>) => Promise<CallToolResult>;
  memoryFetch: (args: z.infer<typeof MemoryFetchInput>) => Promise<CallToolResult>;
  memoryUpdate: (args: z.infer<typeof MemoryUpdateInput>) => Promise<CallToolResult>;
  memoryDelete: (args: z.infer<typeof MemoryDeleteInput>) => Promise<CallToolResult>;
  memoryPromoteScope: (args: z.infer<typeof MemoryPromoteScopeInput>) => Promise<CallToolResult>;
  memoryMarkOutdated: (args: z.infer<typeof MemoryMarkOutdatedInput>) => Promise<CallToolResult>;
  memoryListTags: (args: z.infer<typeof MemoryListTagsInput>) => Promise<CallToolResult>;
}

export function registerAllTools(
  server: McpServer,
  handlers: McpToolHandlers,
) {
  server.registerTool(TOOL_MEMORY_STORE, {
    description: toolDescription(TOOL_MEMORY_STORE),
    inputSchema: MemoryStoreInput,
  }, handlers.memoryStore);

  server.registerTool(TOOL_MEMORY_SEARCH, {
    description: toolDescription(TOOL_MEMORY_SEARCH),
    inputSchema: MemorySearchInput,
  }, handlers.memorySearch);

  server.registerTool(TOOL_MEMORY_FETCH, {
    description: toolDescription(TOOL_MEMORY_FETCH),
    inputSchema: MemoryFetchInput,
  }, handlers.memoryFetch);

  server.registerTool(TOOL_MEMORY_UPDATE, {
    description: toolDescription(TOOL_MEMORY_UPDATE),
    inputSchema: MemoryUpdateInput,
  }, handlers.memoryUpdate);

  server.registerTool(TOOL_MEMORY_DELETE, {
    description: toolDescription(TOOL_MEMORY_DELETE),
    inputSchema: MemoryDeleteInput,
  }, handlers.memoryDelete);

  server.registerTool(TOOL_MEMORY_PROMOTE_SCOPE, {
    description: toolDescription(TOOL_MEMORY_PROMOTE_SCOPE),
    inputSchema: MemoryPromoteScopeInput,
  }, handlers.memoryPromoteScope);

  server.registerTool(TOOL_MEMORY_MARK_OUTDATED, {
    description: toolDescription(TOOL_MEMORY_MARK_OUTDATED),
    inputSchema: MemoryMarkOutdatedInput,
  }, handlers.memoryMarkOutdated);

  server.registerTool(TOOL_MEMORY_LIST_TAGS, {
    description: toolDescription(TOOL_MEMORY_LIST_TAGS),
    inputSchema: MemoryListTagsInput,
  }, handlers.memoryListTags);
}
