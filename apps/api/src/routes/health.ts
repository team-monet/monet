import { Hono } from "hono";
import type { AppEnv } from "../middleware/context.js";

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
  const sql = c.get("sql");

  if (!sql) {
    return c.json({ status: "error", message: "database not configured" }, 503);
  }

  try {
    await sql`SELECT 1`;
    return c.json({ status: "ok" });
  } catch {
    return c.json({ status: "error", message: "database unreachable" }, 503);
  }
});
