import type postgres from "postgres";
import type { AgentContext } from "../middleware/context";
import type {
  CreateMemoryEntryInput,
  MemoryEntryTier1,
  UpdateMemoryEntryInput,
} from "@monet/types";

// ---------- Cursor helpers ----------

interface SearchCursorPayload {
  createdAt: string;
  id: string;
  rank?: number;
}

export function encodeCursor(createdAt: string, id: string, rank?: number): string {
  return Buffer.from(JSON.stringify({ createdAt, id, rank })).toString("base64url");
}

export function decodeCursor(cursor: string): SearchCursorPayload {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as SearchCursorPayload;
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
    expiresAt: (row.expires_at as string) ?? null,
    createdAt: row.created_at as string,
    lastAccessedAt: row.last_accessed_at as string,
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
    createdAt: row.created_at as string,
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

const MEMORY_AUTHOR_DISPLAY_SELECT = `
  CASE
    WHEN author_agent.id IS NULL THEN NULL
    WHEN author_agent.is_autonomous THEN author_agent.external_id || ' (Autonomous)'
    WHEN author_owner.email IS NOT NULL THEN author_agent.external_id || ' · ' || author_owner.email
    WHEN author_owner.external_id IS NOT NULL THEN author_agent.external_id || ' · ' || author_owner.external_id
    ELSE author_agent.external_id
  END AS author_agent_display_name
`;

function buildMemoryEntrySelect(rankExpression?: string) {
  const rankSelect = rankExpression
    ? `${rankExpression} AS search_rank,\n    `
    : "";

  return `
    SELECT
      me.*,
      ${rankSelect}${MEMORY_AUTHOR_DISPLAY_SELECT}
    FROM memory_entries me
    LEFT JOIN public.agents author_agent ON author_agent.id = me.author_agent_id
    LEFT JOIN public.users author_owner ON author_owner.id = author_agent.user_id
  `;
}

// ---------- Audit log ----------

export async function writeAuditLog(
  tx: postgres.Sql,
  tenantId: string,
  agentId: string,
  action: string,
  targetId: string | null,
  outcome: string,
) {
  await tx`
    INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, target_id, outcome)
    VALUES (${tenantId}, ${agentId}, ${"agent"}, ${action}, ${targetId}, ${outcome})
  `;
}

// ---------- Scope filter ----------

export interface ScopeFilterOpts {
  includeUser: boolean;
  includePrivate: boolean;
}

export interface MemoryWritePreflight {
  hasGroupMembership: boolean;
  memoryQuota: number | null;
}

/**
 * Build scope visibility filter fragments.
 * Returns an array of SQL conditions that should be OR'd together.
 *
 * - group: always visible
 * - user: visible when includeUser=true AND agent shares same userId
 * - private: visible when includePrivate=true AND agent is the author
 */
export function buildScopeFilter(
  agent: AgentContext,
  opts: ScopeFilterOpts,
): string[] {
  const conditions: string[] = ["me.memory_scope = 'group'"];

  if (opts.includeUser && agent.userId) {
    conditions.push(`(me.memory_scope = 'user' AND me.user_id = ${escapeLiteral(agent.userId)})`);
  }

  if (opts.includePrivate) {
    conditions.push(
      `(me.memory_scope = 'private' AND me.author_agent_id = ${escapeLiteral(agent.id)})`,
    );
  }

  return conditions;
}

// ---------- Quota ----------

const DEFAULT_MEMORY_QUOTA = 10000;

export async function resolveMemoryWritePreflight(
  platformSql: postgres.Sql | null,
  agent: AgentContext,
): Promise<MemoryWritePreflight | null> {
  if (!platformSql) {
    return null;
  }

  const rows = await platformSql`
    SELECT ag.memory_quota
    FROM agent_group_members agm
    JOIN agent_groups ag ON ag.id = agm.group_id
    WHERE agm.agent_id = ${agent.id}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return {
      hasGroupMembership: false,
      memoryQuota: null,
    };
  }

  return {
    hasGroupMembership: true,
    memoryQuota: (rows[0].memory_quota as number | null) ?? null,
  };
}

/**
 * Check memory quota before insert. Returns error if exceeded.
 * Quota is resolved from the agent's group (memory_quota column) or falls back to a default.
 */
export async function checkQuota(
  tx: postgres.Sql,
  agent: AgentContext,
  quotaOverride: number | null = null,
): Promise<{ error: "quota_exceeded"; limit: number; current: number } | null> {
  const quota = quotaOverride && quotaOverride > 0 ? quotaOverride : DEFAULT_MEMORY_QUOTA;

  // Count current entries by this agent in the tenant schema
  const [result] = await tx`
    SELECT COUNT(*)::int AS count FROM memory_entries WHERE author_agent_id = ${agent.id}
  `;
  const current = (result.count as number) ?? 0;

  if (current >= quota) {
    return { error: "quota_exceeded", limit: quota, current };
  }

  return null;
}

// ---------- Core CRUD ----------

export async function createMemory(
  txSql: postgres.TransactionSql,
  agent: AgentContext,
  input: CreateMemoryEntryInput,
  preflight: MemoryWritePreflight | null = null,
) {
  const tx = txSql as unknown as postgres.Sql;

  // Autonomous agents cannot store user-scoped entries (they have no user binding)
  if (agent.isAutonomous && input.memoryScope === "user") {
    return { error: "validation" as const, message: "Autonomous agents cannot store user-scoped memories" };
  }

  // Group-scoped entries require group membership (M2 spec)
  if (input.memoryScope === "group" && preflight && !preflight.hasGroupMembership) {
      return { error: "validation" as const, message: "Agent must belong to a group to store group-scoped memories" };
  }

  // Quota enforcement
  const quotaErr = await checkQuota(tx, agent, preflight?.memoryQuota ?? null);
  if (quotaErr) return quotaErr;

  const expiresAt = input.ttlSeconds
    ? new Date(Date.now() + input.ttlSeconds * 1000).toISOString()
    : null;

  const [entry] = await tx`
    INSERT INTO memory_entries (content, memory_type, memory_scope, tags, ttl_seconds, expires_at, author_agent_id, user_id, version)
    VALUES (
      ${input.content},
      ${input.memoryType},
      ${input.memoryScope},
      ${input.tags},
      ${input.ttlSeconds ?? null},
      ${expiresAt},
      ${agent.id},
      ${agent.userId},
      ${0}
    )
    RETURNING *
  `;

  // Insert initial version snapshot (v0)
  await tx`
    INSERT INTO memory_versions (memory_entry_id, content, version, author_agent_id)
    VALUES (${entry.id}, ${input.content}, ${0}, ${agent.id})
  `;

  // Audit log
  await writeAuditLog(tx, agent.tenantId, agent.id, "memory.create", entry.id as string, "success");

  return mapRow(entry as Record<string, unknown>);
}

export async function searchMemories(
  txSql: postgres.TransactionSql,
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
  },
  queryEmbedding: number[] | null = null,
) {
  const tx = txSql as unknown as postgres.Sql;
  const limit = query.limit ?? 20;

  // Build WHERE clauses
  const conditions: string[] = [];

  // Scope filter
  const scopeConditions = buildScopeFilter(agent, {
    includeUser: query.includeUser ?? false,
    includePrivate: query.includePrivate ?? false,
  });
  conditions.push(`(${scopeConditions.join(" OR ")})`);

  // Exclude expired
  conditions.push(
    `(me.expires_at IS NULL OR me.expires_at > NOW())`,
  );

  // Text search
  if (query.query && !queryEmbedding) {
    conditions.push(`me.content ILIKE '%' || ${escapeLiteral(query.query)} || '%'`);
  }

  // Tag overlap
  if (query.tags && query.tags.length > 0) {
    conditions.push(`me.tags && ARRAY[${query.tags.map(escapeLiteral).join(",")}]::text[]`);
  }

  // Memory type
  if (query.memoryType) {
    conditions.push(`me.memory_type = ${escapeLiteral(query.memoryType)}`);
  }

  // Date range
  if (query.createdAfter) {
    conditions.push(`me.created_at >= ${escapeLiteral(query.createdAfter)}::timestamptz`);
  }
  if (query.createdBefore) {
    conditions.push(`me.created_at <= ${escapeLiteral(query.createdBefore)}::timestamptz`);
  }
  if (query.accessedAfter) {
    conditions.push(`me.last_accessed_at >= ${escapeLiteral(query.accessedAfter)}::timestamptz`);
  }
  if (query.accessedBefore) {
    conditions.push(`me.last_accessed_at <= ${escapeLiteral(query.accessedBefore)}::timestamptz`);
  }

  // Cursor pagination (created_at, id)
  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    if (decoded.rank !== undefined) {
      const cursorRank = escapeNumberLiteral(decoded.rank);
      conditions.push(
        `(((CASE WHEN me.embedding IS NULL THEN NULL ELSE ${buildRankExpression(queryEmbedding)} END) < ${cursorRank}) OR ((CASE WHEN me.embedding IS NULL THEN NULL ELSE ${buildRankExpression(queryEmbedding)} END) = ${cursorRank} AND (me.created_at, me.id) < (${escapeLiteral(decoded.createdAt)}::timestamptz, ${escapeLiteral(decoded.id)}::uuid)))`,
      );
    } else {
      conditions.push(
        `(me.created_at, me.id) < (${escapeLiteral(decoded.createdAt)}::timestamptz, ${escapeLiteral(decoded.id)}::uuid)`,
      );
    }
  }

  const where = conditions.join(" AND ");
  const rankExpression = buildRankExpression(queryEmbedding);
  const orderBy = `ORDER BY search_rank DESC NULLS LAST, me.created_at DESC, me.id DESC`;
  const sql = `
    ${buildMemoryEntrySelect(rankExpression)}
    WHERE ${where}
    ${orderBy}
    LIMIT ${limit + 1}
  `;

  const rows = await tx.unsafe(sql);

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
  txSql: postgres.TransactionSql,
  agent: AgentContext,
  targetAgentId: string,
  query: {
    cursor?: string;
    limit?: number;
  },
) {
  const tx = txSql as unknown as postgres.Sql;
  const limit = query.limit ?? 20;
  const conditions = [
    `me.author_agent_id = ${escapeLiteral(targetAgentId)}`,
    `me.memory_scope = 'group'`,
    `(me.expires_at IS NULL OR me.expires_at > NOW())`,
  ];

  if (query.cursor) {
    const decoded = decodeCursor(query.cursor);
    conditions.push(
      `(me.created_at, me.id) < (${escapeLiteral(decoded.createdAt)}::timestamptz, ${escapeLiteral(decoded.id)}::uuid)`,
    );
  }

  // Group memories are visible to all group members. The current codebase treats
  // group scope as globally visible within the tenant schema, so match that here.
  const rows = await tx.unsafe(
    `
      ${buildMemoryEntrySelect()}
      WHERE ${conditions.join(" AND ")}
      ORDER BY me.created_at DESC, me.id DESC
      LIMIT ${limit + 1}
    `,
  );

  const hasMore = rows.length > limit;
  const items = (rows.slice(0, limit) as Record<string, unknown>[]).map(mapTier1Row);

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1];
    nextCursor = encodeCursor(last.createdAt.toISOString(), last.id);
  }

  void agent;

  return { items, nextCursor };
}

export async function fetchMemory(
  txSql: postgres.TransactionSql,
  agent: AgentContext,
  id: string,
) {
  const tx = txSql as unknown as postgres.Sql;

  const [entry] = await tx.unsafe(
    `
      ${buildMemoryEntrySelect()}
      WHERE me.id = $1::uuid
      LIMIT 1
    `,
    [id],
  );

  if (!entry) {
    return { error: "not_found" as const };
  }

  // Scope check
  const scopeErr = checkScopeAccess(entry as Record<string, unknown>, agent);
  if (scopeErr) return scopeErr;

  // Increment usefulness score and update last_accessed_at
  await tx`
    UPDATE memory_entries
    SET usefulness_score = usefulness_score + 1, last_accessed_at = NOW()
    WHERE id = ${id}
  `;

  // Fetch versions
  const versions = await tx`
    SELECT * FROM memory_versions
    WHERE memory_entry_id = ${id}
    ORDER BY version ASC
  `;

  return {
    entry: mapRow(entry as Record<string, unknown>),
    versions: (versions as Record<string, unknown>[]).map(mapVersion),
  };
}

export async function updateMemory(
  txSql: postgres.TransactionSql,
  agent: AgentContext,
  id: string,
  input: UpdateMemoryEntryInput,
) {
  const tx = txSql as unknown as postgres.Sql;

  const [entry] = await tx`
    SELECT * FROM memory_entries WHERE id = ${id}
  `;

  if (!entry) {
    return { error: "not_found" as const };
  }

  // Scope check
  const scopeErr = checkScopeAccess(entry as Record<string, unknown>, agent);
  if (scopeErr) return scopeErr;

  const newVersion = (entry.version as number) + 1;
  const newContent = input.content ?? (entry.content as string);
  const newTags = input.tags ?? (entry.tags as string[]);
  const [updated] = await tx`
    WITH updated AS (
      UPDATE memory_entries
      SET
        content = ${newContent},
        tags = ${newTags},
        version = ${newVersion},
        last_accessed_at = NOW()
      WHERE id = ${id} AND version = ${input.expectedVersion}
      RETURNING *
    ),
    inserted_version AS (
      INSERT INTO memory_versions (memory_entry_id, content, version, author_agent_id)
      SELECT id, content, version, ${agent.id}
      FROM updated
      RETURNING id
    )
    SELECT * FROM updated
  `;

  if (!updated) {
    const [current] = await tx`
      SELECT version FROM memory_entries WHERE id = ${id}
    `;
    return {
      error: "conflict" as const,
      currentVersion: (current?.version as number) ?? input.expectedVersion,
    };
  }

  // Audit log
  await writeAuditLog(tx, agent.tenantId, agent.id, "memory.update", id, "success");

  return { entry: mapRow(updated as Record<string, unknown>) };
}

export async function deleteMemory(
  txSql: postgres.TransactionSql,
  agent: AgentContext,
  id: string,
) {
  const tx = txSql as unknown as postgres.Sql;

  const [entry] = await tx`
    SELECT * FROM memory_entries WHERE id = ${id}
  `;

  if (!entry) {
    return { error: "not_found" as const };
  }

  // Only the author can delete
  if ((entry.author_agent_id as string) !== agent.id) {
    return { error: "forbidden" as const };
  }

  await tx`DELETE FROM memory_entries WHERE id = ${id}`;

  // Audit log
  await writeAuditLog(tx, agent.tenantId, agent.id, "memory.delete", id, "success");

  return { success: true };
}

export async function markOutdated(
  txSql: postgres.TransactionSql,
  agent: AgentContext,
  id: string,
) {
  const tx = txSql as unknown as postgres.Sql;

  const [entry] = await tx`
    SELECT * FROM memory_entries WHERE id = ${id}
  `;

  if (!entry) {
    return { error: "not_found" as const };
  }

  // Scope check
  const scopeErr = checkScopeAccess(entry as Record<string, unknown>, agent);
  if (scopeErr) return scopeErr;

  await tx`
    UPDATE memory_entries SET outdated = true WHERE id = ${id}
  `;

  await writeAuditLog(tx, agent.tenantId, agent.id, "memory.mark_outdated", id, "success");

  return { success: true };
}

const SCOPE_ORDER: Record<string, number> = { private: 0, user: 1, group: 2 };

export async function promoteScope(
  txSql: postgres.TransactionSql,
  agent: AgentContext,
  id: string,
  newScope: string,
) {
  const tx = txSql as unknown as postgres.Sql;

  const [entry] = await tx`
    SELECT * FROM memory_entries WHERE id = ${id}
  `;

  if (!entry) {
    return { error: "not_found" as const };
  }

  // Scope check — must have access to current scope
  const scopeErr = checkScopeAccess(entry as Record<string, unknown>, agent);
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

  await tx`
    UPDATE memory_entries SET memory_scope = ${newScope} WHERE id = ${id}
  `;

  // Audit log
  await writeAuditLog(tx, agent.tenantId, agent.id, "memory.scope_change", id, "success");

  return { success: true, scope: newScope };
}

export async function listTags(
  txSql: postgres.TransactionSql,
  agent: AgentContext,
  opts: ScopeFilterOpts = { includeUser: false, includePrivate: false },
) {
  const tx = txSql as unknown as postgres.Sql;

  const scopeConditions = buildScopeFilter(agent, opts);
  const where = scopeConditions.join(" OR ");

  const rows = await tx.unsafe(
    `SELECT DISTINCT unnest(me.tags) AS tag FROM memory_entries me WHERE (${where}) AND (me.expires_at IS NULL OR me.expires_at > NOW()) ORDER BY tag`,
  );

  return (rows as Record<string, unknown>[]).map((r) => r.tag as string);
}

// ---------- Internal helpers ----------

function checkScopeAccess(
  entry: Record<string, unknown>,
  agent: AgentContext,
): { error: "forbidden" } | null {
  const scope = entry.memory_scope as string;

  if (scope === "group") return null;

  if (scope === "user") {
    if (agent.userId && (entry.user_id as string) === agent.userId) return null;
    return { error: "forbidden" };
  }

  if (scope === "private") {
    if ((entry.author_agent_id as string) === agent.id) return null;
    return { error: "forbidden" };
  }

  return null;
}

function escapeLiteral(value: string): string {
  // Escape single quotes by doubling them, wrap in single quotes
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeNumberLiteral(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("Cursor rank must be finite");
  }
  return value.toString();
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

function buildRankExpression(queryEmbedding: number[] | null): string {
  const usefulnessWeight = "GREATEST(me.usefulness_score, 1)";
  const outdatedWeight = "CASE WHEN me.outdated THEN 0.5 ELSE 1.0 END";
  if (!queryEmbedding) {
    return `(${usefulnessWeight} * ${outdatedWeight})`;
  }

  return `((1 - (me.embedding <=> ${escapeLiteral(toVectorLiteral(queryEmbedding))}::vector)) * ${usefulnessWeight} * ${outdatedWeight})`;
}
