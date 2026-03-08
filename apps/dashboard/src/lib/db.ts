import { createClient } from "@monet/db";

let client: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (client) {
    return client;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  client = createClient(databaseUrl);
  return client;
}

export function getSqlClient() {
  return getClient().sql;
}

export const db = new Proxy({} as ReturnType<typeof createClient>["db"], {
  get(_target, prop) {
    const dbClient = getClient().db;
    const value = Reflect.get(dbClient as object, prop);
    return typeof value === "function" ? value.bind(dbClient) : value;
  },
});

export const sql = ((...args: unknown[]) =>
  (getClient().sql as unknown as (...sqlArgs: unknown[]) => unknown)(...args)) as ReturnType<
  typeof createClient
>["sql"];
