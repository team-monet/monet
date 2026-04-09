import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as platformSchema from "@monet/db/schema";
import { createSqlClient, type SqlClient } from "@monet/db";
import { createApp } from "../../../src/app";
import { parseApiKey } from "../../../src/services/api-key.service";
import { waitForEnrichmentDrain } from "../../../src/services/enrichment.service";
import { provisionTenant } from "../../../src/services/tenant.service";
import path from "node:path";

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/monet_test";

let sql: SqlClient | null = null;
let db: ReturnType<typeof drizzle>;
let schemaReadyPromise: Promise<void> | null = null;
const apiKeyTenantSlug = new Map<string, string>();
const agentIdTenantSlug = new Map<string, string>();
let lastKnownTenantSlug: string | null = null;

function rememberTenantBinding(tenantSlug: string, apiKey?: string, agentId?: string) {
  lastKnownTenantSlug = tenantSlug;
  if (apiKey) apiKeyTenantSlug.set(apiKey, tenantSlug);
  if (agentId) agentIdTenantSlug.set(agentId, tenantSlug);
}

function getHeader(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return value;
    }
  }

  return undefined;
}

function resolveTenantSlugFromAuthHeader(authHeader: string | undefined): string | undefined {
  if (!authHeader?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authHeader.slice("Bearer ".length);
  const mappedByToken = apiKeyTenantSlug.get(token);
  if (mappedByToken) {
    return mappedByToken;
  }

  const parsed = parseApiKey(token);
  if (!parsed) {
    return undefined;
  }

  return agentIdTenantSlug.get(parsed.agentId);
}

function resolveSingleKnownTenantSlug(): string | undefined {
  const slugs = new Set<string>([
    ...apiKeyTenantSlug.values(),
    ...agentIdTenantSlug.values(),
  ]);

  if (slugs.size === 1) {
    return [...slugs][0];
  }

  return lastKnownTenantSlug ?? undefined;
}

async function applyPreparedSchemaUpgrades(s: SqlClient) {
  await s.unsafe(`
    CREATE TABLE IF NOT EXISTS "platform_installations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "initialized_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "platform_bootstrap_tokens" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "token_hash" varchar(255) NOT NULL,
      "token_salt" varchar(255) NOT NULL,
      "expires_at" timestamp with time zone NOT NULL,
      "used_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "platform_setup_sessions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "token_hash" varchar(255) NOT NULL,
      "token_salt" varchar(255) NOT NULL,
      "expires_at" timestamp with time zone NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "platform_oauth_configs" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "provider" varchar(50) DEFAULT 'oidc' NOT NULL,
      "issuer" varchar(255) NOT NULL,
      "client_id" varchar(255) NOT NULL,
      "client_secret_encrypted" varchar(1024) NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "platform_admins" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "email" varchar(255) NOT NULL,
      "external_id" varchar(255),
      "display_name" varchar(255),
      "last_login_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "slug" varchar(63);
    WITH normalized AS (
      SELECT
        id,
        COALESCE(
          NULLIF(
            LEFT(
              REGEXP_REPLACE(
                TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(name), '[^a-z0-9]+', '-', 'g')),
                '-{2,}',
                '-',
                'g'
              ),
              63
            ),
            ''
          ),
          'tenant'
        ) AS base_slug,
        created_at
      FROM "tenants"
    ),
    ranked AS (
      SELECT
        id,
        base_slug,
        ROW_NUMBER() OVER (PARTITION BY base_slug ORDER BY created_at, id) AS slug_rank
      FROM normalized
    )
    UPDATE "tenants" AS tenants
    SET "slug" = CASE
      WHEN ranked.slug_rank = 1 THEN ranked.base_slug
      ELSE LEFT(ranked.base_slug, 54) || '-' || SUBSTRING(tenants.id::text, 1, 8)
    END
    FROM ranked
    WHERE tenants.id = ranked.id
      AND tenants.slug IS NULL;

    ALTER TABLE "tenants" ALTER COLUMN "slug" SET NOT NULL;
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_name" varchar(255);
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" varchar(255);
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamp with time zone;

    CREATE TABLE IF NOT EXISTS "tenant_admin_nominations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "tenant_id" uuid NOT NULL,
      "email" varchar(255) NOT NULL,
      "claimed_by_user_id" uuid,
      "created_by_platform_admin_id" uuid NOT NULL,
      "claimed_at" timestamp with time zone,
      "revoked_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "user_groups" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "tenant_id" uuid NOT NULL,
      "name" varchar(255) NOT NULL,
      "description" varchar(1024) DEFAULT '' NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "user_groups_tenant_id_name_unique" UNIQUE("tenant_id","name")
    );
    CREATE TABLE IF NOT EXISTS "user_group_members" (
      "user_group_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "user_group_members_user_group_id_user_id_pk" PRIMARY KEY("user_group_id","user_id")
    );
    CREATE TABLE IF NOT EXISTS "user_group_agent_group_permissions" (
      "user_group_id" uuid NOT NULL,
      "agent_group_id" uuid NOT NULL,
      CONSTRAINT "user_group_agent_group_permissions_user_group_id_agent_group_id_pk" PRIMARY KEY("user_group_id","agent_group_id")
    );
  `);

  await s.unsafe(`
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'platform_admins_email_unique'
      ) THEN
        ALTER TABLE "platform_admins"
        ADD CONSTRAINT "platform_admins_email_unique" UNIQUE("email");
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'tenants_slug_unique'
      ) THEN
        ALTER TABLE "tenants"
        ADD CONSTRAINT "tenants_slug_unique" UNIQUE("slug");
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'users_tenant_id_external_id_unique'
      ) THEN
        ALTER TABLE "users"
        ADD CONSTRAINT "users_tenant_id_external_id_unique"
        UNIQUE("tenant_id", "external_id");
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'tenant_admin_nominations_tenant_fk'
      ) THEN
        ALTER TABLE "tenant_admin_nominations"
        ADD CONSTRAINT "tenant_admin_nominations_tenant_fk"
        FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'tenant_admin_nominations_claimed_user_fk'
      ) THEN
        ALTER TABLE "tenant_admin_nominations"
        ADD CONSTRAINT "tenant_admin_nominations_claimed_user_fk"
        FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'tenant_admin_nominations_created_admin_fk'
      ) THEN
        ALTER TABLE "tenant_admin_nominations"
        ADD CONSTRAINT "tenant_admin_nominations_created_admin_fk"
        FOREIGN KEY ("created_by_platform_admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'tenant_admin_nominations_tenant_id_email_unique'
      ) THEN
        ALTER TABLE "tenant_admin_nominations"
        ADD CONSTRAINT "tenant_admin_nominations_tenant_id_email_unique"
        UNIQUE("tenant_id", "email");
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'user_groups_tenant_fk'
      ) THEN
        ALTER TABLE "user_groups"
        ADD CONSTRAINT "user_groups_tenant_fk"
        FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'user_group_members_group_fk'
      ) THEN
        ALTER TABLE "user_group_members"
        ADD CONSTRAINT "user_group_members_group_fk"
        FOREIGN KEY ("user_group_id") REFERENCES "public"."user_groups"("id") ON DELETE no action ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'user_group_members_user_fk'
      ) THEN
        ALTER TABLE "user_group_members"
        ADD CONSTRAINT "user_group_members_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'user_group_agent_group_permissions_group_fk'
      ) THEN
        ALTER TABLE "user_group_agent_group_permissions"
        ADD CONSTRAINT "user_group_agent_group_permissions_group_fk"
        FOREIGN KEY ("user_group_id") REFERENCES "public"."user_groups"("id") ON DELETE no action ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'user_group_agent_group_permissions_agent_group_fk'
      ) THEN
        ALTER TABLE "user_group_agent_group_permissions"
        ADD CONSTRAINT "user_group_agent_group_permissions_agent_group_fk"
        FOREIGN KEY ("agent_group_id") REFERENCES "public"."agent_groups"("id") ON DELETE no action ON UPDATE no action;
      END IF;
    END
    $do$;
  `);
}

async function ensurePlatformSchemaReady() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      const s = getTestSql();
      const [
        {
          tenantsTable,
          usersTable,
          platformInstallationsTable,
          tenantSlugColumn,
          platformAdminsTable,
          tenantUsersEmailColumn,
          tenantUsersLastLoginColumn,
          tenantAdminNominationsTable,
          userGroupsTable,
          userGroupMembersTable,
          userGroupAgentGroupPermissionsTable,
        },
      ] = await s<{
        tenantsTable: string | null;
        usersTable: string | null;
        platformInstallationsTable: string | null;
        tenantSlugColumn: string | null;
        platformAdminsTable: string | null;
        tenantUsersEmailColumn: string | null;
        tenantUsersLastLoginColumn: string | null;
        tenantAdminNominationsTable: string | null;
        userGroupsTable: string | null;
        userGroupMembersTable: string | null;
        userGroupAgentGroupPermissionsTable: string | null;
      }[]>`
        SELECT
          to_regclass('public.tenants') AS "tenantsTable",
          to_regclass('public.users') AS "usersTable",
          to_regclass('public.platform_installations') AS "platformInstallationsTable",
          to_regclass('public.platform_admins') AS "platformAdminsTable",
          to_regclass('public.tenant_admin_nominations') AS "tenantAdminNominationsTable",
          to_regclass('public.user_groups') AS "userGroupsTable",
          to_regclass('public.user_group_members') AS "userGroupMembersTable",
          to_regclass('public.user_group_agent_group_permissions') AS "userGroupAgentGroupPermissionsTable",
          (
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'tenants'
              AND column_name = 'slug'
          ) AS "tenantSlugColumn",
          (
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND column_name = 'email'
          ) AS "tenantUsersEmailColumn",
          (
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'users'
              AND column_name = 'last_login_at'
          ) AS "tenantUsersLastLoginColumn"
      `;

      // CI can prepare platform tables via `drizzle-kit push`, which creates
      // schema objects without migration history rows. Running migrator on top
      // of that state would replay 0000 and fail on already-existing tables.
      if (
        tenantsTable &&
        usersTable &&
        platformInstallationsTable &&
        tenantSlugColumn &&
        platformAdminsTable &&
        tenantUsersEmailColumn &&
        tenantUsersLastLoginColumn &&
        tenantAdminNominationsTable &&
        userGroupsTable &&
        userGroupMembersTable &&
        userGroupAgentGroupPermissionsTable
      ) {
        return;
      }

      // The public schema naming changed from legacy user tables to `users`.
      // In the dedicated integration DB it is safe to rebuild from scratch
      // instead of trying to preserve the old local state.
      if (tenantsTable && !usersTable) {
        await s.unsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
        await s.unsafe(`CREATE SCHEMA public`);
        await s.unsafe(`GRANT ALL ON SCHEMA public TO postgres`);
        await s.unsafe(`GRANT ALL ON SCHEMA public TO public`);
        await s.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);

        const migrationDb = drizzle(s);
        const migrationsFolder = path.resolve(process.cwd(), "../../packages/db/drizzle");
        await migrate(migrationDb, { migrationsFolder });
        return;
      }

      // Older prepared schemas may have some or all platform tables already
      // pushed without migration rows. Apply all additive upgrades idempotently
      // so integration tests can use the current platform schema state.
      if (tenantsTable) {
        await applyPreparedSchemaUpgrades(s);
        return;
      }

      await s.unsafe(`DROP TABLE IF EXISTS drizzle.__drizzle_migrations`);

      const migrationDb = drizzle(s);
      const migrationsFolder = path.resolve(process.cwd(), "../../packages/db/drizzle");
      await migrate(migrationDb, { migrationsFolder });
    })();
  }

  await schemaReadyPromise;
}

export function getTestSql() {
  if (!sql) {
    // Disable prepared statement caching so that dropping & recreating
    // tenant schemas (which carry per-schema enum types) between tests
    // does not cause stale type-OID errors (XX000 / getTypeInputInfo).
    sql = createSqlClient(TEST_DB_URL, {
      prepare: false,
      // Integration cleanup drops tenant schemas between tests, which emits
      // expected NOTICE messages from Postgres. Suppress them to keep test
      // output readable.
      onnotice: () => {},
    });
  }
  return sql;
}

export function getTestDb() {
  if (!db) {
    db = drizzle(getTestSql(), { schema: { ...platformSchema } });
  }
  return db;
}

export function getTestApp() {
  const app = createApp(getTestDb() as unknown as Parameters<typeof createApp>[0], getTestSql());
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input !== "string") {
      return app.request(input, init);
    }

    let path = input;

    if (path.startsWith("/api/") && !path.startsWith("/api/tenants/") && !path.startsWith("/api/bootstrap")) {
      const slug =
        resolveTenantSlugFromAuthHeader(getHeader(init?.headers, "authorization"))
        ?? resolveSingleKnownTenantSlug();
      if (slug) {
        path = `/api/tenants/${slug}${path.slice(4)}`;
      }
    }

    if (path === "/mcp" || path.startsWith("/mcp?")) {
      const slug =
        resolveTenantSlugFromAuthHeader(getHeader(init?.headers, "authorization"))
        ?? resolveSingleKnownTenantSlug();
      if (slug) {
        path = `/mcp/${slug}${path.slice(4)}`;
      }
    }

    const response = await app.request(path, init);

    const registerMatch = path.match(/^\/api\/tenants\/([^/]+)\/agents\/register(?:\?.*)?$/);
    if (registerMatch && response.status === 201) {
      try {
        const payload = await response.clone().json() as {
          apiKey?: string;
          agent?: { id?: string };
        };
        rememberTenantBinding(registerMatch[1], payload.apiKey, payload.agent?.id);
      } catch {
        // ignore non-JSON payloads in tests
      }
    }

    return response;
  };

  return new Proxy(app, {
    get(target, prop, receiver) {
      if (prop === "request") {
        return request;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export async function provisionTestTenant(
  input: {
    name: string;
    slug?: string;
    isolationMode?: "logical" | "physical";
  },
) {
  await ensurePlatformSchemaReady();

  const result = await provisionTenant(getTestDb(), getTestSql(), input);
  const schemaName = `tenant_${result.tenant.id.replace(/-/g, "_")}`;
  const [defaultMembership] = await getTestSql().unsafe(
    `SELECT group_id
     FROM "${schemaName}".agent_group_members
     WHERE agent_id = $1
     ORDER BY joined_at ASC, group_id ASC
     LIMIT 1`,
    [result.agent.id],
  );
  const body = {
    tenant: result.tenant,
    agent: result.agent,
    apiKey: result.rawApiKey,
    defaultGroupId: defaultMembership?.group_id as string | undefined,
  };
  rememberTenantBinding(result.tenant.slug, result.rawApiKey, result.agent.id);
  const res = new Response(JSON.stringify(body), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
    },
  });

  return { res, body };
}

export async function cleanupTestData() {
  // Give background enrichment jobs a chance to finish before dropping schemas.
  await waitForEnrichmentDrain(5_000);
  await ensurePlatformSchemaReady();
  apiKeyTenantSlug.clear();
  agentIdTenantSlug.clear();
  lastKnownTenantSlug = null;

  const s = getTestSql();

  const schemas = await s`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
  `;
  for (const row of schemas) {
    await s.unsafe(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
  }

  const candidatePublicTables = [
    "tenant_admin_nominations",
    "platform_oauth_configs",
    "platform_admins",
    "platform_setup_sessions",
    "platform_bootstrap_tokens",
    "platform_installations",
    "user_group_agent_group_permissions",
    "user_group_members",
    "user_groups",
    "agent_group_members",
    "agent_groups",
    "agents",
    "users",
    "tenants",
  ];

  const existingPublicTables = await s<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY(${candidatePublicTables}::text[])
  `;

  if (existingPublicTables.length > 0) {
    const quotedTableList = existingPublicTables
      .map((row) => `"${row.table_name}"`)
      .join(", ");
    await s.unsafe(`TRUNCATE TABLE ${quotedTableList} CASCADE`);
  }
}

export async function closeTestDb() {
  if (sql) {
    await sql.end();
  }
}
