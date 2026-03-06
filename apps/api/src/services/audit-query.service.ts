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
    let queryText = 'SELECT * FROM audit_log WHERE 1=1';
    const queryParams: postgres.ParameterOrJSON<never>[] = [];

    if (options.actorId) {
      queryParams.push(options.actorId);
      queryText += ` AND actor_id = $${queryParams.length}`;
    }
    if (options.action) {
      queryParams.push(options.action);
      queryText += ` AND action = $${queryParams.length}`;
    }
    if (options.startDate) {
      queryParams.push(options.startDate);
      queryText += ` AND created_at >= $${queryParams.length}`;
    }
    if (options.endDate) {
      queryParams.push(options.endDate);
      queryText += ` AND created_at <= $${queryParams.length}`;
    }

    // Cursor pagination (created_at, id)
    if (options.cursor) {
      const decoded = decodeAuditCursor(options.cursor);
      queryParams.push(decoded.createdAt);
      const createdAtIdx = queryParams.length;
      queryParams.push(decoded.id);
      const idIdx = queryParams.length;
      queryText += ` AND (created_at, id) < ($${createdAtIdx}::timestamptz, $${idIdx}::uuid)`;
    }

    queryText += ` ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;

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
