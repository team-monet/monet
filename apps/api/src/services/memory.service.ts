import {
  agentGroupMembers,
  agentGroups,
  agents,
  asDrizzleSqlClient,
  auditLog,
  memoryEntries,
  memoryVersions,
  withTenantDrizzleScope,
  type SqlClient,
  type TransactionClient,
  tenantUsers,
} from "@monet/db";
import {
  and,
  arrayOverlaps,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  or,
  sql as drizzleSql,
  type SQL,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { z } from "zod";
import type { AgentContext } from "../middleware/context";
import type {
  CreateMemoryEntryInput,
  MemoryEntryTier1,
  UpdateMemoryEntryInput,
} from "@monet/types";
import { resolveConfiguredProviders } from "../providers";

type MemorySqlClient = SqlClient | TransactionClient;
type MemoryDrizzleOptions = NonNullable<SqlClient["options"]>;

function createMemoryDb(
  sql: MemorySqlClient,
  options?: MemoryDrizzleOptions,
) {
  return drizzle(asDrizzleSqlClient(sql, options));
}

const MEMORY_ENTRY_RETURNING = {
  id: memoryEntries.id,
  content: memoryEntries.content,
  summary: memoryEntries.summary,
  memory_type: memoryEntries.memoryType,
  memory_scope: memoryEntries.memoryScope,
  tags: memoryEntries.tags,
  auto_tags: memoryEntries.autoTags,
  related_memory_ids: memoryEntries.relatedMemoryIds,
  usefulness_score: memoryEntries.usefulnessScore,
  outdated: memoryEntries.outdated,
  ttl_seconds: memoryEntries.ttlSeconds,
  expires_at: memoryEntries.expiresAt,
  created_at: memoryEntries.createdAt,
  last_accessed_at: memoryEntries.lastAccessedAt,
  author_agent_id: memoryEntries.authorAgentId,
  group_id: memoryEntries.groupId,
  user_id: memoryEntries.userId,
  version: memoryEntries.version,
};

const MEMORY_ENTRY_WITH_AUTHOR_SELECT = {
  ...MEMORY_ENTRY_RETURNING,
  author_agent_display_name: drizzleSql<string | null>`
    CASE
      WHEN ${agents.id} IS NULL THEN NULL
      WHEN ${agents.isAutonomous} THEN ${agents.externalId} || ' (Autonomous)'
      WHEN ${tenantUsers.email} IS NOT NULL THEN ${agents.externalId} || ' · ' || ${tenantUsers.email}
      WHEN ${tenantUsers.externalId} IS NOT NULL THEN ${agents.externalId} || ' · ' || ${tenantUsers.externalId}
      ELSE ${agents.externalId}
    END
  `,
};

const MEMORY_VERSION_RETURNING = {
  id: memoryVersions.id,
  memory_entry_id: memoryVersions.memoryEntryId,
  content: memoryVersions.content,
  version: memoryVersions.version,
  author_agent_id: memoryVersions.authorAgentId,
  created_at: memoryVersions.createdAt,
};

const MAX_HYBRID_CURSOR_OFFSET = 1000;

// ---------- Cursor helpers ----------

interface SearchCursorPayload {
  createdAt: string;
  id: string;
  rank?: number;
  offset?: number;
}

export function encodeCursor(
  createdAt: string,
  id: string,
  rank?: number,
  offset?: number,
): string {
  return Buffer.from(JSON.stringify({ createdAt, id, rank, offset })).toString("base64url");
}

const SearchCursorSchema = z.object({
  createdAt: z.string(),
  id: z.string(),
  rank: z.number().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export function decodeCursor(cursor: string): SearchCursorPayload | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
    return SearchCursorSchema.parse(raw);
  } catch {
    return null;
  }
}

// ---------- Row mapping ----------

function mapRow(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    content: row.content as string,
    summary: (row.summary as string) ?? null,
    memoryType: row.memory_type as string,
    memoryScope: row.memory_scope as string,
    tags: (row.tags as string[]) ?? [],
    autoTags: (row.auto_tags as string[]) ?? [],
    relatedMemoryIds: (row.related_memory_ids as string[]) ?? [],
    usefulnessScore: row.usefulness_score as number,
    outdated: row.outdated as boolean,
    ttlSeconds: (row.ttl_seconds as number) ?? null,
    expiresAt: row.expires_at ? asTimestamp(row.expires_at) : null,
    createdAt: asTimestamp(row.created_at),
    lastAccessedAt: asTimestamp(row.last_accessed_at),
    authorAgentId: row.author_agent_id as string,
    authorAgentDisplayName: (row.author_agent_display_name as string | null) ?? null,
    groupId: (row.group_id as string) ?? null,
    userId: (row.user_id as string) ?? null,
    version: row.version as number,
  };
}

function mapVersion(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    memoryEntryId: row.memory_entry_id as string,
    content: row.content as string,
    version: row.version as number,
    authorAgentId: row.author_agent_id as string,
    createdAt: asTimestamp(row.created_at),
  };
}

function mapTier1Row(row: Record<string, unknown>): MemoryEntryTier1 {
  return {
    id: row.id as string,
    summary: buildSummary((row.summary as string) ?? null, row.content as string),
    memoryType: row.memory_type as MemoryEntryTier1["memoryType"],
    memoryScope: row.memory_scope as MemoryEntryTier1["memoryScope"],
    tags: (row.tags as string[]) ?? [],
    autoTags: (row.auto_tags as string[]) ?? [],
    usefulnessScore: row.usefulness_score as number,
    outdated: row.outdated as boolean,
    createdAt: new Date(asTimestamp(row.created_at)),
    authorAgentId: row.author_agent_id as string,
    authorAgentDisplayName: (row.author_agent_display_name as string | null) ?? null,
  };
}

// ---------- Audit log ----------

export async function writeAuditLog(
  tx: MemorySqlClient,
  tenantId: string,
  agentId: string,
  action: string,
  targetId: string | null,
  outcome: string,
  metadata?: Record<string, unknown>,
) {
  const db = createMemoryDb(tx);
  await db.insert(auditLog).values({
    tenantId,
    actorId: agentId,
    actorType: "agent",
    action,
    targetId,
    outcome,
    metadata: metadata ?? null,
  });
}

// ---------- Scope filter ----------

export interface ScopeFilterOpts {
  includeUser: boolean;
  includePrivate: boolean;
}

export interface MemoryWritePreflight {
  hasGroupMembership: boolean;
  memoryQuota: number | null;
  groupId: string | null;
}

async function getAgentGroupIds(
  txSql: MemorySqlClient,
  agentId: string,
): Promise<string[]> {
  const db = createMemoryDb(txSql);
  const rows = await db
    .select({ groupId: agentGroupMembers.groupId })
    .from(agentGroupMembers)
    .where(eq(agentGroupMembers.agentId, agentId));
  return rows.map((r) => r.groupId);
}

function buildScopeFilterCondition(
  agent: AgentContext,
  opts: ScopeFilterOpts,
  agentReadableGroupIds: string[],
): SQL<unknown> {
  const conditions: SQL<unknown>[] = [];

  if (agentReadableGroupIds.length > 0) {
    conditions.push(
      and(
        eq(memoryEntries.memoryScope, "group"),
        inArray(memoryEntries.groupId, agentReadableGroupIds),
      )!,
    );
  } else {
    conditions.push(drizzleSql`FALSE`);
  }

  if (opts.includeUser && agent.userId) {
    conditions.push(
      and(
        eq(memoryEntries.memoryScope, "user"),
        eq(memoryEntries.userId, agent.userId),
        inArray(memoryEntries.groupId, agentReadableGroupIds),
      )!,
    );
  }

  if (opts.includePrivate) {
    conditions.push(
      and(
        eq(memoryEntries.memoryScope, "private"),
        eq(memoryEntries.authorAgentId, agent.id),
      )!,
    );
  }

  return conditions.length === 1 ? conditions[0] : or(...conditions)!;
}

function buildNonExpiredCondition(): SQL<unknown> {
  return or(
    drizzleSql`${memoryEntries.expiresAt} IS NULL`,
    drizzleSql`${memoryEntries.expiresAt} > NOW()`,
  )!;
}

function buildCreatedAtCursorCondition(cursor: SearchCursorPayload): SQL<unknown> {
  return or(
    drizzleSql`${memoryEntries.createdAt} < ${cursor.createdAt}::timestamptz`,
    and(
      drizzleSql`${memoryEntries.createdAt} = ${cursor.createdAt}::timestamptz`,
      lt(memoryEntries.id, cursor.id),
    )!,
  )!;
}

function buildSearchRankExpression(
  queryEmbedding: number[] | null,
): SQL<number | null> {
  const usefulnessWeight = drizzleSql`(1 + LN(1 + GREATEST(${memoryEntries.usefulnessScore}, 0)))`;
  const outdatedWeight = drizzleSql`CASE WHEN ${memoryEntries.outdated} THEN 0.5 ELSE 1.0 END`;

  if (!queryEmbedding) {
    return drizzleSql<number>`(${usefulnessWeight} * ${outdatedWeight})`;
  }

  const vectorLiteral = toVectorLiteral(queryEmbedding);
  return drizzleSql<number | null>`
    CASE
      WHEN ${memoryEntries.embedding} IS NULL THEN NULL
      ELSE ((1 - (${memoryEntries.embedding} <=> ${vectorLiteral}::vector)) * ${usefulnessWeight} * ${outdatedWeight})
    END
  `;
}

function buildLexicalQueryCondition(queryText: string): SQL<unknown> {
  const lexicalRankExpression = buildLexicalMatchCountExpression(queryText);
  return drizzleSql`${lexicalRankExpression} > 0`;
}

function buildLexicalMatchCountExpression(queryText: string): SQL<number> {
  const likePattern = `%${escapeLike(queryText)}%`;

  return drizzleSql<number>`(
    CASE WHEN ${memoryEntries.content} ILIKE ${likePattern} ESCAPE '\\' THEN 1 ELSE 0 END +
    CASE WHEN ${memoryEntries.summary} ILIKE ${likePattern} ESCAPE '\\' THEN 1 ELSE 0 END +
    CASE WHEN COALESCE(array_to_string(${memoryEntries.tags}, ' '), '') ILIKE ${likePattern} ESCAPE '\\' THEN 1 ELSE 0 END +
    CASE WHEN COALESCE(array_to_string(${memoryEntries.autoTags}, ' '), '') ILIKE ${likePattern} ESCAPE '\\' THEN 1 ELSE 0 END
  )`;
}

function escapeLike(text: string): string {
  return text.replace(/[%_\\]/g, "\\$&");
}

function buildSearchCursorCondition(
  rankExpression: SQL<number | null>,
  cursor: SearchCursorPayload,
): SQL<unknown> {
  const createdAtCursorCondition = buildCreatedAtCursorCondition(cursor);

  if (cursor.rank === undefined) {
    return createdAtCursorCondition;
  }

  return or(
    lt(rankExpression, cursor.rank),
    and(eq(rankExpression, cursor.rank), createdAtCursorCondition)!,
  )!;
}

// ---------- Quota ----------

const DEFAULT_MEMORY_QUOTA = 10000;

export async function resolveMemoryWritePreflight(
  platformSql: SqlClient | null,
  schemaNameOrAgent: string | AgentContext,
  maybeAgent?: AgentContext,
): Promise<MemoryWritePreflight | null> {
  if (!platformSql) {
    return null;
  }

  const agent = typeof schemaNameOrAgent === "string" ? maybeAgent : schemaNameOrAgent;
  const schemaName = typeof schemaNameOrAgent === "string"
    ? schemaNameOrAgent
    : `tenant_${schemaNameOrAgent.tenantId.replace(/-/g, "_")}`;

  if (!agent) {
    return null;
  }

  const rows = await withTenantDrizzleScope(platformSql, schemaName, async (db) => db
    .select({
      memoryQuota: agentGroups.memoryQuota,
      groupId: agentGroups.id,
    })
    .from(agentGroupMembers)
    .innerJoin(agentGroups, eq(agentGroups.id, agentGroupMembers.groupId))
    .where(eq(agentGroupMembers.agentId, agent.id))
    .limit(1));

  if (rows.length === 0) {
    return {
      hasGroupMembership: false,
      memoryQuota: null,
      groupId: null,
    };
  }

  return {
    hasGroupMembership: true,
    memoryQuota: rows[0].memoryQuota ?? null,
    groupId: rows[0].groupId ?? null,
  };
}

/**
 * Check memory quota before insert. Returns error if exceeded.
 * Quota is resolved from the agent's group (memory_quota column) or falls back to a default.
 */
export async function checkQuota(
  tx: MemorySqlClient,
  agent: AgentContext,
  quotaOverride: number | null = null,
): Promise<{ error: "quota_exceeded"; limit: number; current: number } | null> {
  // 0 = explicitly unlimited (admin cleared the quota), skip check entirely
  if (quotaOverride === 0) return null;
  const quota = quotaOverride && quotaOverride > 0 ? quotaOverride : DEFAULT_MEMORY_QUOTA;

  const db = createMemoryDb(tx);
  const [result] = await db
    .select({
      count: drizzleSql<number>`count(*)`.mapWith(Number),
    })
    .from(memoryEntries)
    .where(eq(memoryEntries.authorAgentId, agent.id));
  const current = result?.count ?? 0;

  if (current >= quota) {
    return { error: "quota_exceeded", limit: quota, current };
  }

  return null;
}

// ---------- Core CRUD ----------

export async function createMemory(
  txSql: TransactionClient,
  agent: AgentContext,
  input: CreateMemoryEntryInput,
  preflight: MemoryWritePreflight | null = null,
) {
  const db = createMemoryDb(txSql);
  const { chatProvider } = resolveConfiguredProviders();
  const providedSummary = input.summary?.trim();

  // Autonomous agents cannot store user-scoped entries (they have no user binding)
  if (agent.isAutonomous && input.memoryScope === "user") {
    return { error: "validation" as const, message: "Autonomous agents cannot store user-scoped memories" };
  }

  // Group-scoped entries require group membership (M2 spec)
  if (input.memoryScope === "group" && preflight && !preflight.hasGroupMembership) {
      return { error: "validation" as const, message: "Agent must belong to a group to store group-scoped memories" };
  }

  if (chatProvider === "none" && !providedSummary) {
    return { error: "validation" as const, message: "summary is required when chat enrichment is disabled" };
  }

  // Quota enforcement
  const quotaErr = await checkQuota(txSql, agent, preflight?.memoryQuota ?? null);
  if (quotaErr) return quotaErr;

  const expiresAt = input.ttlSeconds
    ? new Date(Date.now() + input.ttlSeconds * 1000)
    : null;

  const groupId = preflight?.groupId ?? null;

  const [entry] = await db
    .insert(memoryEntries)
    .values({
      content: input.content,
      summary: providedSummary || null,
      memoryType: input.memoryType,
      memoryScope: input.memoryScope,
      tags: input.tags,
      ttlSeconds: input.ttlSeconds ?? null,
      expiresAt,
      authorAgentId: agent.id,
      userId: agent.userId,
      groupId,
      version: 0,
    })
    .returning(MEMORY_ENTRY_RETURNING);

  // Insert initial version snapshot (v0)
  await db.insert(memoryVersions).values({
    memoryEntryId: entry.id,
    content: input.content,
    version: 0,
    authorAgentId: agent.id,
  });

  // Audit log
  await writeAuditLog(txSql, agent.tenantId, agent.id, "memory.create", entry.id, "success");

  return mapRow(entry as Record<string, unknown>);
}

export async function searchMemories(
  txSql: TransactionClient,
  agent: AgentContext,
  query: {
    query?: string;
    tags?: string[];
    memoryType?: string;
    includeUser?: boolean;
    includePrivate?: boolean;
    createdAfter?: string;
    createdBefore?: string;
    accessedAfter?: string;
    accessedBefore?: string;
    cursor?: string;
    limit?: number;
    groupId?: string;
  },
  queryEmbedding: number[] | null = null,
): Promise<{ items: MemoryEntryTier1[]; nextCursor: string | null } | { error: "forbidden" }> {
  const agentReadableGroupIds = await getAgentGroupIds(txSql, agent.id);

  if (query.groupId && !agentReadableGroupIds.includes(query.groupId)) {
    return { error: "forbidden" };
  }

  const effectiveGroupIds = query.groupId ? [query.groupId] : agentReadableGroupIds;

  const db = createMemoryDb(txSql);
  const limit = query.limit ?? 20;
  const rankExpression = buildSearchRankExpression(queryEmbedding);
  const lexicalRankExpression = query.query
    ? buildLexicalMatchCountExpression(query.query)
    : null;
  const hybridSearch = Boolean(queryEmbedding && lexicalRankExpression);
  const baseConditions: SQL<unknown>[] = [
    buildScopeFilterCondition(agent, {
      includeUser: query.includeUser ?? false,
      includePrivate: query.includePrivate ?? false,
    }, effectiveGroupIds),
    buildNonExpiredCondition(),
    eq(memoryEntries.outdated, false),
  ];

  const lexicalCondition = query.query
    ? buildLexicalQueryCondition(query.query)
    : null;

  if (query.tags && query.tags.length > 0) {
    baseConditions.push(arrayOverlaps(memoryEntries.tags, query.tags));
  }

  if (query.memoryType) {
    baseConditions.push(
      drizzleSql`${memoryEntries.memoryType} = ${query.memoryType}::memory_type`,
    );
  }

  if (query.createdAfter) {
    baseConditions.push(
      drizzleSql`${memoryEntries.createdAt} >= ${query.createdAfter}::timestamptz`,
    );
  }
  if (query.createdBefore) {
    baseConditions.push(
      drizzleSql`${memoryEntries.createdAt} <= ${query.createdBefore}::timestamptz`,
    );
  }
  if (query.accessedAfter) {
    baseConditions.push(
      drizzleSql`${memoryEntries.lastAccessedAt} >= ${query.accessedAfter}::timestamptz`,
    );
  }
  if (query.accessedBefore) {
    baseConditions.push(
      drizzleSql`${memoryEntries.lastAccessedAt} <= ${query.accessedBefore}::timestamptz`,
    );
  }

  const decodedCursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (decodedCursor && !hybridSearch) {
    const cursorCondition = buildSearchCursorCondition(rankExpression, decodedCursor);
    baseConditions.push(cursorCondition);
  }

  if (hybridSearch && lexicalCondition && lexicalRankExpression) {
    const pageOffset = decodedCursor?.offset ?? 0;
    const boundedOffset = Math.min(pageOffset, MAX_HYBRID_CURSOR_OFFSET);
    const pageWindow = boundedOffset + limit + 1;
    const candidateLimit = Math.max(pageWindow, Math.min(pageWindow * 3, 3000));

    const semanticRows = await db
      .select({
        ...MEMORY_ENTRY_WITH_AUTHOR_SELECT,
        search_rank: rankExpression,
      })
      .from(memoryEntries)
      .leftJoin(agents, eq(agents.id, memoryEntries.authorAgentId))
      .leftJoin(tenantUsers, eq(tenantUsers.id, agents.userId))
      .where(and(...baseConditions, isNotNull(memoryEntries.embedding)))
      .orderBy(
        drizzleSql`${rankExpression} DESC NULLS LAST`,
        desc(memoryEntries.createdAt),
        desc(memoryEntries.id),
      )
      .limit(candidateLimit);

    const lexicalRows = await db
      .select({
        ...MEMORY_ENTRY_WITH_AUTHOR_SELECT,
        search_rank: lexicalRankExpression,
      })
      .from(memoryEntries)
      .leftJoin(agents, eq(agents.id, memoryEntries.authorAgentId))
      .leftJoin(tenantUsers, eq(tenantUsers.id, agents.userId))
      .where(and(...baseConditions, lexicalCondition))
      .orderBy(
        drizzleSql`${lexicalRankExpression} DESC NULLS LAST`,
        desc(memoryEntries.createdAt),
        desc(memoryEntries.id),
      )
      .limit(candidateLimit);

    const fusedById = new Map<
      string,
      {
        row: Record<string, unknown>;
        score: number;
        seenSemantic: boolean;
        seenLexical: boolean;
      }
    >();

    const RRF_K = 60;
    const OVERLAP_BOOST = 1 / RRF_K;
    const addRows = (rows: Record<string, unknown>[], source: "semantic" | "lexical") => {
      rows.forEach((row, index) => {
        const id = row.id as string;
        const existing = fusedById.get(id);
        const rrf = 1 / (RRF_K + index + 1);

        if (existing) {
          existing.score += rrf;
          if (source === "semantic") {
            existing.seenSemantic = true;
          } else {
            existing.seenLexical = true;
          }
          return;
        }

        fusedById.set(id, {
          row,
          score: rrf,
          seenSemantic: source === "semantic",
          seenLexical: source === "lexical",
        });
      });
    };

    addRows(semanticRows as Record<string, unknown>[], "semantic");
    addRows(lexicalRows as Record<string, unknown>[], "lexical");

    const fusedRows = Array.from(fusedById.values())
      .map((entry) => ({
        ...entry,
        score: entry.score + (entry.seenSemantic && entry.seenLexical ? OVERLAP_BOOST : 0),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }

        const aCreatedAt = asTimestamp(a.row.created_at);
        const bCreatedAt = asTimestamp(b.row.created_at);
        if (bCreatedAt !== aCreatedAt) {
          return bCreatedAt.localeCompare(aCreatedAt);
        }

        return (b.row.id as string).localeCompare(a.row.id as string);
      });

    const pageRows = fusedRows.slice(pageOffset, pageOffset + limit + 1);
    const hasMore = pageRows.length > limit;
    const items = pageRows.slice(0, limit).map((entry) => mapTier1Row(entry.row));

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = pageRows[Math.min(limit - 1, pageRows.length - 1)];
      nextCursor = encodeCursor(
        asTimestamp(last.row.created_at),
        last.row.id as string,
        undefined,
        pageOffset + limit,
      );
    }

    return { items, nextCursor };
  }

  const conditions = [...baseConditions];
  if (lexicalCondition) {
    conditions.push(lexicalCondition);
  }

  const rows = await db
    .select({
      ...MEMORY_ENTRY_WITH_AUTHOR_SELECT,
      search_rank: rankExpression,
    })
    .from(memoryEntries)
    .leftJoin(agents, eq(agents.id, memoryEntries.authorAgentId))
    .leftJoin(tenantUsers, eq(tenantUsers.id, agents.userId))
    .where(and(...conditions))
    .orderBy(
      drizzleSql`${rankExpression} DESC NULLS LAST`,
      desc(memoryEntries.createdAt),
      desc(memoryEntries.id),
    )
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = (rows.slice(0, limit) as Record<string, unknown>[]).map(mapTier1Row);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = rows[Math.min(limit - 1, rows.length - 1)] as Record<string, unknown>;
    nextCursor = encodeCursor(
      asTimestamp(last.created_at),
      last.id as string,
      Number(last.search_rank),
    );
  }

  return { items, nextCursor };
}

export async function listAgentMemories(
  txSql: TransactionClient,
  agent: AgentContext,
  targetAgentId: string,
  query: {
    cursor?: string;
    limit?: number;
    groupId?: string;
  },
): Promise<{ items: MemoryEntryTier1[]; nextCursor: string | null } | { error: "forbidden" }> {
  const agentReadableGroupIds = await getAgentGroupIds(txSql, agent.id);

  if (query.groupId && !agentReadableGroupIds.includes(query.groupId)) {
    return { error: "forbidden" };
  }

  const effectiveGroupIds = query.groupId ? [query.groupId] : agentReadableGroupIds;

  const db = createMemoryDb(txSql);
  const limit = query.limit ?? 20;
  const conditions: SQL<unknown>[] = [
    eq(memoryEntries.authorAgentId, targetAgentId),
    eq(memoryEntries.memoryScope, "group"),
    buildNonExpiredCondition(),
  ];

  if (effectiveGroupIds.length > 0) {
    conditions.push(inArray(memoryEntries.groupId, effectiveGroupIds));
    conditions.push(isNotNull(memoryEntries.groupId));
  } else {
    conditions.push(drizzleSql`FALSE`);
  }

  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    if (decoded) {
      conditions.push(buildCreatedAtCursorCondition(decoded));
    }
  }

  const rows = await db
    .select(MEMORY_ENTRY_WITH_AUTHOR_SELECT)
    .from(memoryEntries)
    .leftJoin(agents, eq(agents.id, memoryEntries.authorAgentId))
    .leftJoin(tenantUsers, eq(tenantUsers.id, agents.userId))
    .where(and(...conditions))
    .orderBy(desc(memoryEntries.createdAt), desc(memoryEntries.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = (rows.slice(0, limit) as Record<string, unknown>[]).map(mapTier1Row);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = rows[Math.min(limit - 1, rows.length - 1)] as Record<string, unknown>;
    nextCursor = encodeCursor(
      asTimestamp(last.created_at),
      last.id as string,
    );
  }

  return { items, nextCursor };
}

export async function fetchMemory(
  txSql: TransactionClient,
  agent: AgentContext,
  id: string,
): Promise<{ error: "not_found" } | { error: "forbidden" } | { entry: ReturnType<typeof mapRow>; versions: ReturnType<typeof mapVersion>[] }> {
  const agentReadableGroupIds = await getAgentGroupIds(txSql, agent.id);

  const db = createMemoryDb(txSql);
  const [entry] = await db
    .select(MEMORY_ENTRY_WITH_AUTHOR_SELECT)
    .from(memoryEntries)
    .leftJoin(agents, eq(agents.id, memoryEntries.authorAgentId))
    .leftJoin(tenantUsers, eq(tenantUsers.id, agents.userId))
    .where(eq(memoryEntries.id, id))
    .limit(1);

  if (!entry) {
    return { error: "not_found" as const };
  }

  // Scope check
  const scopeErr = checkScopeAccess(entry as Record<string, unknown>, agent, agentReadableGroupIds);
  if (scopeErr) return scopeErr;

  // Increment usefulness score and update last_accessed_at
  await db
    .update(memoryEntries)
    .set({
      usefulnessScore: drizzleSql`${memoryEntries.usefulnessScore} + 1`,
      lastAccessedAt: drizzleSql`NOW()`,
    })
    .where(eq(memoryEntries.id, id));

  // Fetch versions
  const versions = await db
    .select(MEMORY_VERSION_RETURNING)
    .from(memoryVersions)
    .where(eq(memoryVersions.memoryEntryId, id))
    .orderBy(asc(memoryVersions.version));

  return {
    entry: mapRow(entry as Record<string, unknown>),
    versions: (versions as Record<string, unknown>[]).map(mapVersion),
  };
}

export async function updateMemory(
  txSql: TransactionClient,
  agent: AgentContext,
  id: string,
  input: UpdateMemoryEntryInput,
): Promise<
  | { error: "not_found" }
  | { error: "forbidden" }
  | { error: "conflict"; currentVersion: number }
  | { entry: ReturnType<typeof mapRow>; needsEnrichment: boolean }
> {
  const agentReadableGroupIds = await getAgentGroupIds(txSql, agent.id);

  const db = createMemoryDb(txSql);
  const [entry] = await db
    .select(MEMORY_ENTRY_RETURNING)
    .from(memoryEntries)
    .where(eq(memoryEntries.id, id))
    .limit(1);

  if (!entry) {
    return { error: "not_found" as const };
  }

  // Scope check
  const scopeErr = checkScopeAccess(entry as Record<string, unknown>, agent, agentReadableGroupIds);
  if (scopeErr) return scopeErr;

  const newVersion = (entry.version as number) + 1;
  const { chatProvider } = resolveConfiguredProviders();
  const providedSummary = input.summary?.trim();
  const hasProvidedSummary = Boolean(providedSummary);
  const newContent = input.content ?? (entry.content as string);
  const newTags = input.tags ?? (entry.tags as string[]);
  const contentChanged = input.content !== undefined && input.content !== (entry.content as string);
  const tagsChanged = input.tags !== undefined && !stringArraysEqual(input.tags, entry.tags as string[]);
  const needsEnrichment = contentChanged || tagsChanged;
  const summaryUpdate = hasProvidedSummary
    ? { summary: providedSummary }
    : contentChanged
      ? chatProvider === "none"
        ? { summary: (entry.summary as string | null) ?? null }
        : { summary: null }
      : {};
  const enrichmentReset = contentChanged
    ? {
        autoTags: [],
        embedding: null,
        relatedMemoryIds: [],
        enrichmentStatus: "pending" as const,
      }
    : tagsChanged
      ? {
          autoTags: [],
          enrichmentStatus: "pending" as const,
        }
      : {};
  const [updated] = await db
    .update(memoryEntries)
    .set({
      content: newContent,
      tags: newTags,
      version: newVersion,
      lastAccessedAt: drizzleSql`NOW()`,
      ...summaryUpdate,
      ...(needsEnrichment ? enrichmentReset : {}),
    })
    .where(
      and(
        eq(memoryEntries.id, id),
        eq(memoryEntries.version, input.expectedVersion),
      ),
    )
    .returning(MEMORY_ENTRY_RETURNING);

  if (!updated) {
    const [current] = await db
      .select({ version: memoryEntries.version })
      .from(memoryEntries)
      .where(eq(memoryEntries.id, id))
      .limit(1);
    return {
      error: "conflict" as const,
      currentVersion: current?.version ?? input.expectedVersion,
    };
  }

  await db.insert(memoryVersions).values({
    memoryEntryId: updated.id,
    content: newContent,
    version: newVersion,
    authorAgentId: agent.id,
  });

  // Audit log
  await writeAuditLog(txSql, agent.tenantId, agent.id, "memory.update", id, "success");

  return {
    entry: mapRow(updated as Record<string, unknown>),
    needsEnrichment,
  };
}

export async function deleteMemory(
  txSql: TransactionClient,
  agent: AgentContext,
  id: string,
) {
  const db = createMemoryDb(txSql);
  const [entry] = await db
    .select(MEMORY_ENTRY_RETURNING)
    .from(memoryEntries)
    .where(eq(memoryEntries.id, id))
    .limit(1);

  if (!entry) {
    return { error: "not_found" as const };
  }

  // Only the author can delete
  if ((entry.author_agent_id as string) !== agent.id) {
    return { error: "forbidden" as const };
  }

  await db.delete(memoryEntries).where(eq(memoryEntries.id, id));

  // Audit log
  await writeAuditLog(txSql, agent.tenantId, agent.id, "memory.delete", id, "success");

  return { success: true };
}

export async function markOutdated(
  txSql: TransactionClient,
  agent: AgentContext,
  id: string,
): Promise<{ error: "not_found" } | { error: "forbidden" } | { success: true }> {
  const agentReadableGroupIds = await getAgentGroupIds(txSql, agent.id);

  const db = createMemoryDb(txSql);
  const [entry] = await db
    .select(MEMORY_ENTRY_RETURNING)
    .from(memoryEntries)
    .where(eq(memoryEntries.id, id))
    .limit(1);

  if (!entry) {
    return { error: "not_found" as const };
  }

  // Scope check
  const scopeErr = checkScopeAccess(entry as Record<string, unknown>, agent, agentReadableGroupIds);
  if (scopeErr) return scopeErr;

  await db
    .update(memoryEntries)
    .set({ outdated: true })
    .where(eq(memoryEntries.id, id));

  await writeAuditLog(
    txSql,
    agent.tenantId,
    agent.id,
    "memory.mark_outdated",
    id,
    "success",
  );

  return { success: true };
}

const SCOPE_ORDER: Record<string, number> = { private: 0, user: 1, group: 2 };

export async function promoteScope(
  txSql: TransactionClient,
  agent: AgentContext,
  id: string,
  newScope: string,
): Promise<
  | { error: "not_found" }
  | { error: "forbidden" }
  | { error: "no_change" }
  | { success: true; scope: string }
> {
  const agentReadableGroupIds = await getAgentGroupIds(txSql, agent.id);

  const db = createMemoryDb(txSql);
  const [entry] = await db
    .select(MEMORY_ENTRY_RETURNING)
    .from(memoryEntries)
    .where(eq(memoryEntries.id, id))
    .limit(1);

  if (!entry) {
    return { error: "not_found" as const };
  }

  // Scope check — must have access to current scope
  const scopeErr = checkScopeAccess(entry as Record<string, unknown>, agent, agentReadableGroupIds);
  if (scopeErr) return scopeErr;

  const currentScope = entry.memory_scope as string;
  const currentOrder = SCOPE_ORDER[currentScope] ?? 0;
  const newOrder = SCOPE_ORDER[newScope] ?? 0;

  // Only promotion allowed (private → user → group). Demotion requires authorship.
  if (newOrder < currentOrder) {
    // Demotion: only the author can demote
    if ((entry.author_agent_id as string) !== agent.id) {
      return { error: "forbidden" as const };
    }
  }

  if (newOrder === currentOrder) {
    return { error: "no_change" as const };
  }

  let nextGroupId = (entry.group_id as string | null) ?? null;
  if (newScope === "group") {
    if (nextGroupId) {
      if (!agentReadableGroupIds.includes(nextGroupId)) {
        return { error: "forbidden" as const };
      }
    } else {
      const fallbackGroupId = agentReadableGroupIds[0];
      if (!fallbackGroupId) {
        return { error: "forbidden" as const };
      }
      nextGroupId = fallbackGroupId;
    }
  }

  await db
    .update(memoryEntries)
    .set({
      memoryScope: newScope as "group" | "user" | "private",
      groupId: newScope === "group" ? nextGroupId : (entry.group_id as string | null),
    })
    .where(eq(memoryEntries.id, id));

  // Audit log
  await writeAuditLog(
    txSql,
    agent.tenantId,
    agent.id,
    "memory.scope_change",
    id,
    "success",
  );

  return { success: true, scope: newScope };
}

export async function listTags(
  txSql: TransactionClient,
  agent: AgentContext,
  opts: ScopeFilterOpts = { includeUser: false, includePrivate: false },
): Promise<string[]> {
  const agentReadableGroupIds = await getAgentGroupIds(txSql, agent.id);

  const db = createMemoryDb(txSql);
  const tagExpression = drizzleSql<string>`unnest(${memoryEntries.tags})`;

  const rows = await db
    .selectDistinct({ tag: tagExpression })
    .from(memoryEntries)
    .where(
      and(
        buildScopeFilterCondition(agent, opts, agentReadableGroupIds),
        buildNonExpiredCondition(),
      ),
    )
    .orderBy(tagExpression);

  return rows
    .map((row) => row.tag)
    .filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
}

// ---------- Internal helpers ----------

function checkScopeAccess(
  entry: Record<string, unknown>,
  agent: AgentContext,
  agentReadableGroupIds: string[],
): { error: "forbidden" } | null {
  const scope = entry.memory_scope as string;

  if (scope === "group") {
    const groupId = entry.group_id as string | null;
    if (groupId && agentReadableGroupIds.includes(groupId)) return null;
    return { error: "forbidden" };
  }

  if (scope === "user") {
    const entryGroupId = entry.group_id as string | null;
    if (
      agent.userId &&
      (entry.user_id as string) === agent.userId &&
      entryGroupId &&
      agentReadableGroupIds.includes(entryGroupId)
    ) return null;
    return { error: "forbidden" };
  }

  if (scope === "private") {
    if ((entry.author_agent_id as string) === agent.id) return null;
    return { error: "forbidden" };
  }

  return null;
}

export function buildSummary(summary: string | null, content: string): string {
  if (summary && summary.trim()) {
    return summary.trim().slice(0, 200);
  }

  if (content.length <= 200) {
    return content.trim();
  }

  const candidate = content.slice(0, 200);
  const lastSpace = candidate.lastIndexOf(" ");
  if (lastSpace > 0) {
    return candidate.slice(0, lastSpace).trim();
  }
  return candidate.trim();
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((value) => {
    if (!Number.isFinite(value)) {
      throw new Error("Embedding contains non-finite values");
    }
    return value.toString();
  }).join(",")}]`;
}

function asTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  const leftNormalized = [...new Set(left)].sort();
  const rightNormalized = [...new Set(right)].sort();

  if (leftNormalized.length !== rightNormalized.length) {
    return false;
  }

  for (let index = 0; index < leftNormalized.length; index += 1) {
    if (leftNormalized[index] !== rightNormalized[index]) {
      return false;
    }
  }

  return true;
}
