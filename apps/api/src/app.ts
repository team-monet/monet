import { Hono } from "hono";
import type { Database } from "@monet/db";
import type postgres from "postgres";
import { health } from "./routes/health.js";
import { tenantsRouter } from "./routes/tenants.js";
import { agentsRouter } from "./routes/agents.js";
import { memoriesRouter } from "./routes/memories.js";
import { groupsRouter } from "./routes/groups.js";
import { rulesRouter } from "./routes/rules.js";
import { auditRouter } from "./routes/audit.js";
import { authMiddleware } from "./middleware/auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { structuredLogger } from "./middleware/structured-logger.js";
import type { AppEnv } from "./middleware/context.js";
import type { SessionStore } from "./mcp/session-store.js";

export function createApp(
  db: Database | null,
  sql: postgres.Sql | null,
  sessionStore: SessionStore | null = null,
) {
  const app = new Hono<AppEnv>();

  // Structured logging middleware with per-request correlation IDs.
  app.use("*", structuredLogger);

  // Inject db and sql into context for all routes
  app.use("*", async (c, next) => {
    if (db) c.set("db", db);
    if (sql) c.set("sql", sql);
    if (sessionStore) c.set("sessionStore", sessionStore);
    await next();
  });

  // Health routes — unauthenticated
  app.route("/", health);

  // Tenant provisioning — uses its own admin secret auth, not API key auth
  app.route("/api/tenants", tenantsRouter);

  // Authenticated API sub-app with middleware chain: auth → tenant → rate-limit
  const authenticated = new Hono<AppEnv>();
  authenticated.use("*", authMiddleware);
  authenticated.use("*", tenantMiddleware);
  authenticated.use("*", rateLimitMiddleware);
  authenticated.route("/agents", agentsRouter);
  authenticated.route("/memories", memoriesRouter);
  authenticated.route("/groups", groupsRouter);
  authenticated.route("/audit", auditRouter);
  authenticated.route("/", rulesRouter);

  app.route("/api", authenticated);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
