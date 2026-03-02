import postgres from "postgres";

const EXPIRY_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Delete expired memory entries across all tenant schemas.
 * Runs inside each tenant schema using SET LOCAL search_path.
 */
async function purgeExpiredEntries(sql: postgres.Sql): Promise<number> {
  // Find all tenant schemas
  const schemas = await sql`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
  `;

  let totalDeleted = 0;

  for (const row of schemas) {
    const schemaName = row.schema_name as string;

    // Validate schema name to prevent injection
    if (!/^tenant_[a-f0-9_]{36}$/.test(schemaName)) continue;

    const deleted = await sql.begin(async (txSql) => {
      const tx = txSql as unknown as postgres.Sql;
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      const result = await tx`
        DELETE FROM memory_entries
        WHERE expires_at IS NOT NULL AND expires_at < NOW()
      `;
      return result.count;
    });

    totalDeleted += deleted;
  }

  return totalDeleted;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the TTL expiry background job.
 * Runs immediately on startup, then every 60 minutes.
 */
export function startTtlExpiryJob(sql: postgres.Sql): void {
  // Run immediately on startup
  purgeExpiredEntries(sql).then((count) => {
    if (count > 0) {
      console.log(`[ttl-expiry] Purged ${count} expired entries on startup`);
    }
  }).catch((err) => {
    console.error("[ttl-expiry] Error on startup purge:", err);
  });

  // Schedule recurring job
  intervalHandle = setInterval(() => {
    purgeExpiredEntries(sql).then((count) => {
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
export function stopTtlExpiryJob(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
