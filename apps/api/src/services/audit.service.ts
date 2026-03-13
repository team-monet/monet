import { withTenantScope } from "@monet/db";
import type postgres from "postgres";

export interface AuditEntry {
  tenantId: string;
  actorId: string;
  actorType: "agent" | "user" | "system";
  action: string;
  targetId?: string;
  outcome: "success" | "failure";
  reason?: string;
}

let consecutiveAuditFailures = 0;

export function getConsecutiveAuditFailureCount(): number {
  return consecutiveAuditFailures;
}

export async function logAuditEvent(
  sql: postgres.Sql,
  schemaName: string,
  entry: AuditEntry,
): Promise<void> {
  try {
    await withTenantScope(sql, schemaName, async (txSql) => {
      const tx = txSql as unknown as postgres.Sql;
      await tx`
        INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, target_id, outcome, reason)
        VALUES (
          ${entry.tenantId},
          ${entry.actorId},
          ${entry.actorType},
          ${entry.action},
          ${entry.targetId ?? null},
          ${entry.outcome},
          ${entry.reason ?? null}
        )
      `;
    });
    consecutiveAuditFailures = 0;
  } catch (error) {
    consecutiveAuditFailures += 1;
    console.error("Failed to write audit log entry", {
      error,
      action: entry.action,
      targetId: entry.targetId,
      consecutiveFailures: consecutiveAuditFailures,
    });
  }
}
