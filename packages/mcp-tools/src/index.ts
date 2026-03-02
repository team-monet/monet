import { z } from "zod";
import { MemoryScope, MemoryType } from "@monet/types";

/**
 * MCP tool definitions for the Monet.
 * These define the input schemas for each tool exposed by the MCP server.
 */

export const TOOL_MEMORY_STORE = "memory_store" as const;
export const TOOL_MEMORY_SEARCH = "memory_search" as const;
export const TOOL_MEMORY_FETCH = "memory_fetch" as const;
export const TOOL_MEMORY_DELETE = "memory_delete" as const;
export const TOOL_MEMORY_MARK_OUTDATED = "memory_mark_outdated" as const;
export const TOOL_MEMORY_LIST_TAGS = "memory_list_tags" as const;

export const MemoryStoreInput = z.object({
  content: z.string().describe("The knowledge or information to store"),
  memoryType: MemoryType.describe("Classification: decision, pattern, issue, preference, fact, or procedure"),
  memoryScope: MemoryScope.default("group").describe("Visibility scope: group, user, or private"),
  tags: z.array(z.string()).min(1).describe("Tags for categorization and retrieval"),
  ttlSeconds: z.number().positive().optional().describe("Optional expiry time in seconds"),
});

export const MemorySearchInput = z.object({
  query: z.string().optional().describe("Text query for semantic and full-text search"),
  tags: z.array(z.string()).optional().describe("Filter by tags"),
  memoryType: MemoryType.optional().describe("Filter by memory type"),
  includeUser: z.boolean().default(false).describe("Include user-scoped memories"),
  includePrivate: z.boolean().default(false).describe("Include private memories"),
  limit: z.number().int().positive().max(50).default(10).describe("Max results to return"),
});

export const MemoryFetchInput = z.object({
  id: z.string().uuid().describe("Memory entry ID to fetch full content"),
});

export const MemoryDeleteInput = z.object({
  id: z.string().uuid().describe("Memory entry ID to delete"),
});

export const MemoryMarkOutdatedInput = z.object({
  id: z.string().uuid().describe("Memory entry ID to mark as outdated"),
});

export const toolDefinitions = [
  {
    name: TOOL_MEMORY_STORE,
    description: "Store a new memory entry. The entry will be searchable by tag and full-text immediately. Semantic search becomes available after enrichment completes.",
    inputSchema: MemoryStoreInput,
  },
  {
    name: TOOL_MEMORY_SEARCH,
    description: "Search for memories. Returns lightweight summaries (Tier 1). Use memory_fetch to get full content for specific entries.",
    inputSchema: MemorySearchInput,
  },
  {
    name: TOOL_MEMORY_FETCH,
    description: "Fetch the full content and version history of a specific memory entry (Tier 2). Increments the entry's usefulness score.",
    inputSchema: MemoryFetchInput,
  },
  {
    name: TOOL_MEMORY_DELETE,
    description: "Delete a memory entry you authored. Removes the entry and all its version history.",
    inputSchema: MemoryDeleteInput,
  },
  {
    name: TOOL_MEMORY_MARK_OUTDATED,
    description: "Mark a memory entry as outdated. The entry remains searchable but is ranked lower in results.",
    inputSchema: MemoryMarkOutdatedInput,
  },
  {
    name: TOOL_MEMORY_LIST_TAGS,
    description: "List all unique tags across memories in your accessible scopes.",
    inputSchema: z.object({}),
  },
] as const;
