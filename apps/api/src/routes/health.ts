import { Hono } from "hono";
import type { AppEnv } from "../middleware/context";
import { getEnrichmentProviderConfigStatus } from "../providers/index";
import { getAuditHealth } from "../services/audit.service";

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

health.get("/health/ready", async (c) => {
  const sql = c.get("sql") as AppEnv["Variables"]["sql"] | undefined;
  let db: "connected" | "disconnected" = "disconnected";
  try {
    if (sql) {
      await sql`SELECT 1`;
      db = "connected";
    }
  } catch {
    db = "disconnected";
  }

  const enrichmentConfig = getEnrichmentProviderConfigStatus();
  const enrichment: "configured" | "not_configured" =
    enrichmentConfig.configured ? "configured" : "not_configured";

  const audit = getAuditHealth();

  if (db === "connected" && enrichment === "configured") {
    return c.json({
      status: "ok",
      db,
      enrichment,
      audit: audit.status,
    });
  }

  return c.json(
    {
      status: "not_ready",
      db,
      enrichment,
      audit: audit.status,
      reason: enrichmentConfig.reason,
    },
    503,
  );
});
