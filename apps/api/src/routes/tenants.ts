import { Hono } from "hono";
import { CreateTenantInput } from "@monet/types";
import {
  provisionTenant,
  configureTenantOauth,
} from "../services/tenant.service.js";
import type { AppEnv } from "../middleware/context.js";

export const tenantsRouter = new Hono<AppEnv>();

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

function parseTenantOauthInput(body: unknown):
  | { data: { issuer: string; clientId: string; clientSecret: string } }
  | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Invalid request body" };
  }

  const b = body as Record<string, unknown>;
  if (
    typeof b.issuer !== "string" || b.issuer.trim().length === 0 ||
    typeof b.clientId !== "string" || b.clientId.trim().length === 0 ||
    typeof b.clientSecret !== "string" || b.clientSecret.trim().length === 0
  ) {
    return { error: "Missing required fields" };
  }

  return {
    data: {
      issuer: b.issuer,
      clientId: b.clientId,
      clientSecret: b.clientSecret,
    },
  };
}

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
    const result = await provisionTenant(db, sql!, parsed.data);
    return c.json(
      {
        tenant: result.tenant,
        agent: result.agent,
        apiKey: result.rawApiKey,
      },
      201,
    );
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return c.json(
        { error: "conflict", message: "Tenant name or slug already exists" },
        409,
      );
    }
    throw err;
  }
});

/**
 * POST /api/tenants/:id/oauth — configure OAuth for a tenant.
 * Guarded by PLATFORM_ADMIN_SECRET.
 */
tenantsRouter.post("/:id/oauth", async (c) => {
  const adminSecret = process.env.PLATFORM_ADMIN_SECRET;
  if (!adminSecret) {
    return c.json(
      { error: "config_error", message: "PLATFORM_ADMIN_SECRET not configured" },
      500,
    );
  }

  const authHeader = c.req.header("Authorization");
  if (authHeader !== `Bearer ${adminSecret}`) {
    return c.json({ error: "unauthorized", message: "Invalid admin secret" }, 401);
  }

  const tenantId = c.req.param("id");
  const body = await c.req.json();
  const parsed = parseTenantOauthInput(body);

  if ("error" in parsed) {
    return c.json(
      { error: "validation_error", message: parsed.error },
      400,
    );
  }

  const db = c.get("db");
  try {
    const config = await configureTenantOauth(db, tenantId, parsed.data);
    return c.json({ config }, 200);
  } catch (err: unknown) {
    return c.json(
      {
        error: "internal_error",
        message: err instanceof Error ? err.message : "Unknown error",
      },
      500,
    );
  }
});
