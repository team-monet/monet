import { Hono } from "hono";
import { logger } from "hono/logger";
import { health } from "./routes/health.js";

export const app = new Hono();

// Logging middleware — Authorization header redacted (threat model I4)
app.use(
  "*",
  logger((message) => {
    console.log(message.replace(/Bearer\s+\S+/g, "Bearer [REDACTED]"));
  })
);

// Routes
app.route("/", health);

// Placeholder for future routes
// app.route("/agents", agents);
// app.route("/memories", memories);
// app.route("/groups", groups);
// app.route("/rules", rules);

export type AppType = typeof app;
