import { tenantSettings, withTenantDrizzleScope, DEFAULT_MONET_GUIDANCE } from "@monet/db";
import { eq } from "drizzle-orm";
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
  await withTenantDrizzleScope(sql, tenantSchemaName, async (db) => {
    const rows = await db.select({ id: tenantSettings.id }).from(tenantSettings).limit(1);
    if (rows.length > 0) {
      await db.update(tenantSettings).set({
        monetGuidance: guidance,
        updatedAt: new Date(),
      }).where(eq(tenantSettings.id, rows[0].id));
    } else {
      await db.insert(tenantSettings).values({ monetGuidance: guidance });
    }
  });
}
