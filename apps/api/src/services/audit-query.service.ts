import postgres from "postgres";
import { tenantSchemaNameFromId, withTenantScope } from "@monet/db";

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

export function decodeAuditCursor(cursor: string): AuditCursorPayload {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as AuditCursorPayload;
}

/**
 * Query audit logs for a specific tenant.
 * Uses withTenantScope to ensure the correct schema is used.
 */
export async function queryAuditLogs(
  sql: postgres.Sql,
  tenantId: string,
  options: AuditQueryOptions = {},
) {
  const schemaName = tenantSchemaNameFromId(tenantId);
  const limit = options.limit || 100;

  return withTenantScope(sql, schemaName, async (tx) => {
    // Start building the query
    let queryText = `
      SELECT
        al.*,
        CASE
          WHEN al.actor_type = 'agent' AND actor_agent.id IS NOT NULL THEN
            CASE
              WHEN actor_agent.is_autonomous THEN actor_agent.external_id || ' (Autonomous)'
              WHEN actor_agent_owner.display_name IS NOT NULL THEN actor_agent.external_id || ' · ' || actor_agent_owner.display_name
              WHEN actor_agent_owner.email IS NOT NULL THEN actor_agent.external_id || ' · ' || actor_agent_owner.email
              WHEN actor_agent_owner.external_id IS NOT NULL THEN actor_agent.external_id || ' · ' || actor_agent_owner.external_id
              ELSE actor_agent.external_id
            END
          WHEN al.actor_type = 'user' THEN COALESCE(actor_user.display_name, actor_user.email, actor_user.external_id)
          WHEN al.actor_type = 'system' THEN 'System'
          ELSE NULL
        END AS actor_display_name
      FROM audit_log al
      LEFT JOIN public.agents actor_agent
        ON al.actor_type = 'agent' AND actor_agent.id = al.actor_id
      LEFT JOIN public.users actor_agent_owner
        ON actor_agent_owner.id = actor_agent.user_id
      LEFT JOIN public.users actor_user
        ON al.actor_type = 'user' AND actor_user.id = al.actor_id
      WHERE 1=1
    `;
    const queryParams: postgres.ParameterOrJSON<never>[] = [];

    if (options.actorId) {
      queryParams.push(options.actorId);
      queryText += ` AND al.actor_id = $${queryParams.length}`;
    }
    if (options.action) {
      queryParams.push(options.action);
      queryText += ` AND al.action = $${queryParams.length}`;
    }
    if (options.startDate) {
      queryParams.push(options.startDate);
      queryText += ` AND al.created_at >= $${queryParams.length}`;
    }
    if (options.endDate) {
      queryParams.push(options.endDate);
      queryText += ` AND al.created_at <= $${queryParams.length}`;
    }

    // Cursor pagination (created_at, id)
    if (options.cursor) {
      const decoded = decodeAuditCursor(options.cursor);
      queryParams.push(decoded.createdAt);
      const createdAtIdx = queryParams.length;
      queryParams.push(decoded.id);
      const idIdx = queryParams.length;
      queryText += ` AND (al.created_at, al.id) < ($${createdAtIdx}::timestamptz, $${idIdx}::uuid)`;
    }

    queryText += ` ORDER BY al.created_at DESC, al.id DESC LIMIT ${limit + 1}`;

    const rows = await tx.unsafe(queryText, queryParams);

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
