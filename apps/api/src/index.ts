import { createServer } from "node:http";
import { writeFileSync, chmodSync } from "node:fs";
import { getRequestListener } from "@hono/node-server";
import { createClient, createSqlClient } from "@monet/db";
import { createApp } from "./app";
import { createMcpHandler } from "./mcp/handler";
import { sessionStore } from "./mcp/session-store";
import { ensureBootstrapToken } from "./services/bootstrap.service";
import { ensureTenantSchemasCurrent } from "./services/tenant.service";
import {
  getActiveEnrichmentCount,
  getQueuedEnrichmentCount,
  markShuttingDown,
  recoverPendingEnrichments,
  waitForEnrichmentDrain,
} from "./services/enrichment.service";
import {
  startTtlExpiryJob,
  stopTtlExpiryJob,
} from "./services/ttl-expiry.service";
import {
  startAuditRetentionJob,
  stopAuditRetentionJob,
} from "./services/audit-retention.service";
import {
  formatStartupFailure,
  formatStartupSummary,
  probeStartupDependencies,
  validateStartupConfig,
} from "./startup-validation";

async function main() {
  const startupConfig = validateStartupConfig(process.env);
  const { db, sql } = createClient(startupConfig.databaseUrl);
  const auditPurgeSql = startupConfig.auditPurgeDatabaseUrl
    ? createSqlClient(startupConfig.auditPurgeDatabaseUrl)
    : sql;
  const hasDedicatedAuditPurgeClient = Boolean(startupConfig.auditPurgeDatabaseUrl);

  try {
    const dependencyStatus = await probeStartupDependencies(sql, {
      auditPurgeSql: hasDedicatedAuditPurgeClient ? auditPurgeSql : null,
    });
    const upgradedTenantSchemaCount = await ensureTenantSchemasCurrent(sql);
    const bootstrapToken = await ensureBootstrapToken(db);
    const app = createApp(db, sql, sessionStore);
    const mcpHandler = createMcpHandler({ db, sql, sessionStore });
    const honoRequestListener = getRequestListener(app.fetch);

    for (const warning of startupConfig.warnings) {
      console.warn(`[startup] Warning: ${warning}`);
    }

    console.log("Validated startup config:");
    console.log(formatStartupSummary(startupConfig.summary, dependencyStatus));
    console.log(`Starting Monet API on port ${startupConfig.apiPort}`);
    console.log(`Ensured tenant schemas are current for ${upgradedTenantSchemaCount} tenant(s)`);

    if (bootstrapToken) {
      const tokenPath = "/tmp/monet-bootstrap-token";
      writeFileSync(tokenPath, bootstrapToken.rawToken);
      chmodSync(tokenPath, 0o600);
      console.log(
        `Bootstrap token written to ${tokenPath} (expires ${bootstrapToken.expiresAt.toISOString()})`,
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

    server.listen(startupConfig.apiPort, startupConfig.apiHost);

    const loggedHost = startupConfig.apiHost.includes(":")
      ? `[${startupConfig.apiHost}]`
      : startupConfig.apiHost;
    console.log(`API server running at http://${loggedHost}:${startupConfig.apiPort}`);

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
      markShuttingDown();

      console.log(`Received ${signal}, shutting down`);
      let exitCode = 0;

      // 1) Stop accepting new connections.
      const serverClosePromise = closeServerWithTimeout(10_000);

      // 2) Stop background jobs.
      await Promise.allSettled([
        stopTtlExpiryJob(),
        stopAuditRetentionJob(),
      ]);
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
  } catch (error) {
    await Promise.allSettled([
      sql.end({ timeout: 5 }),
      hasDedicatedAuditPurgeClient
        ? auditPurgeSql.end({ timeout: 5 })
        : Promise.resolve(undefined),
    ]);
    throw error;
  }
}

void main().catch((error) => {
  console.error(formatStartupFailure(error));
  process.exit(1);
});
