import { createSqlClient, ensureVectorExtension } from "@monet/db";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/monet_test";

export default async function setup() {
  const sql = createSqlClient(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
  });

  try {
    await ensureVectorExtension(sql);
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}
