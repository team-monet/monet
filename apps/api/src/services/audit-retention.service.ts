import { auditLog, withTenantDrizzleScope } from "@monet/db";
import { lt, sql as drizzleSql } from "drizzle-orm";
import type { SqlClient } from "@monet/db";

const AUDIT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const SCHEMA_NAME_REGEX = /^tenant_[a-f0-9_]{36}$/;
const inflightPurges = new Set<Promise<number>>();

function trackPurge(purgePromise: Promise<number>): Promise<number> {
  inflightPurges.add(purgePromise);
  return purgePromise.finally(() => {
    inflightPurges.delete(purgePromise);
  });
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function currentAuditRetentionDays(): number {
  const raw = process.env.AUDIT_RETENTION_DAYS;
  if (!raw) return DEFAULT_AUDIT_RETENTION_DAYS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_AUDIT_RETENTION_DAYS;
  }

  return Math.floor(parsed);
}

export async function purgeExpiredAuditEntries(
  sql: SqlClient,
  schemaName: string,
  retentionDays: number,
): Promise<number> {
  if (!SCHEMA_NAME_REGEX.test(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }

  const safeRetentionDays = Math.max(1, Math.floor(retentionDays));

  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const result = await db
      .delete(auditLog)
      .where(
        lt(
          auditLog.createdAt,
          drizzleSql`NOW() - (${safeRetentionDays} * INTERVAL '1 day')`,
        ),
      );

    return Number(result.count);
  });
}

export async function purgeExpiredAuditEntriesAcrossTenants(
  sql: SqlClient,
  retentionDays = currentAuditRetentionDays(),
): Promise<number> {
  const schemas = await sql`
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant\_%' ESCAPE '\'
    ORDER BY schema_name ASC
  `;

  let totalPurged = 0;
  for (const row of schemas) {
    const schemaName = row.schema_name as string;
    if (!SCHEMA_NAME_REGEX.test(schemaName)) {
      continue;
    }

    try {
      const purged = await purgeExpiredAuditEntries(sql, schemaName, retentionDays);
      if (purged > 0) {
        console.log(
          `[audit-retention] Purged ${purged} entries from schema ${schemaName}`,
        );
      }
      totalPurged += purged;
    } catch (error) {
      console.error(`[audit-retention] Failed to purge ${schemaName}:`, error);
    }
  }

  return totalPurged;
}

function resolveAuditRetentionDays(retentionDays?: number): number {
  return retentionDays ?? currentAuditRetentionDays();
}

export function startAuditRetentionJob(
  sql: SqlClient,
  retentionDays?: number,
): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  if (process.env.AUDIT_PURGE_ENABLED !== "true") {
    console.log(
      "[audit-retention] Purge disabled (set AUDIT_PURGE_ENABLED=true to enable)",
    );
    return;
  }

  // Run once on startup.
  void trackPurge(
    purgeExpiredAuditEntriesAcrossTenants(sql, resolveAuditRetentionDays(retentionDays)),
  )
    .then((count) => {
      if (count > 0) {
        console.log(`[audit-retention] Purged ${count} audit rows on startup`);
      }
    })
    .catch((error) => {
      console.error("[audit-retention] Error on startup purge:", error);
    });

  intervalHandle = setInterval(() => {
    void trackPurge(
      purgeExpiredAuditEntriesAcrossTenants(sql, resolveAuditRetentionDays(retentionDays)),
    )
      .then((count) => {
        if (count > 0) {
          console.log(`[audit-retention] Purged ${count} audit rows`);
        }
      })
      .catch((error) => {
        console.error("[audit-retention] Error during purge:", error);
      });
  }, AUDIT_RETENTION_INTERVAL_MS);
}

export async function stopAuditRetentionJob(): Promise<void> {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  if (inflightPurges.size > 0) {
    await Promise.allSettled([...inflightPurges]);
  }
}
