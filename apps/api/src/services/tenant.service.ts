import {
  agentGroupMembers,
  agentGroups,
  asDrizzleSqlClient,
  createTenantSchema,
  type Database,
  type SqlClient,
  tenants,
  tenantOauthConfigs,
  withTenantDrizzleScope,
  type TransactionClient,
  userGroupAgentGroupPermissions,
  userGroups,
} from "@monet/db";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  DEFAULT_AGENT_GROUP_DESCRIPTION,
  DEFAULT_AGENT_GROUP_NAME,
  DEFAULT_USER_GROUP_DESCRIPTION,
  DEFAULT_USER_GROUP_NAME,
  slugifyTenantName,
  validateTenantSlug,
} from "@monet/types";
import { encrypt } from "../lib/crypto";
import { seedDefaultGeneralGuidance } from "./default-rule-seed.service";
import { provisionAgentWithApiKey } from "./agent-provisioning.service";

type TenantSqlClient = SqlClient | TransactionClient;
type TenantDrizzleOptions = NonNullable<SqlClient["options"]>;
type PgError = {
  code?: string;
  constraint_name?: string;
};

function isPgError(error: unknown): error is PgError {
  return typeof error === "object" && error !== null;
}

function isUniqueViolation(error: unknown) {
  return isPgError(error) && error.code === "23505";
}

function uniqueTenantMessage(error: unknown) {
  if (!isUniqueViolation(error)) return null;
  const pgError = error as PgError;

  if (pgError.constraint_name?.includes("tenants_name")) {
    return "Tenant name already exists.";
  }

  if (pgError.constraint_name?.includes("tenants_slug")) {
    return "Tenant slug already exists.";
  }

  return "Tenant name or slug already exists.";
}

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
  const tenantName = input.name.trim();
  const tenantSlug = input.slug?.trim() || slugifyTenantName(tenantName);
  if (!tenantName) {
    throw new Error("Tenant name is required.");
  }
  const slugValidationError = validateTenantSlug(tenantSlug);
  if (slugValidationError) {
    throw new Error(slugValidationError);
  }

  const adminExternalId = `admin@${tenantSlug}`;
  const isolationMode = input.isolationMode ?? "logical";

  try {
    // Use a transaction for atomicity of tenant + agent creation
    const result = await sql.begin(async (txSql) => {
      const txDb = createTenantDb(txSql, sql.options);

      const [existingTenantWithSlug] = await txDb
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, tenantSlug))
        .limit(1);
      if (existingTenantWithSlug) {
        throw new Error("Tenant slug already exists.");
      }

      const [tenant] = await txDb
        .insert(tenants)
        .values({
          name: tenantName,
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

      const { defaultUserGroup, defaultAgentGroup } = await withTenantDrizzleScope(
        txSql,
        tenantSchemaName,
        async (tenantDb) => {
          const [createdUserGroup] = await tenantDb
            .insert(userGroups)
            .values({
              tenantId: tenant.id,
              name: DEFAULT_USER_GROUP_NAME,
              description: DEFAULT_USER_GROUP_DESCRIPTION,
            })
            .returning({ id: userGroups.id });

          const [createdAgentGroup] = await tenantDb
            .insert(agentGroups)
            .values({
              tenantId: tenant.id,
              name: DEFAULT_AGENT_GROUP_NAME,
              description: DEFAULT_AGENT_GROUP_DESCRIPTION,
            })
            .returning({ id: agentGroups.id });

          return {
            defaultUserGroup: createdUserGroup,
            defaultAgentGroup: createdAgentGroup,
          };
        },
      );

      // Create the first admin agent with tenant_admin role
      const adminAgent = await provisionAgentWithApiKey(txSql, {
        externalId: adminExternalId,
        tenantId: tenant.id,
        isAutonomous: false,
        role: "tenant_admin",
      });

      await withTenantDrizzleScope(txSql, tenantSchemaName, async (tenantDb) => {
        await tenantDb.insert(agentGroupMembers).values({
          agentId: adminAgent.agent.id,
          groupId: defaultAgentGroup.id,
        });

        await tenantDb.insert(userGroupAgentGroupPermissions).values({
          userGroupId: defaultUserGroup.id,
          agentGroupId: defaultAgentGroup.id,
        });
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
  } catch (error) {
    const message = uniqueTenantMessage(error);
    if (message) {
      throw new Error(message);
    }
    throw error;
  }
}
