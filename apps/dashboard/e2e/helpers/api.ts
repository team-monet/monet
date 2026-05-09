/**
 * API helpers for E2E test data seeding and cleanup.
 *
 * These functions call the Monet API directly to set up or tear down test
 * fixtures without going through the UI.
 */

const API_BASE = process.env.E2E_API_URL || "http://127.0.0.1:3001";
const TENANT_SLUG = process.env.E2E_TENANT_SLUG || "test-org";

let _apiKey: string | null = null;

async function getDashboardApiKey(): Promise<string> {
  if (_apiKey) return _apiKey;
  // In E2E, the API key comes from the test environment or a seed script.
  // Fall back to a well-known key for the local dev seeded environment.
  _apiKey = process.env.E2E_API_KEY || "test-dashboard-api-key";
  return _apiKey;
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const apiKey = await getDashboardApiKey();
  const url = `${API_BASE}/api/tenants/${TENANT_SLUG}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...options.headers,
    },
  });
}

/** Create a memory entry via the API. */
export async function createMemory(input: {
  summary: string;
  content: string;
  memoryType: string;
  memoryScope: string;
  tags?: string[];
  groupId?: string;
}): Promise<{ id: string }> {
  const res = await apiFetch("/memories", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Failed to create memory: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Delete a memory entry via the API. */
export async function deleteMemory(id: string): Promise<void> {
  const res = await apiFetch(`/memories/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete memory ${id}: ${res.status}`);
  }
}

/** List all agents via the API. */
export async function listAgents(): Promise<Array<{ id: string; name: string }>> {
  const res = await apiFetch("/agents");
  if (!res.ok) return [];
  return res.json();
}

/** Delete (revoke) an agent via the API. */
export async function revokeAgent(id: string): Promise<void> {
  const res = await apiFetch(`/agents/${id}/revoke`, { method: "POST" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to revoke agent ${id}: ${res.status}`);
  }
}

/** List all groups via the API. */
export async function listGroups(): Promise<Array<{ id: string; name: string }>> {
  const res = await apiFetch("/groups");
  if (!res.ok) return [];
  const data = await res.json();
  return data.groups ?? data;
}

/** Create a group via the API. */
export async function createGroup(input: {
  name: string;
  description?: string;
}): Promise<{ id: string; name: string }> {
  const res = await apiFetch("/groups", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Failed to create group: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Register an agent via the API and return its ID and API key. */
export async function registerAgent(input: {
  name: string;
  type: string;
  groupId: string;
}): Promise<{ agent: { id: string }; apiKey: string }> {
  const res = await apiFetch("/agents/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Failed to register agent: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Add an agent to a group. */
export async function addGroupMember(groupId: string, agentId: string): Promise<void> {
  const res = await apiFetch(`/groups/${groupId}/members`, {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
  if (!res.ok) {
    throw new Error(`Failed to add agent to group: ${res.status}`);
  }
}
