import postgres from "postgres";
import type { Database } from "@monet/db";
import { createTenantSchema, tenantOauthConfigs } from "@monet/db";
import { slugifyTenantName } from "@monet/types";
import { generateApiKey, hashApiKey } from "./api-key.service.js";
import { encrypt } from "../lib/crypto.js";

export interface ProvisionTenantResult {
  tenant: {
    id: string;
    name: string;
    slug: string;
    isolationMode: string;
    createdAt: Date;
  };
  agent: {
    id: string;
    externalId: string;
  };
  rawApiKey: string;
}

/**
 * Configure OAuth for a tenant.
 */
export async function configureTenantOauth(
  db: Database,
  tenantId: string,
  input: { issuer: string; clientId: string; clientSecret: string },
) {
  const encryptedSecret = encrypt(input.clientSecret);

  const [result] = await db
    .insert(tenantOauthConfigs)
    .values({
      tenantId,
      issuer: input.issuer,
      clientId: input.clientId,
      clientSecretEncrypted: encryptedSecret,
    })
    .onConflictDoUpdate({
      target: tenantOauthConfigs.tenantId,
      set: {
        issuer: input.issuer,
        clientId: input.clientId,
        clientSecretEncrypted: encryptedSecret,
      },
    })
    .returning();

  return result;
}

/**
 * Provision a new tenant: create tenant row, tenant schema, and the first admin agent.
 * All operations are atomic — if any step fails, the entire operation rolls back.
 */
export async function provisionTenant(
  db: Database,
  sql: postgres.Sql,
  input: { name: string; slug?: string; isolationMode?: "logical" | "physical" },
): Promise<ProvisionTenantResult> {
  const tenantSlug = input.slug?.trim() || slugifyTenantName(input.name);
  const adminExternalId = `admin@${tenantSlug}`;
  const rawApiKey = generateApiKey(adminExternalId);
  const { hash, salt } = hashApiKey(rawApiKey);
  const isolationMode = input.isolationMode ?? "logical";

  // Use a transaction for atomicity of tenant + agent creation
  const result = await sql.begin(async (txSql) => {
    // Cast to Sql for tagged template usage (TransactionSql drops call signatures via Omit)
    const tx = txSql as unknown as postgres.Sql;

    // Insert tenant
    const [tenant] = await tx`
      INSERT INTO tenants (name, slug, isolation_mode)
      VALUES (${input.name}, ${tenantSlug}, ${isolationMode})
      RETURNING id, name, slug, isolation_mode, created_at
    `;

    // Create the tenant schema with all DDL
    await createTenantSchema(txSql, tenant.id);

    // Create the first admin agent with tenant_admin role
    const [agent] = await tx`
      INSERT INTO agents (external_id, tenant_id, api_key_hash, api_key_salt, is_autonomous, role)
      VALUES (${adminExternalId}, ${tenant.id}, ${hash}, ${salt}, ${false}, ${"tenant_admin"})
      RETURNING id, external_id
    `;

    return {
      tenant: {
        id: tenant.id as string,
        name: tenant.name as string,
        slug: tenant.slug as string,
        isolationMode: tenant.isolation_mode as string,
        createdAt: tenant.created_at as Date,
      },
      agent: {
        id: agent.id as string,
        externalId: agent.external_id as string,
      },
    };
  });

  return {
    tenant: (result as { tenant: ProvisionTenantResult["tenant"] }).tenant,
    agent: (result as { agent: ProvisionTenantResult["agent"] }).agent,
    rawApiKey,
  };
}
