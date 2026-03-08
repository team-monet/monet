import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as platformSchema from "@monet/db/schema";
import { createApp } from "../../../src/app.js";
import path from "node:path";

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/monet_test";

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;
let schemaReadyPromise: Promise<void> | null = null;

async function ensurePlatformSchemaReady() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      const s = getTestSql();
      const [{ tenantsTable, platformInstallationsTable }] = await s<{
        tenantsTable: string | null;
        platformInstallationsTable: string | null;
      }[]>`
        SELECT
          to_regclass('public.tenants') AS "tenantsTable",
          to_regclass('public.platform_installations') AS "platformInstallationsTable"
      `;

      // CI can prepare platform tables via `drizzle-kit push`, which creates
      // schema objects without migration history rows. Running migrator on top
      // of that state would replay 0000 and fail on already-existing tables.
      if (tenantsTable && platformInstallationsTable) {
        return;
      }

      // Older prepared schemas may have the original platform tables but not
      // newer additive migrations. Apply the bootstrap tables idempotently so
      // integration tests can run without replaying the full migration history.
      if (tenantsTable && !platformInstallationsTable) {
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
        `);
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
  app: ReturnType<typeof createApp>,
  name: string,
  adminSecret: string,
) {
  await ensurePlatformSchemaReady();

  const res = await app.request("/api/tenants", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminSecret}`,
    },
    body: JSON.stringify({ name }),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
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
        platform_setup_sessions,
        platform_bootstrap_tokens,
        platform_installations,
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
