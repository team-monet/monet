import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import { tenantSchemaNameFromId, tenants, type Database } from "@monet/db";
import type { AppEnv } from "./context";

const SCHEMA_NAME_REGEX = /^tenant_[a-f0-9_]{36}$/;

export function tenantSchemaName(tenantId: string): string {
  return tenantSchemaNameFromId(tenantId);
}

export async function resolveTenantBySlug(
  db: Database,
  tenantSlug: string,
): Promise<{ tenantId: string; tenantSchemaName: string } | null> {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const tenantId = rows[0].id;
  return {
    tenantId,
    tenantSchemaName: tenantSchemaName(tenantId),
  };
}

export const tenantMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const db = c.get("db");
  const tenantSlug = c.req.param("tenantSlug");
  if (!tenantSlug) {
    return c.json({ error: "not_found", message: "Tenant not found" }, 404);
  }

  const tenant = await resolveTenantBySlug(db, tenantSlug);
  if (!tenant) {
    return c.json({ error: "not_found", message: "Tenant not found" }, 404);
  }

  if (!SCHEMA_NAME_REGEX.test(tenant.tenantSchemaName)) {
    return c.json({ error: "internal", message: "Invalid tenant schema derivation" }, 500);
  }

  c.set("tenantId", tenant.tenantId);
  c.set("tenantSchemaName", tenant.tenantSchemaName);

  await next();
});
