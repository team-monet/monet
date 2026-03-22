import { memoryEntries, withTenantDrizzleScope } from "@monet/db";
import { and, isNotNull, lt, sql as drizzleSql } from "drizzle-orm";
import type { SqlClient } from "@monet/db";

const EXPIRY_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const SCHEMA_NAME_REGEX = /^tenant_[a-f0-9_]{36}$/;
const inflightPurges = new Set<Promise<number>>();

function trackPurge(purgePromise: Promise<number>): Promise<number> {
  inflightPurges.add(purgePromise);
  return purgePromise.finally(() => {
    inflightPurges.delete(purgePromise);
  });
}

/**
 * Delete expired memory entries across all tenant schemas.
 * Runs inside each tenant schema using SET LOCAL search_path.
 */
export async function purgeExpiredEntriesInSchema(
  sql: SqlClient,
  schemaName: string,
): Promise<number> {
  if (!SCHEMA_NAME_REGEX.test(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }

  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const result = await db
      .delete(memoryEntries)
      .where(
        and(
          isNotNull(memoryEntries.expiresAt),
          lt(memoryEntries.expiresAt, drizzleSql`NOW()`),
        ),
      );

    return Number(result.count);
  });
}

export async function purgeExpiredEntriesAcrossTenants(sql: SqlClient): Promise<number> {
  const schemas = await sql`
    SELECT schema_name
    FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant\_%' ESCAPE '\'
    ORDER BY schema_name ASC
  `;

  let totalDeleted = 0;

  for (const row of schemas) {
    const schemaName = row.schema_name as string;
    if (!SCHEMA_NAME_REGEX.test(schemaName)) continue;

    try {
      const deleted = await purgeExpiredEntriesInSchema(sql, schemaName);
      totalDeleted += deleted;
    } catch (error) {
      console.error(`[ttl-expiry] Failed to purge ${schemaName}:`, error);
    }
  }

  return totalDeleted;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the TTL expiry background job.
 * Runs immediately on startup, then every 60 minutes.
 */
export function startTtlExpiryJob(sql: SqlClient): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  // Run immediately on startup
  void trackPurge(purgeExpiredEntriesAcrossTenants(sql)).then((count) => {
    if (count > 0) {
      console.log(`[ttl-expiry] Purged ${count} expired entries on startup`);
    }
  }).catch((err) => {
    console.error("[ttl-expiry] Error on startup purge:", err);
  });

  // Schedule recurring job
  intervalHandle = setInterval(() => {
    void trackPurge(purgeExpiredEntriesAcrossTenants(sql)).then((count) => {
      if (count > 0) {
        console.log(`[ttl-expiry] Purged ${count} expired entries`);
      }
    }).catch((err) => {
      console.error("[ttl-expiry] Error during purge:", err);
    });
  }, EXPIRY_INTERVAL_MS);
}

/**
 * Stop the TTL expiry background job.
 */
export async function stopTtlExpiryJob(): Promise<void> {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  if (inflightPurges.size > 0) {
    await Promise.allSettled([...inflightPurges]);
  }
}
