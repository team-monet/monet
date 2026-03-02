import { Hono } from "hono";
import { withTenantScope } from "@monet/db";
import { CreateMemoryEntryInput, UpdateMemoryEntryInput, MemoryScope } from "@monet/types";
import type { AppEnv } from "../middleware/context.js";
import {
  createMemory,
  searchMemories,
  fetchMemory,
  updateMemory,
  deleteMemory,
  markOutdated,
  promoteScope,
  listTags,
} from "../services/memory.service.js";

export const memoriesRouter = new Hono<AppEnv>();

// POST / — create a memory
memoriesRouter.post("/", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");

  const body = await c.req.json();
  const parsed = CreateMemoryEntryInput.safeParse(body);
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

  const result = await withTenantScope(sql, schemaName, (txSql) =>
    createMemory(txSql, agent, parsed.data, sql),
  );

  if ("error" in result && result.error === "validation") {
    return c.json(
      { error: "validation_error", message: (result as { message: string }).message },
      400,
    );
  }

  if ("error" in result && result.error === "quota_exceeded") {
    return c.json(
      {
        error: "quota_exceeded",
        message: "Memory quota exceeded",
        limit: result.limit,
        current: result.current,
      },
      409,
    );
  }

  return c.json(result, 201);
});

// GET /tags — list distinct tags (must be before /:id)
memoriesRouter.get("/tags", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");

  const includeUser = c.req.query("includeUser") === "true";
  const includePrivate = c.req.query("includePrivate") === "true";

  const tags = await withTenantScope(sql, schemaName, (txSql) =>
    listTags(txSql, agent, { includeUser, includePrivate }),
  );

  return c.json({ tags });
});

// GET / — search memories
memoriesRouter.get("/", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");

  const query = {
    query: c.req.query("query"),
    tags: c.req.query("tags") ? c.req.query("tags")!.split(",") : undefined,
    memoryType: c.req.query("memoryType"),
    includeUser: c.req.query("includeUser") === "true",
    includePrivate: c.req.query("includePrivate") === "true",
    fromDate: c.req.query("fromDate"),
    toDate: c.req.query("toDate"),
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  };

  const result = await withTenantScope(sql, schemaName, (txSql) =>
    searchMemories(txSql, agent, query),
  );

  return c.json(result);
});

// GET /:id — fetch a single memory
memoriesRouter.get("/:id", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const id = c.req.param("id");

  const result = await withTenantScope(sql, schemaName, (txSql) =>
    fetchMemory(txSql, agent, id),
  );

  if ("error" in result) {
    if (result.error === "not_found") {
      return c.json({ error: "not_found", message: "Memory not found" }, 404);
    }
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  return c.json(result);
});

// PATCH /:id — update a memory
memoriesRouter.patch("/:id", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const id = c.req.param("id");

  const body = await c.req.json();
  const parsed = UpdateMemoryEntryInput.safeParse(body);
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

  const result = await withTenantScope(sql, schemaName, (txSql) =>
    updateMemory(txSql, agent, id, parsed.data),
  );

  if ("error" in result) {
    if (result.error === "not_found") {
      return c.json({ error: "not_found", message: "Memory not found" }, 404);
    }
    if (result.error === "forbidden") {
      return c.json({ error: "forbidden", message: "Access denied" }, 403);
    }
    if (result.error === "conflict") {
      return c.json(
        {
          error: "conflict",
          message: "Version conflict",
          currentVersion: result.currentVersion,
        },
        409,
      );
    }
  }

  return c.json((result as { entry: unknown }).entry);
});

// DELETE /:id — delete a memory
memoriesRouter.delete("/:id", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const id = c.req.param("id");

  const result = await withTenantScope(sql, schemaName, (txSql) =>
    deleteMemory(txSql, agent, id),
  );

  if ("error" in result) {
    if (result.error === "not_found") {
      return c.json({ error: "not_found", message: "Memory not found" }, 404);
    }
    return c.json({ error: "forbidden", message: "Only the author can delete this memory" }, 403);
  }

  return c.json({ success: true });
});

// PATCH /:id/scope — promote scope (private→user→group; demotion requires authorship)
memoriesRouter.patch("/:id/scope", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const id = c.req.param("id");

  const body = await c.req.json();
  const parsed = MemoryScope.safeParse(body.scope);
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", message: "Invalid scope. Must be one of: group, user, private" },
      400,
    );
  }

  const result = await withTenantScope(sql, schemaName, (txSql) =>
    promoteScope(txSql, agent, id, parsed.data),
  );

  if ("error" in result) {
    if (result.error === "not_found") {
      return c.json({ error: "not_found", message: "Memory not found" }, 404);
    }
    if (result.error === "forbidden") {
      return c.json({ error: "forbidden", message: "Access denied" }, 403);
    }
    if (result.error === "no_change") {
      return c.json({ error: "no_change", message: "Scope is already set to this value" }, 400);
    }
  }

  return c.json(result);
});

// PATCH /:id/outdated — mark a memory as outdated
memoriesRouter.patch("/:id/outdated", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const id = c.req.param("id");

  const result = await withTenantScope(sql, schemaName, (txSql) =>
    markOutdated(txSql, agent, id),
  );

  if ("error" in result) {
    if (result.error === "not_found") {
      return c.json({ error: "not_found", message: "Memory not found" }, 404);
    }
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  return c.json({ success: true });
});
