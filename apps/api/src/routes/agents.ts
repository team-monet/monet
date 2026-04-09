import { Hono, type Context } from "hono";
import { RegisterAgentApiInput } from "@monet/types";
import { addMember, resolveAgentRole, isTenantAdmin } from "../services/group.service";
import {
  associateRuleSetWithAgent,
  dissociateRuleSetFromAgent,
  getActiveRulesForAgent,
  listRuleSetsForAgent,
} from "../services/rule.service";
import { pushRulesToAgent } from "../services/rule-notification.service";
import type { AppEnv } from "../middleware/context";
import { provisionAgentWithApiKey } from "../services/agent-provisioning.service";
import { userCanSelectAgentGroup } from "../services/user-group.service";
import { generateApiKey, hashApiKey } from "../services/api-key.service";
import type { AuditEntry } from "../services/audit.service";
import { logAuditEvent } from "../services/audit.service";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import {
  deletePlatformAgent,
  listPlatformAgentGroups,
  listPlatformAgents,
  loadPlatformAgentRecord,
  loadPlatformUserOwner,
  revokePlatformAgent,
  rotatePlatformAgentToken,
  type PlatformAgentRecord,
  unrevokePlatformAgent,
} from "../services/platform-agent.service";

export const agentsRouter = new Hono<AppEnv>();

function ownerLabel(row: PlatformAgentRecord) {
  return row.ownerDisplayName ?? row.ownerEmail ?? row.ownerExternalId ?? null;
}

function displayName(row: PlatformAgentRecord) {
  if (row.isAutonomous) {
    return `${row.externalId} (Autonomous)`;
  }

  const label = ownerLabel(row);
  return label ? `${row.externalId} · ${label}` : row.externalId;
}

function mapAgent(row: PlatformAgentRecord) {
  const label = ownerLabel(row);

  return {
    id: row.id,
    externalId: row.externalId,
    tenantId: row.tenantId,
    userId: row.userId,
    isAutonomous: row.isAutonomous,
    role: row.role,
    revokedAt: row.revokedAt,
    displayName: displayName(row),
    owner:
      row.ownerId && label
        ? {
            id: row.ownerId,
            externalId: row.ownerExternalId ?? label,
            displayName: row.ownerDisplayName,
            email: row.ownerEmail,
            label,
          }
        : null,
    createdAt: row.createdAt,
  };
}

async function loadAccessibleAgentRow(
  c: Context<AppEnv>,
  agentId: string,
): Promise<{ row: PlatformAgentRecord; isAdmin: boolean } | { response: Response }> {
  const requester = c.get("agent");
  const sql = c.get("sql");
  const role = await resolveAgentRole(sql, requester);
  const admin = isTenantAdmin(role);

  if (!admin && !requester.userId) {
    return {
      response: c.json({ error: "forbidden", message: "User-bound agent access required" }, 403),
    };
  }

  const row = await loadPlatformAgentRecord(sql, requester.tenantId, agentId);

  if (!row) {
    return {
      response: c.json({ error: "not_found", message: "Agent not found" }, 404),
    };
  }

  if (!admin && (!requester.userId || row.userId !== requester.userId)) {
    return {
      response: c.json({ error: "not_found", message: "Agent not found" }, 404),
    };
  }

  return { row, isAdmin: admin };
}

async function requireTenantAdmin(c: Context<AppEnv>) {
  const agent = c.get("agent");
  const sql = c.get("sql");

  const role = await resolveAgentRole(sql, agent);
  if (!isTenantAdmin(role)) {
    return c.json({ error: "forbidden", message: "Tenant admin role required" }, 403);
  }

  return null;
}

async function closeAgentSessionsIfPresent(
  sessionStore: AppEnv["Variables"]["sessionStore"] | undefined,
  agentId: string,
) {
  if (!sessionStore) return 0;
  return sessionStore.closeSessionsForAgent(agentId);
}

function auditActor(requester: AppEnv["Variables"]["agent"]): Pick<AuditEntry, "actorId" | "actorType"> {
  if (requester.userId) {
    return { actorId: requester.userId, actorType: "user" };
  }

  return { actorId: requester.id, actorType: "agent" };
}

function parseAgentRuleSetAssociationInput(
  body: unknown,
): { data: { ruleSetId: string } } | { error: string } {
  const b = body as Record<string, unknown>;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!b || typeof b.ruleSetId !== "string" || !UUID_RE.test(b.ruleSetId)) {
    return { error: "Valid ruleSetId (UUID) is required" };
  }
  return { data: { ruleSetId: b.ruleSetId } };
}

/**
 * POST /api/agents/register — register a new agent in the current tenant.
 */
agentsRouter.post("/register", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const role = await resolveAgentRole(sql, agent);
  const admin = isTenantAdmin(role);

  const body = await c.req.json();
  const parsed = RegisterAgentApiInput.safeParse(body);
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

  if (!admin && !agent.userId) {
    return c.json({ error: "forbidden", message: "Tenant admin role required" }, 403);
  }

  if (!admin && parsed.data.isAutonomous) {
    return c.json(
      { error: "forbidden", message: "Only tenant admins can register autonomous agents" },
      403,
    );
  }

  if (!admin && parsed.data.userId && parsed.data.userId !== agent.userId) {
    return c.json(
      { error: "forbidden", message: "Normal users can only register agents bound to themselves" },
      403,
    );
  }

  if (parsed.data.isAutonomous && parsed.data.userId) {
    return c.json(
      { error: "validation_error", message: "Autonomous agents cannot have a user binding" },
      400,
    );
  }

  if (!parsed.data.groupId) {
    return c.json(
      { error: "validation_error", message: "Agent group selection is required" },
      400,
    );
  }

  const userId = admin ? (parsed.data.isAutonomous ? null : (parsed.data.userId ?? null)) : agent.userId;
  const isAutonomous = admin ? parsed.data.isAutonomous : false;

  if (!admin && !isAutonomous && !userId) {
    return c.json(
      { error: "validation_error", message: "User binding is required for User Proxy agents" },
      400,
    );
  }

  if (!admin && userId && parsed.data.groupId) {
    const canSelectGroup = await userCanSelectAgentGroup(
      sql,
      agent.tenantId,
      userId,
      parsed.data.groupId,
    );

    if (!canSelectGroup) {
      return c.json(
        { error: "forbidden", message: "You do not have access to register agents in that group" },
        403,
      );
    }
  }

  let owner: {
    id: string;
    externalId: string;
    displayName: string | null;
    email: string | null;
    label: string;
  } | null = null;
  if (userId) {
    const user = await loadPlatformUserOwner(sql, agent.tenantId, userId);
    if (!user) {
      return c.json({ error: "not_found", message: "User not found" }, 404);
    }

    const label =
      user.displayName ??
      user.email ??
      user.externalId;
    owner = {
      id: user.id,
      externalId: user.externalId,
      displayName: user.displayName ?? null,
      email: user.email ?? null,
      label,
    };
  }

  const provisionedAgent = await provisionAgentWithApiKey(sql, {
    externalId: parsed.data.externalId,
    tenantId: agent.tenantId,
    userId,
    isAutonomous,
  });
  const { agent: newAgent, rawApiKey } = provisionedAgent;

  const membershipResult = await addMember(
    sql,
    agent.tenantId,
    parsed.data.groupId,
    newAgent.id,
  );

  if ("error" in membershipResult) {
    await deletePlatformAgent(sql, agent.tenantId, newAgent.id);
    if (membershipResult.error === "not_found") {
      return c.json({ error: "not_found", message: membershipResult.message }, 404);
    }
    return c.json({ error: "conflict", message: membershipResult.message }, 409);
  }

  return c.json(
    {
      agent: {
        id: newAgent.id,
        externalId: newAgent.externalId,
        tenantId: agent.tenantId,
        userId: newAgent.userId,
        isAutonomous: newAgent.isAutonomous,
        role: newAgent.role,
        revokedAt: null,
        displayName: newAgent.isAutonomous
          ? `${newAgent.externalId} (Autonomous)`
          : owner
            ? `${newAgent.externalId} · ${owner.label}`
            : newAgent.externalId,
        owner,
        createdAt: newAgent.createdAt,
      },
      apiKey: rawApiKey,
    },
    201,
  );
});

/**
 * POST /api/agents/:id/regenerate-token — rotate an agent API key and return the raw key once.
 */
agentsRouter.post("/:id/regenerate-token", rateLimitMiddleware, async (c) => {
  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const schemaName = c.get("tenantSchemaName");
  const requester = c.get("agent");
  const targetId = c.req.param("id");
  const access = await loadAccessibleAgentRow(c, targetId);

  if ("response" in access) {
    return access.response;
  }

  const rawApiKey = generateApiKey(access.row.id);
  const { hash, salt } = hashApiKey(rawApiKey);

  await rotatePlatformAgentToken(sql, requester.tenantId, targetId, hash, salt);

  await closeAgentSessionsIfPresent(sessionStore, targetId);
  await logAuditEvent(sql, schemaName, {
    tenantId: requester.tenantId,
    ...auditActor(requester),
    action: "agent.token_regenerate",
    targetId,
    outcome: "success",
  });

  return c.json({ apiKey: rawApiKey });
});

/**
 * POST /api/agents/:id/revoke — revoke an agent token and terminate active MCP sessions.
 */
agentsRouter.post("/:id/revoke", rateLimitMiddleware, async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const schemaName = c.get("tenantSchemaName");
  const requester = c.get("agent");
  const targetId = c.req.param("id");
  const row = await loadPlatformAgentRecord(sql, requester.tenantId, targetId);

  if (!row) {
    return c.json({ error: "not_found", message: "Agent not found" }, 404);
  }

  const revokedAt = await revokePlatformAgent(sql, requester.tenantId, targetId);

  await closeAgentSessionsIfPresent(sessionStore, targetId);
  await logAuditEvent(sql, schemaName, {
    tenantId: requester.tenantId,
    ...auditActor(requester),
    action: "agent.revoke",
    targetId,
    outcome: "success",
  });

  return c.json({
    success: true,
    revokedAt: revokedAt ?? row.revokedAt,
  });
});

/**
 * POST /api/agents/:id/unrevoke — restore a revoked agent token.
 */
agentsRouter.post("/:id/unrevoke", rateLimitMiddleware, async (c) => {
  const forbidden = await requireTenantAdmin(c);
  if (forbidden) return forbidden;

  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const requester = c.get("agent");
  const targetId = c.req.param("id");
  const row = await loadPlatformAgentRecord(sql, requester.tenantId, targetId);

  if (!row) {
    return c.json({ error: "not_found", message: "Agent not found" }, 404);
  }

  await unrevokePlatformAgent(sql, requester.tenantId, targetId);
  await logAuditEvent(sql, schemaName, {
    tenantId: requester.tenantId,
    ...auditActor(requester),
    action: "agent.unrevoke",
    targetId,
    outcome: "success",
  });

  return c.json({ success: true, revokedAt: null });
});

/**
 * POST /api/agents/:id/rule-sets — associate a rule set with an agent.
 */
agentsRouter.post("/:id/rule-sets", async (c) => {
  const body = await c.req.json();
  const parsed = parseAgentRuleSetAssociationInput(body);
  if ("error" in parsed) {
    return c.json({ error: "validation_error", message: parsed.error }, 400);
  }

  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const requester = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const targetAgentId = c.req.param("id");
  const access = await loadAccessibleAgentRow(c, targetAgentId);

  if ("response" in access) {
    return access.response;
  }

  const result = await associateRuleSetWithAgent(sql, tenantId, schemaName, {
    ...auditActor(requester),
  }, targetAgentId, parsed.data.ruleSetId);

  if ("error" in result) {
    if (result.error === "not_found") {
      return c.json({ error: "not_found", message: "Rule set not found" }, 404);
    }
    if (result.error === "forbidden") {
      return c.json({ error: "forbidden", message: "This rule set cannot be attached to that agent" }, 403);
    }
    return c.json({ error: "conflict", message: "Rule set is already associated with this agent" }, 409);
  }

  await pushRulesToAgent(targetAgentId, sessionStore, sql, schemaName);
  return c.json({ success: true }, 201);
});

/**
 * DELETE /api/agents/:id/rule-sets/:ruleSetId — dissociate a rule set from an agent.
 */
agentsRouter.delete("/:id/rule-sets/:ruleSetId", async (c) => {
  const sql = c.get("sql");
  const sessionStore = c.get("sessionStore");
  const requester = c.get("agent");
  const tenantId = c.get("tenantId");
  const schemaName = c.get("tenantSchemaName");
  const targetAgentId = c.req.param("id");
  const ruleSetId = c.req.param("ruleSetId");
  const access = await loadAccessibleAgentRow(c, targetAgentId);

  if ("response" in access) {
    return access.response;
  }

  const result = await dissociateRuleSetFromAgent(sql, tenantId, schemaName, {
    ...auditActor(requester),
  }, targetAgentId, ruleSetId);

  if ("error" in result) {
    return c.json({ error: "not_found", message: "Agent/rule-set association not found" }, 404);
  }

  await pushRulesToAgent(targetAgentId, sessionStore, sql, schemaName);
  return c.json({ success: true });
});

/**
 * GET /api/agents/:id/rules — get all active rules for an agent.
 */
agentsRouter.get("/:id/rules", async (c) => {
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const targetAgentId = c.req.param("id");
  const access = await loadAccessibleAgentRow(c, targetAgentId);

  if ("response" in access) {
    return access.response;
  }

  const rules = await getActiveRulesForAgent(sql, schemaName, targetAgentId);
  return c.json({ rules });
});

/**
 * GET /api/agents — list all agents in the current tenant.
 */
agentsRouter.get("/", async (c) => {
  const agent = c.get("agent");
  const sql = c.get("sql");
  const role = await resolveAgentRole(sql, agent);
  const admin = isTenantAdmin(role);

  let rows;
  if (admin) {
    rows = await listPlatformAgents(sql, agent.tenantId, {
      isAdmin: true,
    });
  } else {
    if (!agent.userId) {
      return c.json([]);
    }

    rows = await listPlatformAgents(sql, agent.tenantId, {
      isAdmin: false,
      requesterUserId: agent.userId,
    });
  }

  return c.json(rows.map(mapAgent));
});

/**
 * GET /api/agents/me — return the current authenticated agent's info.
 */
agentsRouter.get("/me", async (c) => {
  const agent = c.get("agent");

  return c.json({
    id: agent.id,
    externalId: agent.externalId,
    tenantId: agent.tenantId,
    isAutonomous: agent.isAutonomous,
  });
});

/**
 * GET /api/agents/:id/status — get an agent's connection status.
 */
agentsRouter.get("/:id/status", async (c) => {
  const sessionStore = c.get("sessionStore");
  const targetId = c.req.param("id");
  const access = await loadAccessibleAgentRow(c, targetId);

  if ("response" in access) {
    return access.response;
  }

  const activeSessions = sessionStore ? sessionStore.getByAgentId(targetId).length : 0;

  return c.json({
    activeSessions,
    revoked: Boolean(access.row.revokedAt),
  });
});

/**
 * GET /api/agents/:id — get an agent detail record.
 */
agentsRouter.get("/:id", async (c) => {
  const sql = c.get("sql");
  const schemaName = c.get("tenantSchemaName");
  const requester = c.get("agent");
  const targetId = c.req.param("id");
  const access = await loadAccessibleAgentRow(c, targetId);

  if ("response" in access) {
    return access.response;
  }

  const [groups, ruleSets] = await Promise.all([
    listPlatformAgentGroups(sql, requester.tenantId, targetId),
    listRuleSetsForAgent(sql, schemaName, targetId),
  ]);

  return c.json({
    ...mapAgent(access.row),
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description ?? "",
      memoryQuota: group.memoryQuota ?? null,
      createdAt: group.createdAt,
    })),
    ruleSets,
  });
});
