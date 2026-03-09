import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as platformSchema from "@monet/db/schema";
import { createApp } from "../../../src/app.js";
import { provisionTenant } from "../../../src/services/tenant.service.js";
import path from "node:path";

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/monet_test";

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
let schemaReadyPromise: Promise<void> | null = null;

async function applyPreparedSchemaUpgrades(s: ReturnType<typeof postgres>) {
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
    ALTER TABLE "human_users" ADD COLUMN IF NOT EXISTS "email" varchar(255);
    ALTER TABLE "human_users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamp with time zone;

    CREATE TABLE IF NOT EXISTS "tenant_admin_nominations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "tenant_id" uuid NOT NULL,
      "email" varchar(255) NOT NULL,
      "claimed_by_human_user_id" uuid,
      "created_by_platform_admin_id" uuid NOT NULL,
      "claimed_at" timestamp with time zone,
      "revoked_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "human_groups" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "tenant_id" uuid NOT NULL,
      "name" varchar(255) NOT NULL,
      "description" varchar(1024) DEFAULT '' NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "human_groups_tenant_id_name_unique" UNIQUE("tenant_id","name")
    );
    CREATE TABLE IF NOT EXISTS "human_group_members" (
      "human_group_id" uuid NOT NULL,
      "user_id" uuid NOT NULL,
      "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "human_group_members_human_group_id_user_id_pk" PRIMARY KEY("human_group_id","user_id")
    );
    CREATE TABLE IF NOT EXISTS "human_group_agent_group_permissions" (
      "human_group_id" uuid NOT NULL,
      "agent_group_id" uuid NOT NULL,
      CONSTRAINT "human_group_agent_group_permissions_human_group_id_agent_group_id_pk" PRIMARY KEY("human_group_id","agent_group_id")
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
        WHERE conname = 'human_users_tenant_id_external_id_unique'
      ) THEN
        ALTER TABLE "human_users"
        ADD CONSTRAINT "human_users_tenant_id_external_id_unique"
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
        FOREIGN KEY ("claimed_by_human_user_id") REFERENCES "public"."human_users"("id") ON DELETE no action ON UPDATE no action;
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
        WHERE conname = 'human_groups_tenant_fk'
      ) THEN
        ALTER TABLE "human_groups"
        ADD CONSTRAINT "human_groups_tenant_fk"
        FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'human_group_members_group_fk'
      ) THEN
        ALTER TABLE "human_group_members"
        ADD CONSTRAINT "human_group_members_group_fk"
        FOREIGN KEY ("human_group_id") REFERENCES "public"."human_groups"("id") ON DELETE no action ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'human_group_members_user_fk'
      ) THEN
        ALTER TABLE "human_group_members"
        ADD CONSTRAINT "human_group_members_user_fk"
        FOREIGN KEY ("user_id") REFERENCES "public"."human_users"("id") ON DELETE no action ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'human_group_agent_group_permissions_group_fk'
      ) THEN
        ALTER TABLE "human_group_agent_group_permissions"
        ADD CONSTRAINT "human_group_agent_group_permissions_group_fk"
        FOREIGN KEY ("human_group_id") REFERENCES "public"."human_groups"("id") ON DELETE no action ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'human_group_agent_group_permissions_agent_group_fk'
      ) THEN
        ALTER TABLE "human_group_agent_group_permissions"
        ADD CONSTRAINT "human_group_agent_group_permissions_agent_group_fk"
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
          platformInstallationsTable,
          tenantSlugColumn,
          platformAdminsTable,
          humanUsersEmailColumn,
          humanUsersLastLoginColumn,
          tenantAdminNominationsTable,
          humanGroupsTable,
          humanGroupMembersTable,
          humanGroupAgentGroupPermissionsTable,
        },
      ] = await s<{
        tenantsTable: string | null;
        platformInstallationsTable: string | null;
        tenantSlugColumn: string | null;
        platformAdminsTable: string | null;
        humanUsersEmailColumn: string | null;
        humanUsersLastLoginColumn: string | null;
        tenantAdminNominationsTable: string | null;
        humanGroupsTable: string | null;
        humanGroupMembersTable: string | null;
        humanGroupAgentGroupPermissionsTable: string | null;
      }[]>`
        SELECT
          to_regclass('public.tenants') AS "tenantsTable",
          to_regclass('public.platform_installations') AS "platformInstallationsTable",
          to_regclass('public.platform_admins') AS "platformAdminsTable",
          to_regclass('public.tenant_admin_nominations') AS "tenantAdminNominationsTable",
          to_regclass('public.human_groups') AS "humanGroupsTable",
          to_regclass('public.human_group_members') AS "humanGroupMembersTable",
          to_regclass('public.human_group_agent_group_permissions') AS "humanGroupAgentGroupPermissionsTable",
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
              AND table_name = 'human_users'
              AND column_name = 'email'
          ) AS "humanUsersEmailColumn",
          (
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'human_users'
              AND column_name = 'last_login_at'
          ) AS "humanUsersLastLoginColumn"
      `;

      // CI can prepare platform tables via `drizzle-kit push`, which creates
      // schema objects without migration history rows. Running migrator on top
      // of that state would replay 0000 and fail on already-existing tables.
      if (
        tenantsTable &&
        platformInstallationsTable &&
        tenantSlugColumn &&
        platformAdminsTable &&
        humanUsersEmailColumn &&
        humanUsersLastLoginColumn &&
        tenantAdminNominationsTable &&
        humanGroupsTable &&
        humanGroupMembersTable &&
        humanGroupAgentGroupPermissionsTable
      ) {
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
    sql = postgres(TEST_DB_URL, {
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
  return createApp(getTestDb() as unknown as Parameters<typeof createApp>[0], getTestSql());
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
  const [defaultMembership] = await getTestSql()`
    SELECT group_id
    FROM agent_group_members
    WHERE agent_id = ${result.agent.id}
    ORDER BY joined_at ASC, group_id ASC
    LIMIT 1
  `;
  const body = {
    tenant: result.tenant,
    agent: result.agent,
    apiKey: result.rawApiKey,
    defaultGroupId: defaultMembership?.group_id as string | undefined,
  };
  const res = new Response(JSON.stringify(body), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
    },
  });

  return { res, body };
}

export async function cleanupTestData() {
  await ensurePlatformSchemaReady();

  const s = getTestSql();

  const schemas = await s`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
  `;
  for (const row of schemas) {
    await s.unsafe(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
  }

  await s.unsafe(`
    DO $$ BEGIN
      TRUNCATE TABLE
        tenant_admin_nominations,
        platform_oauth_configs,
        platform_admins,
        platform_setup_sessions,
        platform_bootstrap_tokens,
        platform_installations,
        human_group_agent_group_permissions,
        human_group_members,
        human_groups,
        agent_group_members,
        agent_groups,
        agents,
        human_users,
        tenants
      CASCADE;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$
  `);
}

export async function closeTestDb() {
  if (sql) {
    await sql.end();
  }
}
