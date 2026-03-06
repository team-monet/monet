import { withTenantScope } from "@monet/db";
import type postgres from "postgres";

const AUDIT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const SCHEMA_NAME_REGEX = /^tenant_[a-f0-9_]{36}$/;

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
  sql: postgres.Sql,
  schemaName: string,
  retentionDays: number,
): Promise<number> {
  if (!SCHEMA_NAME_REGEX.test(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }

  const safeRetentionDays = Math.max(1, Math.floor(retentionDays));

  return withTenantScope(sql, schemaName, async (txSql) => {
    const tx = txSql as unknown as postgres.Sql;
    const result = await tx`
      DELETE FROM audit_log
      WHERE created_at < NOW() - (${safeRetentionDays} * INTERVAL '1 day')
    `;
    return result.count;
  });
}

export async function purgeExpiredAuditEntriesAcrossTenants(
  sql: postgres.Sql,
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

    const purged = await purgeExpiredAuditEntries(sql, schemaName, retentionDays);
    totalPurged += purged;
  }

  return totalPurged;
}

export function startAuditRetentionJob(
  sql: postgres.Sql,
  retentionDays = currentAuditRetentionDays(),
): void {
  // Run once on startup.
  void purgeExpiredAuditEntriesAcrossTenants(sql, retentionDays)
    .then((count) => {
      if (count > 0) {
        console.log(`[audit-retention] Purged ${count} audit rows on startup`);
      }
    })
    .catch((error) => {
      console.error("[audit-retention] Error on startup purge:", error);
    });

  intervalHandle = setInterval(() => {
    void purgeExpiredAuditEntriesAcrossTenants(sql, retentionDays)
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

export function stopAuditRetentionJob(): void {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
}
