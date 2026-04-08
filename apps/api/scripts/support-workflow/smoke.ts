import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type SeedState = {
  apiBaseUrl: string;
  tenant: { id: string; slug: string };
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function help() {
  console.log(`Preflight/smoke check for support-agent workflow demo (M6 #87).

Usage:
  pnpm demo:support:smoke

Environment:
  API_BASE_URL         Default: value from state file, fallback http://127.0.0.1:3301
  DEMO_STATE_FILE      Default: .local-dev/demo-support-workflow.json
  DEMO_ADMIN_API_KEY   Optional override
  DEMO_L1_API_KEY      Optional override
  DEMO_L2_API_KEY      Optional override
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    help();
    return;
  }

  const stateFile = env(
    "DEMO_STATE_FILE",
    path.resolve(__dirname, "../../../../.local-dev/demo-support-workflow.json"),
  );

  const state = await readSeedState(stateFile);
  if (!state) {
    throw new Error(`State file not found: ${stateFile}. Run seed first.`);
  }

  const apiBaseUrl = env("API_BASE_URL", state.apiBaseUrl ?? "http://127.0.0.1:3301").replace(/\/$/, "");
  const adminApiKey = process.env.DEMO_ADMIN_API_KEY ?? state.agents.admin.apiKey;
  const l1ApiKey = process.env.DEMO_L1_API_KEY ?? state.agents.supportL1.apiKey;
  const l2ApiKey = process.env.DEMO_L2_API_KEY ?? state.agents.supportL2.apiKey;

  const ready = await fetch(`${apiBaseUrl}/health/ready`);
  assert(ready.ok, `API readiness failed: ${ready.status}`);

  const adminMe = await requestJson<{ tenantId: string; externalId: string }>(`${apiBaseUrl}/api/agents/me`, {
    method: "GET",
    headers: authHeaders(adminApiKey),
  });
  assert(adminMe.ok, `Admin API key invalid: ${JSON.stringify(adminMe.body)}`);
  assert(
    adminMe.body.tenantId === state.tenant.id,
    `Admin tenant mismatch. expected=${state.tenant.id} actual=${adminMe.body.tenantId}`,
  );

  const l2Search = await requestJson<{ items: Array<{ id: string; summary: string }> }>(
    `${apiBaseUrl}/api/memories?query=${encodeURIComponent("[M6-87]")}&limit=20`,
    { method: "GET", headers: authHeaders(l2ApiKey) },
  );
  assert(l2Search.ok, `L2 search failed: ${JSON.stringify(l2Search.body)}`);
  assert(
    l2Search.body.items.length >= 3,
    `Expected at least 3 shared demo memories, found ${l2Search.body.items.length}`,
  );

  const l1SearchPrivate = await requestJson<{ items: Array<{ id: string; summary: string }> }>(
    `${apiBaseUrl}/api/memories?query=${encodeURIComponent("[M6-87]")}&includePrivate=true&limit=20`,
    { method: "GET", headers: authHeaders(l1ApiKey) },
  );
  assert(l1SearchPrivate.ok, `L1 search failed: ${JSON.stringify(l1SearchPrivate.body)}`);
  assert(
    l1SearchPrivate.body.items.length >= 4,
    `Expected at least 4 memories (including private), found ${l1SearchPrivate.body.items.length}`,
  );

  const privateFetchByL2 = await requestJson<{ error?: string; message?: string }>(
    `${apiBaseUrl}/api/memories/${state.memories.privateFact.id}`,
    {
      method: "GET",
      headers: authHeaders(l2ApiKey),
    },
  );
  assert(
    privateFetchByL2.status === 403,
    `Expected private-memory denial (403), got ${privateFetchByL2.status}`,
  );

  const auditRes = await requestJson<{ items: Array<{ action: string }> }>(
    `${apiBaseUrl}/api/audit?limit=200`,
    {
      method: "GET",
      headers: authHeaders(adminApiKey),
    },
  );
  assert(auditRes.ok, `Audit query failed: ${JSON.stringify(auditRes.body)}`);
  const memoryAuditEntries = auditRes.body.items.filter((entry) => entry.action.startsWith("memory."));
  assert(memoryAuditEntries.length > 0, "Expected memory.* audit entries but found none.");

  console.log("Smoke check passed.");
  console.log(`Tenant: ${state.tenant.slug} (${state.tenant.id})`);
  console.log(`Shared memories visible to L2: ${l2Search.body.items.length}`);
  console.log(`L1 memories visible with includePrivate=true: ${l1SearchPrivate.body.items.length}`);
  console.log(`memory.* audit entries found: ${memoryAuditEntries.length}`);
}

void main().catch((error) => {
  console.error("smoke-support-workflow failed", error);
  process.exit(1);
});
