import { randomUUID } from "node:crypto";
import type { SqlClient } from "@monet/db";
import {
  createTenantSchema,
  tenantSchemaNameFromId,
  tenantUsers,
  tenantAdminNominations,
  tenantOauthConfigs,
  tenants,
  withTenantDrizzleScope,
  withTenantScope,
} from "@monet/db";
import type { CreateTenantInput } from "@monet/types";
import {
  DEFAULT_AGENT_GROUP_DESCRIPTION,
  DEFAULT_AGENT_GROUP_NAME,
  DEFAULT_USER_GROUP_DESCRIPTION,
  DEFAULT_USER_GROUP_NAME,
  slugifyTenantName,
  validateTenantSlug,
} from "@monet/types";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, getSqlClient } from "./db";
import { decrypt, encrypt } from "./crypto";
import { generateApiKey, hashApiKey } from "./api-key";
import { seedDefaultGeneralGuidance } from "./default-rule-seed";
import {
  resolveOidcIssuerForServer,
  validateOidcClientConfig,
  validateOidcIssuer,
} from "./oidc";

type PgError = {
  code?: string;
  constraint_name?: string;
};

export type PlatformTenantSummary = {
  id: string;
  name: string;
  slug: string;
  isolationMode: "logical" | "physical";
  createdAt: Date;
  oidcConfigured: boolean;
  oidcIssuer: string | null;
};

export type PlatformTenantOidcConfig = {
  id: string;
  tenantId: string;
  issuer: string;
  clientId: string;
  createdAt: Date;
};

export type PlatformTenantAdminNomination = {
  id: string;
  email: string;
  claimedAt: Date | null;
  createdAt: Date;
  claimedByUserId: string | null;
  claimedByLabel: string | null;
};

export type CreatePlatformTenantResult = {
  tenant: {
    id: string;
    name: string;
    slug: string;
    isolationMode: "logical" | "physical";
    createdAt: Date;
  };
  agent: {
    id: string;
    externalId: string;
  };
  rawApiKey: string;
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

function normalizeTenantInput(input: CreateTenantInput) {
  const name = input.name.trim();
  const slug = input.slug?.trim() || slugifyTenantName(name);

  if (!name) {
    throw new Error("Tenant name is required.");
  }

  if (!slug) {
    throw new Error("Tenant slug is required.");
  }

  const slugValidationError = validateTenantSlug(slug);
  if (slugValidationError) {
    throw new Error(slugValidationError);
  }

  return {
    name,
    slug,
    isolationMode: input.isolationMode ?? "logical",
  } as const;
}

export async function listPlatformTenants(): Promise<PlatformTenantSummary[]> {
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      isolationMode: tenants.isolationMode,
      createdAt: tenants.createdAt,
      oidcConfigId: tenantOauthConfigs.id,
      oidcIssuer: tenantOauthConfigs.issuer,
    })
    .from(tenants)
    .leftJoin(tenantOauthConfigs, eq(tenantOauthConfigs.tenantId, tenants.id))
    .orderBy(desc(tenants.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    isolationMode: row.isolationMode,
    createdAt: row.createdAt,
    oidcConfigured: Boolean(row.oidcConfigId),
    oidcIssuer: row.oidcIssuer,
  }));
}

export async function getPlatformTenant(tenantId: string) {
  const [row] = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      isolationMode: tenants.isolationMode,
      createdAt: tenants.createdAt,
      oidcConfigId: tenantOauthConfigs.id,
      oidcIssuer: tenantOauthConfigs.issuer,
      oidcClientId: tenantOauthConfigs.clientId,
      oidcCreatedAt: tenantOauthConfigs.createdAt,
    })
    .from(tenants)
    .leftJoin(tenantOauthConfigs, eq(tenantOauthConfigs.tenantId, tenants.id))
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!row) {
    return null;
  }

  const adminNominations = await db
    .select({
      id: tenantAdminNominations.id,
      email: tenantAdminNominations.email,
      claimedAt: tenantAdminNominations.claimedAt,
      createdAt: tenantAdminNominations.createdAt,
      claimedByUserId: tenantAdminNominations.claimedByUserId,
    })
    .from(tenantAdminNominations)
    .where(
      and(
        eq(tenantAdminNominations.tenantId, tenantId),
        isNull(tenantAdminNominations.revokedAt),
      ),
    )
    .orderBy(desc(tenantAdminNominations.createdAt));

  const claimedByUserIds = adminNominations
    .map((nomination) => nomination.claimedByUserId)
    .filter((value): value is string => Boolean(value));

  const claimedByUserMap = claimedByUserIds.length > 0
    ? new Map((await withTenantDrizzleScope(
      getSqlClient(),
      tenantSchemaNameFromId(tenantId),
      async (tenantDb) => tenantDb
        .select({
          id: tenantUsers.id,
          displayName: tenantUsers.displayName,
          email: tenantUsers.email,
          externalId: tenantUsers.externalId,
        })
        .from(tenantUsers)
        .where(inArray(tenantUsers.id, claimedByUserIds)),
    )).map((user) => [user.id, user]))
    : new Map<string, { id: string; displayName: string | null; email: string | null; externalId: string }>();

  return {
    tenant: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      isolationMode: row.isolationMode,
      createdAt: row.createdAt,
    },
    oidcConfig: row.oidcConfigId
      ? {
          id: row.oidcConfigId,
          tenantId: row.id,
          issuer: row.oidcIssuer!,
          clientId: row.oidcClientId!,
          createdAt: row.oidcCreatedAt!,
        }
      : null,
    adminNominations: adminNominations.map((nomination) => ({
      claimedBy: nomination.claimedByUserId
        ? claimedByUserMap.get(nomination.claimedByUserId)
        : null,
      id: nomination.id,
      email: nomination.email,
      claimedAt: nomination.claimedAt,
      createdAt: nomination.createdAt,
      claimedByUserId: nomination.claimedByUserId,
      claimedByLabel:
        (nomination.claimedByUserId
          ? claimedByUserMap.get(nomination.claimedByUserId)?.displayName ??
            claimedByUserMap.get(nomination.claimedByUserId)?.email ??
            claimedByUserMap.get(nomination.claimedByUserId)?.externalId
          : null) ?? null,
    })),
  };
}

export async function createPlatformTenant(
  input: CreateTenantInput,
): Promise<CreatePlatformTenantResult> {
  const tenantInput = normalizeTenantInput(input);

  const [existingTenantWithSlug] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, tenantInput.slug))
    .limit(1);
  if (existingTenantWithSlug) {
    throw new Error("Tenant slug already exists.");
  }

  const adminExternalId = `admin@${tenantInput.slug}`;
  const adminAgentId = randomUUID();
  const rawApiKey = generateApiKey(adminAgentId);
  const { hash, salt } = hashApiKey(rawApiKey);

  try {
    const result = await getSqlClient().begin(async (txSql) => {
      const tx = txSql as unknown as SqlClient;

      const [tenant] = await tx`
        INSERT INTO tenants (name, slug, isolation_mode)
        VALUES (${tenantInput.name}, ${tenantInput.slug}, ${tenantInput.isolationMode})
        RETURNING id, name, slug, isolation_mode, created_at
      `;

      const tenantSchemaName = await createTenantSchema(txSql, tenant.id);

      const [defaultUserGroup] = await withTenantScope(tx, tenantSchemaName, (tenantSql) => (tenantSql as unknown as SqlClient)`
        INSERT INTO user_groups (tenant_id, name, description)
        VALUES (
          ${tenant.id},
          ${DEFAULT_USER_GROUP_NAME},
          ${DEFAULT_USER_GROUP_DESCRIPTION}
        )
        RETURNING id
      `) as Array<{ id: string }>;

      const [defaultAgentGroup] = await withTenantScope(tx, tenantSchemaName, (tenantSql) => (tenantSql as unknown as SqlClient)`
        INSERT INTO agent_groups (tenant_id, name, description)
        VALUES (
          ${tenant.id},
          ${DEFAULT_AGENT_GROUP_NAME},
          ${DEFAULT_AGENT_GROUP_DESCRIPTION}
        )
        RETURNING id
      `) as Array<{ id: string }>;

      const [agent] = await withTenantScope(tx, tenantSchemaName, (tenantSql) => (tenantSql as unknown as SqlClient)`
        INSERT INTO agents (
          id,
          external_id,
          tenant_id,
          api_key_hash,
          api_key_salt,
          is_autonomous,
          role
        )
        VALUES (
          ${adminAgentId},
          ${adminExternalId},
          ${tenant.id},
          ${hash},
          ${salt},
          ${false},
          ${"tenant_admin"}
        )
        RETURNING id, external_id
      `) as Array<{ id: string; external_id: string }>;

      await withTenantScope(tx, tenantSchemaName, (tenantSql) => (tenantSql as unknown as SqlClient)`
        INSERT INTO agent_group_members (agent_id, group_id)
        VALUES (${agent.id}, ${defaultAgentGroup.id})
      `);

      await withTenantScope(tx, tenantSchemaName, (tenantSql) => (tenantSql as unknown as SqlClient)`
        INSERT INTO user_group_agent_group_permissions (user_group_id, agent_group_id)
        VALUES (${defaultUserGroup.id}, ${defaultAgentGroup.id})
      `);

      await seedDefaultGeneralGuidance(
        tx,
        tenantSchemaName,
        defaultAgentGroup.id as string,
      );

      return {
        tenant: {
          id: tenant.id as string,
          name: tenant.name as string,
          slug: tenant.slug as string,
          isolationMode: tenant.isolation_mode as "logical" | "physical",
          createdAt: tenant.created_at as Date,
        },
        agent: {
          id: agent.id as string,
          externalId: agent.external_id as string,
        },
      };
    });

    return {
      tenant: result.tenant,
      agent: result.agent,
      rawApiKey,
    };
  } catch (error) {
    const message = uniqueTenantMessage(error);
    if (message) {
      throw new Error(message);
    }
    throw error;
  }
}

type SaveTenantOidcConfigInput = {
  tenantId: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
};

export async function saveTenantOidcConfig(input: SaveTenantOidcConfigInput) {
  const tenantId = input.tenantId.trim();
  const issuer = resolveOidcIssuerForServer(input.issuer);
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret?.trim() || "";

  if (!tenantId || !issuer || !clientId) {
    throw new Error("Tenant, issuer, and client ID are required.");
  }

  await validateOidcIssuer(issuer);

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!tenant) {
    throw new Error("Tenant not found.");
  }

  const [existingConfig] = await db
    .select({
      id: tenantOauthConfigs.id,
      clientSecretEncrypted: tenantOauthConfigs.clientSecretEncrypted,
    })
    .from(tenantOauthConfigs)
    .where(eq(tenantOauthConfigs.tenantId, tenantId))
    .limit(1);

  const clientSecretEncrypted =
    clientSecret.length > 0
      ? encrypt(clientSecret)
      : existingConfig?.clientSecretEncrypted;

  if (!clientSecretEncrypted) {
    throw new Error("Client secret is required the first time OIDC is configured.");
  }

  const secretForValidation =
    clientSecret.length > 0
      ? clientSecret
      : decrypt(clientSecretEncrypted);

  await validateOidcClientConfig({
    issuer,
    clientId,
    clientSecret: secretForValidation,
    callbackPath: "/api/auth/callback/tenant-oauth",
  });

  const [config] = await db
    .insert(tenantOauthConfigs)
    .values({
      tenantId,
      issuer,
      clientId,
      clientSecretEncrypted,
    })
    .onConflictDoUpdate({
      target: tenantOauthConfigs.tenantId,
      set: {
        issuer,
        clientId,
        clientSecretEncrypted,
      },
    })
    .returning({
      id: tenantOauthConfigs.id,
      tenantId: tenantOauthConfigs.tenantId,
      issuer: tenantOauthConfigs.issuer,
      clientId: tenantOauthConfigs.clientId,
      createdAt: tenantOauthConfigs.createdAt,
    });

  return config satisfies PlatformTenantOidcConfig;
}

type SaveTenantAdminNominationInput = {
  tenantId: string;
  email: string;
  createdByPlatformAdminId: string;
};

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export async function saveTenantAdminNomination(
  input: SaveTenantAdminNominationInput,
) {
  const tenantId = input.tenantId.trim();
  const email = normalizeEmail(input.email);
  const createdByPlatformAdminId = input.createdByPlatformAdminId.trim();

  if (!tenantId || !email || !createdByPlatformAdminId) {
    throw new Error("Tenant and admin email are required.");
  }

  if (!email.includes("@")) {
    throw new Error("A valid admin email is required.");
  }

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!tenant) {
    throw new Error("Tenant not found.");
  }

  const [nomination] = await db
    .insert(tenantAdminNominations)
    .values({
      tenantId,
      email,
      createdByPlatformAdminId,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: [
        tenantAdminNominations.tenantId,
        tenantAdminNominations.email,
      ],
      set: {
        createdByPlatformAdminId,
        revokedAt: null,
      },
    })
    .returning({
      id: tenantAdminNominations.id,
      email: tenantAdminNominations.email,
      claimedAt: tenantAdminNominations.claimedAt,
      createdAt: tenantAdminNominations.createdAt,
      claimedByUserId: tenantAdminNominations.claimedByUserId,
    });

  return nomination;
}
