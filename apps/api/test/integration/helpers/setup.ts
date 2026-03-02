import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as platformSchema from "@monet/db/schema";
import { createApp } from "../../../src/app.js";

const TEST_DB_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/monet_test";

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;

export function getTestSql() {
  if (!sql) {
    sql = postgres(TEST_DB_URL);
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

/**
 * Provision a tenant via the API and return the result.
 */
export async function provisionTestTenant(
  app: ReturnType<typeof createApp>,
  name: string,
  adminSecret: string,
) {
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

/**
 * Clean up all test data. Drops tenant schemas and truncates platform tables.
 */
export async function cleanupTestData() {
  const s = getTestSql();

  // Find and drop all tenant schemas
  const schemas = await s`
    SELECT schema_name FROM information_schema.schemata
    WHERE schema_name LIKE 'tenant_%'
  `;
  for (const row of schemas) {
    await s.unsafe(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
  }

  // Truncate platform tables in correct order (respect FK constraints)
  await s`TRUNCATE TABLE agent_group_members CASCADE`;
  await s`TRUNCATE TABLE agent_groups CASCADE`;
  await s`TRUNCATE TABLE agents CASCADE`;
  await s`TRUNCATE TABLE human_users CASCADE`;
  await s`TRUNCATE TABLE tenants CASCADE`;
}

/**
 * Close the test database connection.
 */
export async function closeTestDb() {
  if (sql) {
    await sql.end();
  }
}
