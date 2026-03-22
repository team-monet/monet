import { auditLog, withTenantDrizzleScope } from "@monet/db";
import type { Database, SqlClient } from "@monet/db";

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
  sql: SqlClient,
  schemaName: string,
  entry: AuditEntry,
): Promise<AuditResult> {
  try {
    await withTenantDrizzleScope(sql, schemaName, async (db: Database) => {
      await db.insert(auditLog).values({
        tenantId: entry.tenantId,
        actorId: entry.actorId,
        actorType: entry.actorType,
        action: entry.action,
        targetId: entry.targetId ?? null,
        outcome: entry.outcome,
        reason: entry.reason ?? null,
        metadata: entry.metadata ?? null,
      });
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
