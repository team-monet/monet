import { Hono } from "hono";
import { logger } from "hono/logger";
import type { Database } from "@monet/db";
import type postgres from "postgres";
import { health } from "./routes/health.js";
import { tenantsRouter } from "./routes/tenants.js";
import { agentsRouter } from "./routes/agents.js";
import { memoriesRouter } from "./routes/memories.js";
import { groupsRouter } from "./routes/groups.js";
import { authMiddleware } from "./middleware/auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import type { AppEnv } from "./middleware/context.js";

export function createApp(db: Database | null, sql: postgres.Sql | null) {
  const app = new Hono<AppEnv>();

  // Logging middleware — Authorization header redacted (threat model I4)
  app.use(
    "*",
    logger((message) => {
      console.log(message.replace(/Bearer\s+\S+/g, "Bearer [REDACTED]"));
    }),
  );

  // Inject db and sql into context for all routes
  app.use("*", async (c, next) => {
    if (db) c.set("db", db);
    if (sql) c.set("sql", sql);
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

  app.route("/api", authenticated);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
