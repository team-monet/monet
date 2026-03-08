import { createServer } from "node:http";
import postgres from "postgres";
import { getRequestListener } from "@hono/node-server";
import { createClient } from "@monet/db";
import { createApp } from "./app.js";
import { createMcpHandler } from "./mcp/handler.js";
import { sessionStore } from "./mcp/session-store.js";
import { ensureBootstrapToken } from "./services/bootstrap.service.js";
import {
  getActiveEnrichmentCount,
  getQueuedEnrichmentCount,
  recoverPendingEnrichments,
  waitForEnrichmentDrain,
} from "./services/enrichment.service.js";
import {
  startTtlExpiryJob,
  stopTtlExpiryJob,
} from "./services/ttl-expiry.service.js";
import {
  startAuditRetentionJob,
  stopAuditRetentionJob,
} from "./services/audit-retention.service.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

const { db, sql } = createClient(databaseUrl);
const auditPurgeDatabaseUrl = process.env.AUDIT_PURGE_DATABASE_URL;
const auditPurgeSql = auditPurgeDatabaseUrl
  ? postgres(auditPurgeDatabaseUrl)
  : sql;
const hasDedicatedAuditPurgeClient = Boolean(auditPurgeDatabaseUrl);
const bootstrapToken = await ensureBootstrapToken(db);
const app = createApp(db, sql, sessionStore);
const mcpHandler = createMcpHandler({ db, sql, sessionStore });
const honoRequestListener = getRequestListener(app.fetch);

const port = parseInt(process.env.API_PORT || "3001", 10);

console.log(`Starting Monet API on port ${port}`);
if (bootstrapToken) {
  console.log(
    `Platform bootstrap token (expires ${bootstrapToken.expiresAt.toISOString()}): ${bootstrapToken.rawToken}`,
  );
}

let activeHttpRequests = 0;

const server = createServer((req, res) => {
  activeHttpRequests += 1;
  let tracked = true;
  const releaseRequest = () => {
    if (!tracked) return;
    tracked = false;
    activeHttpRequests = Math.max(0, activeHttpRequests - 1);
  };
  res.once("finish", releaseRequest);
  res.once("close", releaseRequest);

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
startAuditRetentionJob(auditPurgeSql);
void recoverPendingEnrichments(sql);
sessionStore.startIdleSweep(async (sessionId, session) => {
  console.info(`Closing idle MCP session ${sessionId}`);
  await Promise.allSettled([
    session.transport.close(),
    session.server.close(),
  ]);
  sessionStore.remove(sessionId);
});

function waitForInFlightRequests(timeoutMs: number): Promise<void> {
  if (activeHttpRequests === 0) return Promise.resolve();

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const interval = setInterval(() => {
      if (activeHttpRequests === 0 || Date.now() >= deadline) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}

function closeServerWithTimeout(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(done, timeoutMs);
    server.close(done);
  });
}

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down`);
  let exitCode = 0;

  // 1) Stop accepting new connections.
  const serverClosePromise = closeServerWithTimeout(10_000);

  // 2) Stop background jobs.
  stopTtlExpiryJob();
  stopAuditRetentionJob();
  sessionStore.stopIdleSweep();

  try {
    // 3) Close active MCP sessions.
    for (const [sessionId, session] of sessionStore.getAll()) {
      sessionStore.remove(sessionId);
      await Promise.allSettled([
        session.transport.close(),
        session.server.close(),
      ]);
    }

    // 4) Wait for in-flight HTTP requests (up to 10s).
    await waitForInFlightRequests(10_000);

    // 5) Drain enrichment queue (up to 30s).
    await waitForEnrichmentDrain(30_000);
    console.log(
      `Enrichment drain complete (active=${getActiveEnrichmentCount()}, queued=${getQueuedEnrichmentCount()})`,
    );

    await serverClosePromise;
  } catch (error) {
    exitCode = 1;
    console.error("Error during shutdown", error);
  } finally {
    // 6) Close database connections.
    await Promise.allSettled([
      sql.end({ timeout: 5 }),
      hasDedicatedAuditPurgeClient
        ? auditPurgeSql.end({ timeout: 5 })
        : Promise.resolve(undefined),
    ]);
    process.exit(exitCode);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
