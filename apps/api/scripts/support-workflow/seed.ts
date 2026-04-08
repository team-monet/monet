import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@monet/db";
import { provisionTenant } from "../../src/services/tenant.service";

type Group = { id: string; name: string; description: string; memoryQuota: number | null; createdAt: string };
type Agent = { id: string; externalId: string; tenantId: string; userId: string | null; isAutonomous: boolean };

type RegisterAgentResponse = {
  agent: { id: string; externalId: string };
  apiKey: string;
};

type SeedState = {
  generatedAt: string;
  apiBaseUrl: string;
  tenant: { id: string; name: string; slug: string };
  groups: { generalId: string; supportId: string };
  agents: {
    admin: { id: string; externalId: string; apiKey: string };
    supportL1: { id: string; apiKey: string };
    supportL2: { id: string; apiKey: string };
    billing: { id: string; apiKey: string };
  };
  memories: {
    preference: { id: string; content: string };
    issue: { id: string; content: string };
    procedure: { id: string; content: string };
    privateFact: { id: string; content: string };
  };
};

type MemorySeed = {
  key: keyof SeedState["memories"];
  content: string;
  memoryType: "preference" | "issue" | "procedure" | "fact";
  memoryScope: "group" | "private";
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEMO_TAGS = ["support", "handoff", "customer-42", "login-failure", "workaround"] as const;

const MEMORY_SEEDS: MemorySeed[] = [
  {
    key: "preference",
    content:
      "[M6-87] customer-42 contact preference: email only between 09:00-17:00 America/Los_Angeles; avoid callback outside window.",
    memoryType: "preference",
    memoryScope: "group",
  },
  {
    key: "issue",
    content:
      "[M6-87] recurring failure signature: login returns 401 with trace=AUTH_SESSION_STALE when account has recent password reset.",
    memoryType: "issue",
    memoryScope: "group",
  },
  {
    key: "procedure",
    content:
      "[M6-87] workaround: invalidate stale auth session, reissue challenge token, then prompt customer-42 to retry login after 60 seconds.",
    memoryType: "procedure",
    memoryScope: "group",
  },
  {
    key: "privateFact",
    content:
      "[M6-87] internal investigation note: likely race condition between password-reset webhook and session replication job; keep private pending verification.",
    memoryType: "fact",
    memoryScope: "private",
  },
];

function help() {
  console.log(`Seed the support-agent workflow demo (M6 #87).

Usage:
  pnpm demo:support:seed

Environment:
  API_BASE_URL           Default: http://127.0.0.1:3301
  DATABASE_URL           Required (for tenant create/lookup)
  DEMO_TENANT_NAME       Default: Demo Support Org
  DEMO_TENANT_SLUG       Default: demo-support-org
  DEMO_ADMIN_API_KEY     Optional: override admin key when tenant already exists
  DEMO_STATE_FILE        Default: .local-dev/demo-support-workflow.json

Notes:
  - Creates tenant if missing (slug: demo-support-org).
  - Uses API routes for groups/agents/memories.
  - Idempotent for required groups, agents, and deterministic seed memories.
`);
}

function env(name: string, fallback?: string) {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
}

async function readSeedState(stateFile: string): Promise<SeedState | null> {
  try {
    const raw = await readFile(stateFile, "utf-8");
    return JSON.parse(raw) as SeedState;
  } catch {
    return null;
  }
}

async function saveSeedState(stateFile: string, state: SeedState) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
): Promise<{ status: number; ok: boolean; body: T }> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, ok: response.ok, body };
}

function authHeaders(apiKey: string): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
}

async function assertApiReady(apiBaseUrl: string) {
  const health = await fetch(`${apiBaseUrl}/health/ready`);
  if (!health.ok) {
    throw new Error(`API not ready at ${apiBaseUrl}/health/ready (status ${health.status})`);
  }
}

async function ensureSupportGroup(apiBaseUrl: string, adminApiKey: string): Promise<Group> {
  const groupsRes = await requestJson<{ groups: Group[] }>(`${apiBaseUrl}/api/groups`, {
    method: "GET",
    headers: authHeaders(adminApiKey),
  });
  if (!groupsRes.ok) {
    throw new Error(`Failed to list groups: ${JSON.stringify(groupsRes.body)}`);
  }

  const existing = groupsRes.body.groups.find((group) => group.name === "Support");
  if (existing) return existing;

  const createRes = await requestJson<Group | { message?: string }>(`${apiBaseUrl}/api/groups`, {
    method: "POST",
    headers: authHeaders(adminApiKey),
    body: JSON.stringify({
      name: "Support",
      description: "Support-agent workflow demo group",
    }),
  });

  if (createRes.status !== 201) {
    throw new Error(`Failed to create Support group: ${JSON.stringify(createRes.body)}`);
  }

  return createRes.body as Group;
}

async function getGeneralGroup(apiBaseUrl: string, adminApiKey: string): Promise<Group> {
  const groupsRes = await requestJson<{ groups: Group[] }>(`${apiBaseUrl}/api/groups`, {
    method: "GET",
    headers: authHeaders(adminApiKey),
  });

  if (!groupsRes.ok) {
    throw new Error(`Failed to list groups: ${JSON.stringify(groupsRes.body)}`);
  }

  const group = groupsRes.body.groups.find((entry) => entry.name === "General");
  if (!group) {
    throw new Error("General group not found. Tenant provisioning appears incomplete.");
  }
  return group;
}

async function ensureAgent(
  apiBaseUrl: string,
  adminApiKey: string,
  externalId: string,
  groupId: string,
): Promise<{ id: string; apiKey: string }> {
  const listRes = await requestJson<Agent[]>(`${apiBaseUrl}/api/agents`, {
    method: "GET",
    headers: authHeaders(adminApiKey),
  });
  if (!listRes.ok) {
    throw new Error(`Failed to list agents: ${JSON.stringify(listRes.body)}`);
  }

  const existing = listRes.body.find((agent) => agent.externalId === externalId);

  let agentId: string;
  let apiKey: string;

  if (existing) {
    agentId = existing.id;
    const rotateRes = await requestJson<{ apiKey: string } | { message?: string }>(
      `${apiBaseUrl}/api/agents/${agentId}/regenerate-token`,
      {
        method: "POST",
        headers: authHeaders(adminApiKey),
      },
    );

    if (!rotateRes.ok || !("apiKey" in rotateRes.body)) {
      throw new Error(
        `Failed to rotate API key for ${externalId}: ${JSON.stringify(rotateRes.body)}`,
      );
    }
    apiKey = rotateRes.body.apiKey;
  } else {
    const registerRes = await requestJson<RegisterAgentResponse | { message?: string }>(
      `${apiBaseUrl}/api/agents/register`,
      {
        method: "POST",
        headers: authHeaders(adminApiKey),
        body: JSON.stringify({
          externalId,
          isAutonomous: true,
          groupId,
        }),
      },
    );

    if (registerRes.status !== 201) {
      throw new Error(`Failed to register ${externalId}: ${JSON.stringify(registerRes.body)}`);
    }

    const registerBody = registerRes.body as RegisterAgentResponse;
    agentId = registerBody.agent.id;
    apiKey = registerBody.apiKey;
  }

  const membershipRes = await requestJson<{ success?: boolean; operation?: string; message?: string }>(
    `${apiBaseUrl}/api/groups/${groupId}/members`,
    {
      method: "POST",
      headers: authHeaders(adminApiKey),
      body: JSON.stringify({ agentId }),
    },
  );

  if (![200, 201].includes(membershipRes.status)) {
    throw new Error(`Failed to ensure ${externalId} membership: ${JSON.stringify(membershipRes.body)}`);
  }

  return { id: agentId, apiKey };
}

async function findExistingMemoryId(
  apiBaseUrl: string,
  apiKey: string,
  contentSnippet: string,
): Promise<string | null> {
  const searchRes = await requestJson<{ items: Array<{ id: string; summary: string }> }>(
    `${apiBaseUrl}/api/memories?query=${encodeURIComponent(contentSnippet)}&includePrivate=true&limit=25`,
    {
      method: "GET",
      headers: authHeaders(apiKey),
    },
  );

  if (!searchRes.ok) {
    throw new Error(`Failed to search memories: ${JSON.stringify(searchRes.body)}`);
  }

  const match = searchRes.body.items.find((item) => item.summary.includes(contentSnippet));
  return match?.id ?? null;
}

async function ensureSeedMemory(
  apiBaseUrl: string,
  apiKey: string,
  memory: MemorySeed,
): Promise<string> {
  const signature = memory.content.slice(0, 64);
  const existingId = await findExistingMemoryId(apiBaseUrl, apiKey, signature);
  if (existingId) return existingId;

  const createRes = await requestJson<{ id: string } | { message?: string }>(
    `${apiBaseUrl}/api/memories`,
    {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        content: memory.content,
        memoryType: memory.memoryType,
        memoryScope: memory.memoryScope,
        tags: [...DEMO_TAGS],
      }),
    },
  );

  if (createRes.status !== 201 || !("id" in createRes.body)) {
    throw new Error(`Failed to create ${memory.key} memory: ${JSON.stringify(createRes.body)}`);
  }

  return createRes.body.id;
}

async function assertAdminTenant(
  apiBaseUrl: string,
  adminApiKey: string,
  expectedTenantId: string,
) {
  const meRes = await requestJson<{ id: string; externalId: string; tenantId: string }>(
    `${apiBaseUrl}/api/agents/me`,
    {
      method: "GET",
      headers: authHeaders(adminApiKey),
    },
  );

  if (!meRes.ok) {
    throw new Error(`Admin API key is invalid: ${JSON.stringify(meRes.body)}`);
  }

  if (meRes.body.tenantId !== expectedTenantId) {
    throw new Error(
      `Admin API key tenant mismatch. expected=${expectedTenantId} actual=${meRes.body.tenantId}`,
    );
  }

  return meRes.body;
}

export async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    help();
    return;
  }

  const apiBaseUrl = env("API_BASE_URL", "http://127.0.0.1:3301").replace(/\/$/, "");
  const databaseUrl = env("DATABASE_URL");
  const tenantName = env("DEMO_TENANT_NAME", "Demo Support Org");
  const tenantSlug = env("DEMO_TENANT_SLUG", "demo-support-org");
  const stateFile = env(
    "DEMO_STATE_FILE",
    path.resolve(__dirname, "../../../../.local-dev/demo-support-workflow.json"),
  );

  await assertApiReady(apiBaseUrl);

  const { db, sql } = createClient(databaseUrl);
  const priorState = await readSeedState(stateFile);

  try {
    let existingTenant: {
      id: string;
      name: string;
      slug: string;
      isolationMode: string;
      createdAt: Date;
    } | null = null;

    const tenantRows = await sql<
      Array<{
        id: string;
        name: string;
        slug: string;
        isolation_mode: string;
        created_at: Date;
      }>
    >`
      SELECT id, name, slug, isolation_mode, created_at
      FROM tenants
      WHERE slug = ${tenantSlug}
      LIMIT 1
    `;

    if (tenantRows.length > 0) {
      existingTenant = {
        id: tenantRows[0].id,
        name: tenantRows[0].name,
        slug: tenantRows[0].slug,
        isolationMode: tenantRows[0].isolation_mode,
        createdAt: tenantRows[0].created_at,
      };
    }

    let adminApiKey = process.env.DEMO_ADMIN_API_KEY ?? priorState?.agents.admin.apiKey ?? null;

    if (!existingTenant) {
      const provisioned = await provisionTenant(db, sql, {
        name: tenantName,
        slug: tenantSlug,
      });

      existingTenant = provisioned.tenant;
      adminApiKey = provisioned.rawApiKey;
      console.log(`Created tenant ${tenantSlug} (${existingTenant.id})`);
    }

    if (!adminApiKey) {
      throw new Error(
        `Tenant ${tenantSlug} already exists but no admin key is available. Set DEMO_ADMIN_API_KEY or run reset + seed.`,
      );
    }

    const adminAgent = await assertAdminTenant(apiBaseUrl, adminApiKey, existingTenant.id);

    const generalGroup = await getGeneralGroup(apiBaseUrl, adminApiKey);
    const supportGroup = await ensureSupportGroup(apiBaseUrl, adminApiKey);

    const supportL1 = await ensureAgent(
      apiBaseUrl,
      adminApiKey,
      "support-l1-agent",
      supportGroup.id,
    );
    const supportL2 = await ensureAgent(
      apiBaseUrl,
      adminApiKey,
      "support-l2-agent",
      supportGroup.id,
    );
    const billing = await ensureAgent(apiBaseUrl, adminApiKey, "billing-agent", generalGroup.id);

    const memoryIds: SeedState["memories"] = {
      preference: { id: "", content: MEMORY_SEEDS[0].content },
      issue: { id: "", content: MEMORY_SEEDS[1].content },
      procedure: { id: "", content: MEMORY_SEEDS[2].content },
      privateFact: { id: "", content: MEMORY_SEEDS[3].content },
    };

    for (const memory of MEMORY_SEEDS) {
      const memoryId = await ensureSeedMemory(apiBaseUrl, supportL1.apiKey, memory);
      memoryIds[memory.key] = { id: memoryId, content: memory.content };
    }

    const state: SeedState = {
      generatedAt: new Date().toISOString(),
      apiBaseUrl,
      tenant: {
        id: existingTenant.id,
        name: existingTenant.name,
        slug: existingTenant.slug,
      },
      groups: {
        generalId: generalGroup.id,
        supportId: supportGroup.id,
      },
      agents: {
        admin: {
          id: adminAgent.id,
          externalId: adminAgent.externalId,
          apiKey: adminApiKey,
        },
        supportL1,
        supportL2,
        billing,
      },
      memories: memoryIds,
    };

    await saveSeedState(stateFile, state);

    console.log("\nDemo support workflow seed complete.");
    console.log(`Tenant: ${state.tenant.slug} (${state.tenant.id})`);
    console.log(`State file: ${stateFile}`);
    console.log("Agents: support-l1-agent, support-l2-agent, billing-agent");
    console.log("Memories: preference, issue, procedure, private fact");
    console.log(
      "Framing reminder: Support is our wedge; shared memory is the platform.",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

void main().catch((error) => {
  console.error("seed-support-workflow failed", error);
  process.exit(1);
});
