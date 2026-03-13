import postgres from "postgres";
import type { Database } from "@monet/db";
import { createTenantSchema, tenantOauthConfigs } from "@monet/db";
import {
  DEFAULT_AGENT_GROUP_DESCRIPTION,
  DEFAULT_AGENT_GROUP_NAME,
  DEFAULT_USER_GROUP_DESCRIPTION,
  DEFAULT_USER_GROUP_NAME,
  slugifyTenantName,
} from "@monet/types";
import { encrypt } from "../lib/crypto";
import { provisionAgentWithApiKey } from "./agent-provisioning.service";

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

    const [defaultUserGroup] = await tx`
      INSERT INTO human_groups (tenant_id, name, description)
      VALUES (
        ${tenant.id},
        ${DEFAULT_USER_GROUP_NAME},
        ${DEFAULT_USER_GROUP_DESCRIPTION}
      )
      RETURNING id
    `;

    const [defaultAgentGroup] = await tx`
      INSERT INTO agent_groups (tenant_id, name, description)
      VALUES (
        ${tenant.id},
        ${DEFAULT_AGENT_GROUP_NAME},
        ${DEFAULT_AGENT_GROUP_DESCRIPTION}
      )
      RETURNING id
    `;

    // Create the first admin agent with tenant_admin role
    const adminAgent = await provisionAgentWithApiKey(tx, {
      externalId: adminExternalId,
      tenantId: tenant.id as string,
      isAutonomous: false,
      role: "tenant_admin",
    });

    await tx`
      INSERT INTO agent_group_members (agent_id, group_id)
      VALUES (${adminAgent.agent.id}, ${defaultAgentGroup.id})
    `;

    await tx`
      INSERT INTO human_group_agent_group_permissions (human_group_id, agent_group_id)
      VALUES (${defaultUserGroup.id}, ${defaultAgentGroup.id})
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
        id: adminAgent.agent.id,
        externalId: adminAgent.agent.externalId,
      },
      rawApiKey: adminAgent.rawApiKey,
    };
  });

  return {
    tenant: (result as { tenant: ProvisionTenantResult["tenant"] }).tenant,
    agent: (result as { agent: ProvisionTenantResult["agent"] }).agent,
    rawApiKey: (result as { rawApiKey: string }).rawApiKey,
  };
}
