import { createSqlClient } from "@monet/db";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/monet_test";

const retries = Number.parseInt(process.env.MONET_CI_DB_RETRIES ?? "60", 10);
const delayMs = Number.parseInt(process.env.MONET_CI_DB_DELAY_MS ?? "2000", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastError = null;

for (let attempt = 1; attempt <= retries; attempt += 1) {
  const sql = createSqlClient(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
  });

  try {
    await sql`SELECT 1`;
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    console.log(`Database is ready at ${databaseUrl}`);
    await sql.end({ timeout: 1 });
    process.exit(0);
  } catch (error) {
    lastError = error;
    await sql.end({ timeout: 0 }).catch(() => {});

    if (attempt < retries) {
      console.log(
        `Waiting for database (${attempt}/${retries}) at ${databaseUrl}...`,
      );
      await sleep(delayMs);
      continue;
    }
  }
}

throw lastError ?? new Error("Failed to prepare the CI database.");
