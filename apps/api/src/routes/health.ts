import { Hono } from "hono";

export const health = new Hono();

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

health.get("/health/ready", (c) => {
  // TODO: Check database connectivity
  return c.json({ status: "ok" });
});
