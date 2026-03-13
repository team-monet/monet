import { Hono } from "hono";
import type { Database } from "@monet/db";
import type postgres from "postgres";
import { health } from "./routes/health";
import { bootstrapRouter } from "./routes/bootstrap";
import { agentsRouter } from "./routes/agents";
import { memoriesRouter } from "./routes/memories";
import { groupsRouter } from "./routes/groups";
import { userGroupsRouter } from "./routes/user-groups";
import { rulesRouter } from "./routes/rules";
import { auditRouter } from "./routes/audit";
import { authMiddleware } from "./middleware/auth";
import { tenantMiddleware } from "./middleware/tenant";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { structuredLogger } from "./middleware/structured-logger";
import type { AppEnv } from "./middleware/context";
import type { SessionStore } from "./mcp/session-store";

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
  app.route("/api/bootstrap", bootstrapRouter);

  // Authenticated API sub-app with middleware chain: auth → tenant → rate-limit
  const authenticated = new Hono<AppEnv>();
  authenticated.use("*", authMiddleware);
  authenticated.use("*", tenantMiddleware);
  authenticated.use("*", rateLimitMiddleware);
  authenticated.route("/agents", agentsRouter);
  authenticated.route("/memories", memoriesRouter);
  authenticated.route("/groups", groupsRouter);
  authenticated.route("/user-groups", userGroupsRouter);
  authenticated.route("/audit", auditRouter);
  authenticated.route("/", rulesRouter);

  app.route("/api", authenticated);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
