import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";
import { logRequest } from "../lib/log";

export const structuredLogger = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = randomUUID();
  const start = performance.now();

  c.set("requestId", requestId);

  try {
    await next();
  } finally {
    c.header("X-Request-Id", requestId);

    const agent = c.get("agent") as AppEnv["Variables"]["agent"] | undefined;
    const tenantId = (c.get("tenantId") as string | undefined) ?? agent?.tenantId;

    logRequest({
      requestId,
      method: c.req.method,
      path: c.req.path,
      statusCode: c.res.status,
      latencyMs: performance.now() - start,
      tenantId,
      agentId: agent?.id,
      message: "http_request",
    });
  }
});
