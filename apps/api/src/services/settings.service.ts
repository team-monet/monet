import { tenantSettings, withTenantDrizzleScope, DEFAULT_MONET_GUIDANCE, withTenantScope } from "@monet/db";
import type { SqlClient } from "@monet/db";

export async function getMonetGuidance(
  sql: SqlClient,
  tenantSchemaName: string,
): Promise<string> {
  const rows = await withTenantDrizzleScope(sql, tenantSchemaName, async (db) => {
    return db.select({ monetGuidance: tenantSettings.monetGuidance }).from(tenantSettings).limit(1);
  });
  return rows[0]?.monetGuidance ?? DEFAULT_MONET_GUIDANCE;
}

export async function updateMonetGuidance(
  sql: SqlClient,
  tenantSchemaName: string,
  guidance: string,
): Promise<void> {
  await withTenantScope(sql, tenantSchemaName, async (txSql) => {
    // Atomic upsert: update existing row, or insert if none exists.
    const updated = await txSql.unsafe(`
      UPDATE tenant_settings SET monet_guidance = $1, updated_at = now()
      RETURNING id
    `, [guidance]);
    if (updated.length === 0) {
      await txSql.unsafe(`
        INSERT INTO tenant_settings (monet_guidance) VALUES ($1)
      `, [guidance]);
    }
  });
}
