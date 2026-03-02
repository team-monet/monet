import postgres from "postgres";

const SCHEMA_NAME_REGEX = /^tenant_[a-f0-9_]{36}$/;

/**
 * Execute a function within a transaction scoped to a specific tenant schema.
 *
 * Uses `SET LOCAL search_path` which only affects the current transaction,
 * preventing connection pool contamination.
 */
export async function withTenantScope<T>(
  sql: postgres.Sql,
  schemaName: string,
  fn: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  if (!SCHEMA_NAME_REGEX.test(schemaName)) {
    throw new Error(`Invalid tenant schema name: ${schemaName}`);
  }

  const result = await sql.begin(async (txSql) => {
    await txSql.unsafe(
      `SET LOCAL search_path TO "${schemaName}"`,
    );
    return fn(txSql);
  });
  return result as T;
}
