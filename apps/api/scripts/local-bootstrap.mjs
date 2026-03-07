#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function buildDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const user = process.env.POSTGRES_USER ?? "postgres";
  const password = process.env.POSTGRES_PASSWORD ?? "postgres";
  const host = process.env.POSTGRES_HOST ?? "127.0.0.1";
  const port = process.env.POSTGRES_PORT ?? "5432";
  const db = process.env.POSTGRES_DB ?? "monet";

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(db)}`;
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const raw = await response.text();
  let body = null;

  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  return { status: response.status, body };
}

function bodyToError(body) {
  if (!body) return "no response body";
  return typeof body === "string" ? body : JSON.stringify(body);
}

function looksLikeObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function timestampSuffix() {
  return Date.now().toString(36);
}

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "../../..");
  const apiBaseUrl =
    process.env.API_BASE_URL ??
    `http://127.0.0.1:${process.env.API_PORT ?? "3001"}`;
  const adminSecret = requiredEnv("PLATFORM_ADMIN_SECRET");
  const tenantName = process.env.LOCAL_TENANT_NAME ?? "Local Dev Org";
  const groupName = process.env.LOCAL_GROUP_NAME ?? "local-dev-default";
  const externalIdPrefix = process.env.LOCAL_AGENT_EXTERNAL_ID ?? "local-dev-agent";
  const dashboardExternalId = process.env.LOCAL_DASHBOARD_EXTERNAL_ID ?? "local-dashboard-admin";
  const writeSmokeMemory = process.env.LOCAL_BOOTSTRAP_CREATE_MEMORY !== "false";
  const configuredOutput = process.env.LOCAL_BOOTSTRAP_OUTPUT ?? ".local-dev/bootstrap.json";
  const outputPath = path.isAbsolute(configuredOutput)
    ? configuredOutput
    : path.resolve(repoRoot, configuredOutput);

  const sql = postgres(buildDatabaseUrl(), { max: 1 });
  let tenantCreated = false;
  let groupCreated = false;
  let groupProvisionSource = "db_lookup";

  try {
    let tenantId;
    let bootstrapAdminApiKey = null;

    const tenantCreateRes = await requestJson(`${apiBaseUrl}/api/tenants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: tenantName,
        isolationMode: "logical",
      }),
    });

    if (tenantCreateRes.status === 201) {
      if (
        !looksLikeObject(tenantCreateRes.body) ||
        !looksLikeObject(tenantCreateRes.body.tenant) ||
        typeof tenantCreateRes.body.tenant.id !== "string" ||
        typeof tenantCreateRes.body.apiKey !== "string"
      ) {
        throw new Error("Tenant creation returned unexpected payload");
      }

      tenantCreated = true;
      tenantId = tenantCreateRes.body.tenant.id;
      bootstrapAdminApiKey = tenantCreateRes.body.apiKey;
    } else if (tenantCreateRes.status === 409) {
      const existing = await sql`
        SELECT id
        FROM tenants
        WHERE name = ${tenantName}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (!existing[0]?.id) {
        throw new Error(`Tenant "${tenantName}" exists but could not be looked up`);
      }
      tenantId = existing[0].id;
    } else {
      throw new Error(
        `Failed to ensure tenant (${tenantCreateRes.status}): ${bodyToError(tenantCreateRes.body)}`,
      );
    }

    let groupId;
    const groupRows = await sql`
      SELECT id
      FROM agent_groups
      WHERE tenant_id = ${tenantId}
      AND name = ${groupName}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (groupRows[0]?.id) {
      groupId = groupRows[0].id;
    } else if (bootstrapAdminApiKey) {
      const createGroupRes = await requestJson(`${apiBaseUrl}/api/groups`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bootstrapAdminApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: groupName,
          description: "Default long-lived local development group",
          memoryQuota: 100000,
        }),
      });

      if (createGroupRes.status === 201 && looksLikeObject(createGroupRes.body) && typeof createGroupRes.body.id === "string") {
        groupCreated = true;
        groupProvisionSource = "api_admin_key";
        groupId = createGroupRes.body.id;
      } else {
        const inserted = await sql`
          INSERT INTO agent_groups (tenant_id, name, description, memory_quota)
          VALUES (${tenantId}, ${groupName}, ${"Default long-lived local development group"}, ${100000})
          RETURNING id
        `;
        groupCreated = true;
        groupProvisionSource = "db_insert";
        groupId = inserted[0]?.id;
      }
    } else {
      const inserted = await sql`
        INSERT INTO agent_groups (tenant_id, name, description, memory_quota)
        VALUES (${tenantId}, ${groupName}, ${"Default long-lived local development group"}, ${100000})
        RETURNING id
      `;
      groupCreated = true;
      groupProvisionSource = "db_insert";
      groupId = inserted[0]?.id;
    }

    if (!groupId) {
      throw new Error("Failed to determine local group id");
    }

    let dashboardUserId;
    const dashboardUsers = await sql`
      SELECT id
      FROM human_users
      WHERE tenant_id = ${tenantId}
      AND external_id = ${dashboardExternalId}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (dashboardUsers[0]?.id) {
      dashboardUserId = dashboardUsers[0].id;
    } else {
      const insertedDashboardUser = await sql`
        INSERT INTO human_users (external_id, tenant_id, role)
        VALUES (${dashboardExternalId}, ${tenantId}, ${"tenant_admin"})
        RETURNING id
      `;
      dashboardUserId = insertedDashboardUser[0]?.id;
    }

    const externalId = `${externalIdPrefix}-${timestampSuffix()}`;
    const registerHeaders = {
      authorization: `Bearer ${bootstrapAdminApiKey ?? adminSecret}`,
      "content-type": "application/json",
      ...(bootstrapAdminApiKey ? {} : { "x-tenant-id": tenantId }),
    };

    const registerRes = await requestJson(`${apiBaseUrl}/api/agents/register`, {
      method: "POST",
      headers: registerHeaders,
      body: JSON.stringify({
        externalId,
        isAutonomous: true,
        groupId,
      }),
    });

    if (
      registerRes.status !== 201 ||
      !looksLikeObject(registerRes.body) ||
      typeof registerRes.body.apiKey !== "string" ||
      !looksLikeObject(registerRes.body.agent) ||
      typeof registerRes.body.agent.id !== "string"
    ) {
      throw new Error(
        `Failed to register local agent (${registerRes.status}): ${bodyToError(registerRes.body)}`,
      );
    }

    const localApiKey = registerRes.body.apiKey;
    const localAgentId = registerRes.body.agent.id;

    let smokeMemoryId = null;
    if (writeSmokeMemory) {
      const memoryRes = await requestJson(`${apiBaseUrl}/api/memories`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${localApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          content: `Local bootstrap memory created at ${new Date().toISOString()}`,
          memoryType: "fact",
          memoryScope: "group",
          tags: ["local-dev", "bootstrap"],
        }),
      });

      if (memoryRes.status !== 201 || !looksLikeObject(memoryRes.body) || typeof memoryRes.body.id !== "string") {
        throw new Error(
          `Agent created but smoke memory failed (${memoryRes.status}): ${bodyToError(memoryRes.body)}`,
        );
      }
      smokeMemoryId = memoryRes.body.id;
    }

    const output = {
      generatedAt: new Date().toISOString(),
      apiBaseUrl,
      tenant: {
        id: tenantId,
        name: tenantName,
        created: tenantCreated,
      },
      group: {
        id: groupId,
        name: groupName,
        created: groupCreated,
        provisionSource: groupProvisionSource,
      },
      agent: {
        id: localAgentId,
        externalId,
      },
      dashboardUser: {
        id: dashboardUserId,
        externalId: dashboardExternalId,
      },
      apiKey: localApiKey,
      mcp: {
        url: `${apiBaseUrl}/mcp`,
        authorizationHeader: `Bearer ${localApiKey}`,
      },
      loginHint: {
        orgInput: "test-org",
        notes: "For dashboard local auth, enter test-org in the login form.",
      },
      smokeMemoryId,
    };

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");

    console.log(`Local bootstrap complete: ${outputPath}`);
    console.log(`tenant=${tenantId} group=${groupId} agent=${localAgentId}`);
    console.log(`mcp_url=${output.mcp.url}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().catch((error) => {
  console.error("Local bootstrap failed", error);
  process.exit(1);
});
