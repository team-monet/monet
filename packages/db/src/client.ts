import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as platformSchema from "./schema/platform.js";
import * as tenantSchema from "./schema/tenant.js";

export function createClient(databaseUrl: string) {
  const sql = postgres(databaseUrl);
  const db = drizzle(sql, {
    schema: { ...platformSchema, ...tenantSchema },
  });
  return { db, sql };
}

export type Database = ReturnType<typeof createClient>["db"];
