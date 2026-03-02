import { serve } from "@hono/node-server";
import { createClient } from "@monet/db";
import { createApp } from "./app.js";
import { startTtlExpiryJob } from "./services/ttl-expiry.service.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const { db, sql } = createClient(databaseUrl);
const app = createApp(db, sql);

const port = parseInt(process.env.API_PORT || "3001", 10);

console.log(`Starting Monet API on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`API server running at http://localhost:${port}`);

// Start TTL expiry background job (runs on startup + every 60 minutes)
startTtlExpiryJob(sql);
