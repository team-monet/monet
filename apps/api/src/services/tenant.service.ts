import {
  agentGroupMembers,
  agentGroups,
  asDrizzleSqlClient,
  createTenantSchema,
  type Database,
  type SqlClient,
  tenants,
  tenantOauthConfigs,
  type TransactionClient,
  userGroupAgentGroupPermissions,
  userGroups,
} from "@monet/db";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  DEFAULT_AGENT_GROUP_DESCRIPTION,
  DEFAULT_AGENT_GROUP_NAME,
  DEFAULT_USER_GROUP_DESCRIPTION,
  DEFAULT_USER_GROUP_NAME,
  slugifyTenantName,
} from "@monet/types";
import { encrypt } from "../lib/crypto";
import { seedDefaultGeneralGuidance } from "./default-rule-seed.service";
import { provisionAgentWithApiKey } from "./agent-provisioning.service";

type TenantSqlClient = SqlClient | TransactionClient;
type TenantDrizzleOptions = NonNullable<SqlClient["options"]>;

function createTenantDb(
  sql: TenantSqlClient,
  options?: TenantDrizzleOptions,
) {
  return drizzle(asDrizzleSqlClient(sql, options));
}

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

export async function ensureTenantSchemasCurrent(sql: SqlClient): Promise<number> {
  const db = createTenantDb(sql);
  const tenantRows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .orderBy(asc(tenants.createdAt), asc(tenants.id));

  for (const tenant of tenantRows) {
    await createTenantSchema(sql, tenant.id);
  }

  return tenantRows.length;
}

/**
 * Provision a new tenant: create tenant row, tenant schema, and the first admin agent.
 * All operations are atomic — if any step fails, the entire operation rolls back.
 */
export async function provisionTenant(
  _db: Database,
  sql: SqlClient,
  input: { name: string; slug?: string; isolationMode?: "logical" | "physical" },
): Promise<ProvisionTenantResult> {
  const tenantSlug = input.slug?.trim() || slugifyTenantName(input.name);
  const adminExternalId = `admin@${tenantSlug}`;
  const isolationMode = input.isolationMode ?? "logical";

  // Use a transaction for atomicity of tenant + agent creation
  const result = await sql.begin(async (txSql) => {
    const txDb = createTenantDb(txSql, sql.options);

    const [tenant] = await txDb
      .insert(tenants)
      .values({
        name: input.name,
        slug: tenantSlug,
        isolationMode,
      })
      .returning({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        isolationMode: tenants.isolationMode,
        createdAt: tenants.createdAt,
      });

    // Create the tenant schema with all DDL
    const tenantSchemaName = await createTenantSchema(txSql, tenant.id);

    const [defaultUserGroup] = await txDb
      .insert(userGroups)
      .values({
        tenantId: tenant.id,
        name: DEFAULT_USER_GROUP_NAME,
        description: DEFAULT_USER_GROUP_DESCRIPTION,
      })
      .returning({ id: userGroups.id });

    const [defaultAgentGroup] = await txDb
      .insert(agentGroups)
      .values({
        tenantId: tenant.id,
        name: DEFAULT_AGENT_GROUP_NAME,
        description: DEFAULT_AGENT_GROUP_DESCRIPTION,
      })
      .returning({ id: agentGroups.id });

    // Create the first admin agent with tenant_admin role
    const adminAgent = await provisionAgentWithApiKey(txSql, {
      externalId: adminExternalId,
      tenantId: tenant.id,
      isAutonomous: false,
      role: "tenant_admin",
    });

    await txDb.insert(agentGroupMembers).values({
      agentId: adminAgent.agent.id,
      groupId: defaultAgentGroup.id,
    });

    await txDb.insert(userGroupAgentGroupPermissions).values({
      userGroupId: defaultUserGroup.id,
      agentGroupId: defaultAgentGroup.id,
    });

    await seedDefaultGeneralGuidance(
      txSql,
      tenantSchemaName,
      defaultAgentGroup.id,
    );

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        isolationMode: tenant.isolationMode,
        createdAt: tenant.createdAt,
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
