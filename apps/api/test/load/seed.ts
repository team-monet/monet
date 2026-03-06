import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { withTenantScope } from "@monet/db";

const EMBEDDING_DIMENSIONS = 1536;

interface ProvisionTenantResponse {
  tenant: {
    id: string;
    name: string;
  };
  agent: {
    id: string;
  };
  apiKey: string;
}

interface GroupResponse {
  id: string;
}

interface RegisterAgentResponse {
  agent: {
    id: string;
  };
  apiKey: string;
}

interface SeedOutput {
  generatedAt: string;
  tenantId: string;
  tenantName: string;
  apiKeys: string[];
  agentIds: string[];
  groupIds: string[];
  sampleMemoryIds: string[];
  memoriesPerGroup: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init);
  const body = (await res.json()) as T;
  return { status: res.status, body };
}

function tenantSchemaName(tenantId: string): string {
  return `tenant_${tenantId.replace(/-/g, "_")}`;
}

function embeddingLiteral(value: number): string {
  return `[${Array.from({ length: EMBEDDING_DIMENSIONS }, () => value).join(",")}]`;
}

async function main() {
  const apiBaseUrl = process.env.API_BASE_URL ?? "http://127.0.0.1:3001";
  const platformAdminSecret = requiredEnv("PLATFORM_ADMIN_SECRET");
  const databaseUrl = requiredEnv("DATABASE_URL");
  const seedOutputPath = process.env.LOAD_SEED_FILE ?? "/tmp/monet-load-seed.json";

  const groupCount = envInt("LOAD_GROUP_COUNT", 2);
  const agentCount = envInt("LOAD_AGENT_COUNT", 10);
  const memoriesPerGroup = envInt("LOAD_MEMORIES_PER_GROUP", 1000);

  const tenantName = `load-test-${Date.now()}`;
  const tenantRes = await requestJson<ProvisionTenantResponse | { message?: string }>(
    `${apiBaseUrl}/api/tenants`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${platformAdminSecret}`,
      },
      body: JSON.stringify({ name: tenantName }),
    },
  );

  if (tenantRes.status !== 201) {
    throw new Error(`Failed to provision tenant: ${JSON.stringify(tenantRes.body)}`);
  }

  const tenantBody = tenantRes.body as ProvisionTenantResponse;
  const tenantId = tenantBody.tenant.id;
  const bootstrapApiKey = tenantBody.apiKey;
  const bootstrapAgentId = tenantBody.agent.id;

  const groupIds: string[] = [];
  for (let i = 0; i < groupCount; i += 1) {
    const groupRes = await requestJson<GroupResponse | { message?: string }>(
      `${apiBaseUrl}/api/groups`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bootstrapApiKey}`,
        },
        body: JSON.stringify({
          name: `load-group-${i + 1}`,
          description: "Seeded group for load testing",
        }),
      },
    );

    if (groupRes.status !== 201) {
      throw new Error(`Failed to create group ${i + 1}: ${JSON.stringify(groupRes.body)}`);
    }

    groupIds.push((groupRes.body as GroupResponse).id);
  }

  const agentIds: string[] = [bootstrapAgentId];
  const apiKeys: string[] = [bootstrapApiKey];

  for (let i = 1; i < agentCount; i += 1) {
    const registerRes = await requestJson<RegisterAgentResponse | { message?: string }>(
      `${apiBaseUrl}/api/agents/register`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bootstrapApiKey}`,
        },
        body: JSON.stringify({ externalId: `load-agent-${i + 1}` }),
      },
    );

    if (registerRes.status !== 201) {
      throw new Error(`Failed to register agent ${i + 1}: ${JSON.stringify(registerRes.body)}`);
    }

    const registerBody = registerRes.body as RegisterAgentResponse;
    agentIds.push(registerBody.agent.id);
    apiKeys.push(registerBody.apiKey);
  }

  // Ensure each agent belongs to one group so group-scoped operations are valid.
  for (let i = 0; i < agentIds.length; i += 1) {
    const groupId = groupIds[i % groupIds.length];
    const membershipRes = await requestJson<{ success?: boolean; message?: string }>(
      `${apiBaseUrl}/api/groups/${groupId}/members`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bootstrapApiKey}`,
        },
        body: JSON.stringify({ agentId: agentIds[i] }),
      },
    );

    if (![201, 409].includes(membershipRes.status)) {
      throw new Error(`Failed to add agent ${agentIds[i]} to group ${groupId}`);
    }
  }

  const sql = postgres(databaseUrl);
  const schemaName = tenantSchemaName(tenantId);
  const sampleMemoryIds: string[] = [];

  for (let groupIndex = 0; groupIndex < groupIds.length; groupIndex += 1) {
    const groupId = groupIds[groupIndex];
    const vector = embeddingLiteral(groupIndex % 2 === 0 ? 0.15 : 0.85);

    await withTenantScope(sql, schemaName, async (txSql) => {
      const tx = txSql as unknown as postgres.Sql;

      for (let i = 0; i < memoriesPerGroup; i += 1) {
        const authorId = agentIds[(groupIndex + i) % agentIds.length];
        const content = `load memory group-${groupIndex + 1} item-${i + 1} for tier search/fetch validation`;
        const tags = ["load", `group-${groupIndex + 1}`, `item-${(i % 25) + 1}`];

        const [row] = await tx`
          INSERT INTO memory_entries (
            content,
            summary,
            enrichment_status,
            memory_type,
            memory_scope,
            tags,
            embedding,
            author_agent_id,
            group_id
          )
          VALUES (
            ${content},
            ${`summary:${content.slice(0, 80)}`},
            ${"completed"},
            ${"fact"},
            ${"group"},
            ${tags},
            ${vector}::vector,
            ${authorId},
            ${groupId}
          )
          RETURNING id
        `;

        if (sampleMemoryIds.length < 250) {
          sampleMemoryIds.push(row.id as string);
        }
      }
    });

    console.log(`Seeded ${memoriesPerGroup} memories for group ${groupId}`);
  }

  await sql.end({ timeout: 5 });

  const output: SeedOutput = {
    generatedAt: new Date().toISOString(),
    tenantId,
    tenantName,
    apiKeys,
    agentIds,
    groupIds,
    sampleMemoryIds,
    memoriesPerGroup,
  };

  await mkdir(path.dirname(seedOutputPath), { recursive: true });
  await writeFile(seedOutputPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");

  console.log(`Load-test seed completed: ${seedOutputPath}`);
  console.log(
    `tenant=${tenantId} groups=${groupIds.length} agents=${agentIds.length} memories=${groupIds.length * memoriesPerGroup}`,
  );
}

void main().catch((error) => {
  console.error("Load-test seed failed", error);
  process.exit(1);
});
