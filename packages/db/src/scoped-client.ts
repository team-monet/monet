import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  asDrizzleSqlClient,
  resolveSqlClientOptions,
  type Database,
} from "./client";
import * as platformSchema from "./schema/platform";
import * as tenantSchema from "./schema/tenant";

const SCHEMA_NAME_REGEX = /^tenant_[a-f0-9_]{36}$/;
const databaseSchema = {
  ...platformSchema,
  ...tenantSchema,
};

type ScopedSql = postgres.Sql | postgres.TransactionSql;

function hasBegin(sql: ScopedSql): sql is postgres.Sql {
  return typeof (sql as { begin?: unknown }).begin === "function";
}

function drizzleClientOptions(sql: ScopedSql) {
  return resolveSqlClientOptions(sql);
}

/**
 * Execute a function within a transaction scoped to a specific tenant schema.
 *
 * Uses `SET LOCAL search_path` which only affects the current transaction,
 * preventing connection pool contamination.
 */
export async function withTenantScope<T>(
  sql: ScopedSql,
  schemaName: string,
  fn: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!SCHEMA_NAME_REGEX.test(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }

  if (hasBegin(sql)) {
    const result = await sql.begin(async (txSql) => {
      await txSql.unsafe(
        `SET LOCAL search_path TO "${schemaName}", public`,
      );
      return fn(txSql);
    });
    return result as T;
  }

  await sql.unsafe(
    `SET LOCAL search_path TO "${schemaName}", public`,
  );
  return fn(sql);
}

export async function withTenantDrizzleScope<T>(
  sql: ScopedSql,
  schemaName: string,
  fn: (db: Database, sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return withTenantScope(sql, schemaName, async (txSql) => {
    const db = drizzle(asDrizzleSqlClient(txSql, drizzleClientOptions(sql)), {
      schema: databaseSchema,
    }) as Database;
    return fn(db, txSql);
  });
}
