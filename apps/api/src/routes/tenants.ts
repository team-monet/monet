import { Hono } from "hono";
import { CreateTenantInput } from "@monet/types";
import { provisionTenant } from "../services/tenant.service.js";
import type { AppEnv } from "../middleware/context.js";

export const tenantsRouter = new Hono<AppEnv>();

/**
 * POST /api/tenants — provision a new tenant.
 * Guarded by PLATFORM_ADMIN_SECRET (shared secret, not API key auth).
 */
tenantsRouter.post("/", async (c) => {
  const adminSecret = process.env.PLATFORM_ADMIN_SECRET;
  if (!adminSecret) {
    return c.json(
      { error: "config_error", message: "PLATFORM_ADMIN_SECRET not configured" },
      500,
    );
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return c.json(
      { error: "unauthorized", message: "Missing Authorization header" },
      401,
    );
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || parts[1] !== adminSecret) {
    return c.json(
      { error: "forbidden", message: "Invalid admin secret" },
      403,
    );
  }

  const body = await c.req.json();
  const parsed = CreateTenantInput.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "validation_error",
        message: "Invalid input",
        details: parsed.error.flatten().fieldErrors,
      },
      400,
    );
  }

  const db = c.get("db");
  const sql = c.get("sql");

  try {
    const result = await provisionTenant(db, sql, parsed.data);
    return c.json(
      {
        tenant: result.tenant,
        agent: result.agent,
        apiKey: result.rawApiKey,
      },
      201,
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("unique constraint")
    ) {
      return c.json(
        { error: "conflict", message: "Tenant name already exists" },
        409,
      );
    }
    throw err;
  }
});
