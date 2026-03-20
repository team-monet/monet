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
  metadata?: Record<string, unknown>;
}

export type AuditResult =
  | { success: true }
  | { success: false; error: string };

export interface AuditHealth {
  status: "healthy" | "degraded";
  consecutiveFailures: number;
  totalFailures: number;
}

let consecutiveAuditFailures = 0;
let totalAuditFailures = 0;

export function getConsecutiveAuditFailureCount(): number {
  return consecutiveAuditFailures;
}

export function resetAuditCounters(): void {
  consecutiveAuditFailures = 0;
  totalAuditFailures = 0;
}

export function getAuditHealth(): AuditHealth {
  return {
    status: consecutiveAuditFailures > 0 ? "degraded" : "healthy",
    consecutiveFailures: consecutiveAuditFailures,
    totalFailures: totalAuditFailures,
  };
}

export async function logAuditEvent(
  sql: postgres.Sql,
  schemaName: string,
  entry: AuditEntry,
): Promise<AuditResult> {
  try {
    await withTenantScope(sql, schemaName, async (txSql) => {
      const tx = txSql as unknown as postgres.Sql;
      await tx`
        INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, target_id, outcome, reason, metadata)
        VALUES (
          ${entry.tenantId},
          ${entry.actorId},
          ${entry.actorType},
          ${entry.action},
          ${entry.targetId ?? null},
          ${entry.outcome},
          ${entry.reason ?? null},
          ${entry.metadata ? JSON.stringify(entry.metadata) : null}
        )
      `;
    });
    consecutiveAuditFailures = 0;
    return { success: true };
  } catch (error) {
    consecutiveAuditFailures += 1;
    totalAuditFailures += 1;
    const message = error instanceof Error ? error.message : "Unknown audit write error";
    console.error("Failed to write audit log entry", {
      error,
      action: entry.action,
      targetId: entry.targetId,
      consecutiveFailures: consecutiveAuditFailures,
      totalFailures: totalAuditFailures,
    });
    return { success: false, error: message };
  }
}
