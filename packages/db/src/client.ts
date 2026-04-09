import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as platformSchema from "./schema/platform.js";
import * as tenantSchema from "./schema/tenant.js";

export type SqlClient = postgres.Sql;
export type TransactionClient = postgres.TransactionSql;
export type SqlParameter = postgres.ParameterOrJSON<never>;
export type SqlClientOptions = NonNullable<Parameters<typeof postgres>[1]>;
export type DrizzleSqlClientOptions = NonNullable<SqlClient["options"]>;
type DrizzleCapableSqlClient = SqlClient | TransactionClient;
const DEFAULT_DRIZZLE_SQL_CLIENT_OPTIONS: DrizzleSqlClientOptions = {
  parsers: {},
  serializers: {},
} as DrizzleSqlClientOptions;

export function createSqlClient(
  databaseUrl: string,
  options?: SqlClientOptions,
): SqlClient {
  return postgres(databaseUrl, options);
}

export function resolveSqlClientOptions(
  sql: DrizzleCapableSqlClient,
  fallback?: DrizzleSqlClientOptions,
): DrizzleSqlClientOptions {
  return (
    (sql as { options?: DrizzleSqlClientOptions }).options ??
    fallback ??
    DEFAULT_DRIZZLE_SQL_CLIENT_OPTIONS
  );
}

export function asDrizzleSqlClient(
  sql: DrizzleCapableSqlClient,
  fallback?: DrizzleSqlClientOptions,
): SqlClient {
  const options = resolveSqlClientOptions(sql, fallback);
  const sqlObj = sql as unknown as Record<string, unknown>;
  const isTransaction = typeof sqlObj.begin !== "function" && typeof sqlObj.savepoint === "function";

  if (!isTransaction && (sql as { options?: DrizzleSqlClientOptions }).options === options) {
    return sql as SqlClient;
  }

  return new Proxy(sql as unknown as SqlClient, {
    get(target, prop, receiver) {
      if (prop === "options") {
        return options;
      }
      if (prop === "begin" && isTransaction) {
        const targetObj = target as unknown as Record<string, unknown>;
        return typeof targetObj.savepoint === "function" ? targetObj.savepoint.bind(target) : undefined;
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createClient(databaseUrl: string) {
  const sql = createSqlClient(databaseUrl);
  const db = drizzle(asDrizzleSqlClient(sql), {
    schema: { ...platformSchema, ...tenantSchema },
  });
  return { db, sql };
}

export type Database = ReturnType<typeof createClient>["db"];
