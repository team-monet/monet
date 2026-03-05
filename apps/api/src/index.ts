import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createClient } from "@monet/db";
import { createApp } from "./app.js";
import { createMcpHandler } from "./mcp/handler.js";
import { sessionStore } from "./mcp/session-store.js";
import { recoverPendingEnrichments } from "./services/enrichment.service.js";
import { startTtlExpiryJob } from "./services/ttl-expiry.service.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const { db, sql } = createClient(databaseUrl);
const app = createApp(db, sql, sessionStore);
const mcpHandler = createMcpHandler({ db, sql, sessionStore });
const honoRequestListener = getRequestListener(app.fetch);

const port = parseInt(process.env.API_PORT || "3001", 10);

console.log(`Starting Monet API on port ${port}`);

const server = createServer((req, res) => {
  if (req.url?.startsWith("/mcp")) {
    void mcpHandler.handle(req, res);
    return;
  }

  honoRequestListener(req, res);
});

server.listen(port);

console.log(`API server running at http://localhost:${port}`);

// Start TTL expiry background job (runs on startup + every 60 minutes)
startTtlExpiryJob(sql);
void recoverPendingEnrichments(sql);
sessionStore.startIdleSweep(async (sessionId, session) => {
  console.info(`Closing idle MCP session ${sessionId}`);
  await Promise.allSettled([
    session.transport.close(),
    session.server.close(),
  ]);
  sessionStore.remove(sessionId);
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down`);
  sessionStore.stopIdleSweep();

  for (const [sessionId, session] of sessionStore.getAll()) {
    sessionStore.remove(sessionId);
    await Promise.allSettled([
      session.transport.close(),
      session.server.close(),
    ]);
  }

  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
