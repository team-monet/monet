import { Hono } from "hono";
import type { AppEnv } from "../middleware/context";
import {
  getTenantSettings,
  updateTenantSettings,
} from "../services/tenant-settings.service";

export const tenantSettingsRouter = new Hono<AppEnv>();

function parseUpdateTenantSettingsInput(body: unknown): { data: { tenantAgentInstructions: string } } | { error: string } {
  const b = body as Record<string, unknown>;

  if (!b || typeof b.tenantAgentInstructions !== "string") {
    return { error: "tenantAgentInstructions must be a string" };
  }

  return {
    data: {
      tenantAgentInstructions: b.tenantAgentInstructions,
    },
  };
}

tenantSettingsRouter.get("/settings", async (c) => {
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const settings = await getTenantSettings(sql, schemaName);
  return c.json(settings);
});

tenantSettingsRouter.patch("/settings", async (c) => {
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");

  const body = await c.req.json();
  const parsed = parseUpdateTenantSettingsInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const settings = await updateTenantSettings(sql, schemaName, parsed.data.tenantAgentInstructions);
  return c.json(settings);
});
