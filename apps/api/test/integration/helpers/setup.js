import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import * as platformSchema from "@monet/db/schema";
import { createApp } from "../../../src/app.js";
import path from "node:path";
const TEST_DB_URL = process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/monet_test";
let sql;
let db;
let schemaReadyPromise = null;
async function ensurePlatformSchemaReady() {
    if (!schemaReadyPromise) {
        schemaReadyPromise = (async () => {
            const s = getTestSql();
            const [{ tenantsTable }] = await s `
        SELECT to_regclass('public.tenants') AS "tenantsTable"
      `;
            if (!tenantsTable) {
                await s.unsafe(`DROP TABLE IF EXISTS drizzle.__drizzle_migrations`);
            }
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
            onnotice: () => { },
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
    return createApp(getTestDb(), getTestSql());
}
export async function provisionTestTenant(app, name, adminSecret) {
    await ensurePlatformSchemaReady();
    const res = await app.request("/api/tenants", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminSecret}`,
        },
        body: JSON.stringify({ name }),
    });
    return { res, body: (await res.json()) };
}
export async function cleanupTestData() {
    await ensurePlatformSchemaReady();
    const s = getTestSql();
    const schemas = await s `
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
  `;
    for (const row of schemas) {
        await s.unsafe(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
    }
    await s.unsafe(`
    DO $$ BEGIN
      TRUNCATE TABLE agent_group_members, agent_groups, agents, human_users, tenants CASCADE;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$
  `);
}
export async function closeTestDb() {
    if (sql) {
        await sql.end();
    }
}
//# sourceMappingURL=setup.js.map
