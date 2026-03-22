import { Hono } from "hono";
import type { AppEnv } from "../middleware/context";
import { getEnrichmentProviderConfigStatus } from "../providers/index";
import { getAuditHealth } from "../services/audit.service";
import { StartupValidationError, verifyPlatformMigrations } from "../startup-validation";

export const health = new Hono<AppEnv>();

health.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.0.1",
  });
});

health.get("/health/live", (c) => {
  return c.json({ status: "ok" });
});

health.get("/healthz", (c) => {
  return c.json({ status: "ok" });
});

health.get("/health/ready", async (c) => {
  const sql = c.get("sql") as AppEnv["Variables"]["sql"] | undefined;
  const sessionStore = c.get("sessionStore") as AppEnv["Variables"]["sessionStore"] | undefined;

  let db: "connected" | "disconnected" = "disconnected";
  let dbReason: string | null = sql ? null : "SQL client unavailable.";
  try {
    if (sql) {
      await sql`SELECT 1`;
      db = "connected";
      dbReason = null;
    }
  } catch (error) {
    db = "disconnected";
    dbReason = error instanceof Error ? error.message : String(error);
  }

  let migrations: {
    status: "current" | "not_current" | "unknown";
    latestExpectedTag: string | null;
    latestAppliedTag: string | null;
    reason?: string;
  } = {
    status: db === "connected" ? "unknown" : "unknown",
    latestExpectedTag: null,
    latestAppliedTag: null,
    ...(db === "connected" ? {} : { reason: "Database is not connected." }),
  };

  if (db === "connected" && sql) {
    try {
      const migrationStatus = await verifyPlatformMigrations(sql);
      migrations = {
        status: migrationStatus.status,
        latestExpectedTag: migrationStatus.latestExpectedTag,
        latestAppliedTag: migrationStatus.latestAppliedTag,
      };
    } catch (error) {
      const reason =
        error instanceof StartupValidationError
          ? error.errors.join(" ")
          : error instanceof Error
            ? error.message
            : String(error);

      migrations = {
        status: "not_current",
        latestExpectedTag: null,
        latestAppliedTag: null,
        reason,
      };
    }
  }

  const enrichmentConfig = getEnrichmentProviderConfigStatus();
  const enrichment = {
    status: enrichmentConfig.configured ? "configured" : "degraded",
    provider: enrichmentConfig.provider,
    ...(enrichmentConfig.reason ? { reason: enrichmentConfig.reason } : {}),
  };

  const audit = getAuditHealth();
  const mcp = {
    status: sessionStore ? "ready" : "not_ready",
    activeSessions: sessionStore?.count() ?? 0,
    ...(sessionStore ? {} : { reason: "Session store unavailable." }),
  };
  const status = db === "connected" && migrations.status === "current" && mcp.status === "ready"
    ? "ok"
    : "not_ready";

  return c.json(
    {
      status,
      timestamp: new Date().toISOString(),
      components: {
        database: {
          status: db,
          ...(dbReason ? { reason: dbReason } : {}),
        },
        migrations,
        mcp,
        enrichment,
        audit,
      },
    },
    status === "ok" ? 200 : 503,
  );
});
