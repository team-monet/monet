import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  and,
  desc,
  eq,
  sql as drizzleSql,
  type SQL,
} from "drizzle-orm";
import type { SqlClient } from "@monet/db";
import {
  agents,
  auditLog,
  tenantSchemaNameFromId,
  tenantUsers,
  withTenantDrizzleScope,
} from "@monet/db";

export interface AuditQueryOptions {
  actorId?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
  cursor?: string;
  limit?: number;
}

interface AuditCursorPayload {
  createdAt: string;
  id: string;
}

export function encodeAuditCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
}

const AuditCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

export function decodeAuditCursor(cursor: string): AuditCursorPayload | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
    return AuditCursorSchema.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Query audit logs for a specific tenant.
 * Uses withTenantScope to ensure the correct schema is used.
 */
export async function queryAuditLogs(
  sql: SqlClient,
  tenantId: string,
  options: AuditQueryOptions = {},
) {
  const schemaName = tenantSchemaNameFromId(tenantId);
  const limit = options.limit ?? 100;
  const actorAgent = alias(agents, "actor_agent");
  const actorAgentOwner = alias(tenantUsers, "actor_agent_owner");
  const actorUser = alias(tenantUsers, "actor_user");

  const conditions: SQL[] = [];

  if (options.actorId) {
    conditions.push(eq(auditLog.actorId, options.actorId));
  }
  if (options.action) {
    conditions.push(eq(auditLog.action, options.action));
  }
  if (options.startDate) {
    conditions.push(
      drizzleSql`${auditLog.createdAt} >= ${options.startDate}::timestamptz`,
    );
  }
  if (options.endDate) {
    conditions.push(
      drizzleSql`${auditLog.createdAt} <= ${options.endDate}::timestamptz`,
    );
  }

  if (options.cursor) {
    const decoded = decodeAuditCursor(options.cursor);
    if (decoded) {
      conditions.push(
        drizzleSql`(${auditLog.createdAt}, ${auditLog.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)`,
      );
    }
  }

  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    // NOTE: search_path is tenant schema first, then public; platform tables resolve from public today.
    const rows = await db
      .select({
        id: auditLog.id,
        tenant_id: auditLog.tenantId,
        actor_id: auditLog.actorId,
        actor_type: auditLog.actorType,
        action: auditLog.action,
        target_id: auditLog.targetId,
        outcome: auditLog.outcome,
        reason: auditLog.reason,
        metadata: auditLog.metadata,
        created_at: auditLog.createdAt,
        actor_display_name: drizzleSql<string | null>`
          CASE
            WHEN ${auditLog.actorType} = 'agent' AND ${actorAgent.id} IS NOT NULL THEN
              CASE
                WHEN ${actorAgent.isAutonomous} THEN ${actorAgent.externalId} || ' (Autonomous)'
                WHEN ${actorAgentOwner.displayName} IS NOT NULL THEN ${actorAgent.externalId} || ' · ' || ${actorAgentOwner.displayName}
                WHEN ${actorAgentOwner.email} IS NOT NULL THEN ${actorAgent.externalId} || ' · ' || ${actorAgentOwner.email}
                WHEN ${actorAgentOwner.externalId} IS NOT NULL THEN ${actorAgent.externalId} || ' · ' || ${actorAgentOwner.externalId}
                ELSE ${actorAgent.externalId}
              END
            WHEN ${auditLog.actorType} = 'user' THEN COALESCE(${actorUser.displayName}, ${actorUser.email}, ${actorUser.externalId})
            WHEN ${auditLog.actorType} = 'system' THEN 'System'
            ELSE NULL
          END
        `,
      })
      .from(auditLog)
      .leftJoin(
        actorAgent,
        and(
          eq(auditLog.actorType, "agent"),
          eq(actorAgent.id, auditLog.actorId),
        ),
      )
      .leftJoin(actorAgentOwner, eq(actorAgentOwner.id, actorAgent.userId))
      .leftJoin(
        actorUser,
        and(
          eq(auditLog.actorType, "user"),
          eq(actorUser.id, auditLog.actorId),
        ),
      )
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = encodeAuditCursor(
        last.created_at.toISOString ? last.created_at.toISOString() : String(last.created_at),
        last.id as string
      );
    }

    return { items, nextCursor };
  });
}
