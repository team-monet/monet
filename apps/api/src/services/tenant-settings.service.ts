import {
  tenantSettings,
  type SqlClient,
  withTenantDrizzleScope,
} from "@monet/db";
import { eq, sql as drizzleSql } from "drizzle-orm";

const MAX_TENANT_INSTRUCTIONS_CHARS = 4000;

export async function getTenantSettings(sql: SqlClient, schemaName: string): Promise<{ tenantAgentInstructions: string | null }> {
  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [settings] = await db
      .select({
        tenantAgentInstructions: tenantSettings.tenantAgentInstructions,
      })
      .from(tenantSettings)
      .limit(1);

    return {
      tenantAgentInstructions: settings?.tenantAgentInstructions ?? null,
    };
  });
}

export async function updateTenantSettings(
  sql: SqlClient,
  schemaName: string,
  instructions: string,
): Promise<{ tenantAgentInstructions: string | null }> {
  const normalized = instructions.trim();
  const boundedInstructions = normalized.length > MAX_TENANT_INSTRUCTIONS_CHARS
    ? normalized.slice(0, MAX_TENANT_INSTRUCTIONS_CHARS)
    : normalized;

  if (boundedInstructions.length !== normalized.length) {
    console.warn(
      `[tenant-settings] tenantAgentInstructions truncated from ${normalized.length} to ${boundedInstructions.length} characters`,
    );
  }

  return withTenantDrizzleScope(sql, schemaName, async (db) => {
    const [existing] = await db
      .select({ id: tenantSettings.id })
      .from(tenantSettings)
      .limit(1);

    if (existing) {
      const [updated] = await db
        .update(tenantSettings)
        .set({
          tenantAgentInstructions: boundedInstructions,
          updatedAt: drizzleSql`NOW()`,
        })
        .where(eq(tenantSettings.id, existing.id))
        .returning({ tenantAgentInstructions: tenantSettings.tenantAgentInstructions });

      return {
        tenantAgentInstructions: updated?.tenantAgentInstructions ?? null,
      };
    }

    const [created] = await db
      .insert(tenantSettings)
      .values({ tenantAgentInstructions: boundedInstructions })
      .returning({ tenantAgentInstructions: tenantSettings.tenantAgentInstructions });

    return {
      tenantAgentInstructions: created?.tenantAgentInstructions ?? null,
    };
  });
}
