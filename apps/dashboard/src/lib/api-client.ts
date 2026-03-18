import {
  Agent,
  AgentDetail,
  MemoryEntry,
  MemoryEntryTier1,
  AgentGroup,
  MemoryScope,
  MemoryType,
  CreateMemoryEntryInput,
  UpdateMemoryEntryInput,
  Rule,
  RuleSet,
  AuditLog,
  RegisterAgentApiInput,
  MetricsResponse,
} from "@monet/types";
import { auth } from "./auth";
import { db } from "./db";
import { tenantUsers } from "@monet/db";
import { eq } from "drizzle-orm";
import { decrypt } from "./crypto";
import { ensureDashboardAgent, syncDashboardAgentRole } from "./dashboard-agent";
import {
  SESSION_EXPIRED_ERROR_MESSAGE,
  isRefreshAccessTokenError,
} from "./session-errors";

export interface ApiClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class MonetApiClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
  }

  private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const status = response.status;
      let message = "An unexpected error occurred. Please try again later.";

      if (status === 400) message = "Invalid request. Please check your input.";
      else if (status === 401) message = SESSION_EXPIRED_ERROR_MESSAGE;
      else if (status === 403) message = "Access denied. You do not have permission to perform this action.";
      else if (status === 404) message = "The requested resource was not found.";
      else if (status === 409) message = "There was a conflict with the current state.";
      else if (status === 429) message = "Too many requests. Please slow down.";
      else if (status >= 500) message = "A server error occurred. Our team has been notified.";

      throw new Error(message);
    }

    return response.json();
  }

  // Agents
  async getMe(): Promise<Agent> {
    return this.fetch<Agent>("/api/agents/me");
  }

  async getAgentStatus(
    id: string,
  ): Promise<{ activeSessions: number; revoked: boolean }> {
    return this.fetch<{ activeSessions: number; revoked: boolean }>(
      `/api/agents/${id}/status`,
    );
  }

  async listAgents(): Promise<Agent[]> {
    return this.fetch<Agent[]>("/api/agents");
  }

  async getAgent(id: string): Promise<AgentDetail> {
    return this.fetch<AgentDetail>(`/api/agents/${id}`);
  }

  async registerAgent(
    input: RegisterAgentApiInput,
  ): Promise<{ agent: Agent; apiKey: string }> {
    return this.fetch<{ agent: Agent; apiKey: string }>("/api/agents/register", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async regenerateAgentToken(id: string): Promise<{ apiKey: string }> {
    return this.fetch<{ apiKey: string }>(`/api/agents/${id}/regenerate-token`, {
      method: "POST",
    });
  }

  async revokeAgent(id: string): Promise<{ success: true; revokedAt: string | null }> {
    return this.fetch<{ success: true; revokedAt: string | null }>(
      `/api/agents/${id}/revoke`,
      { method: "POST" },
    );
  }

  async unrevokeAgent(id: string): Promise<{ success: true; revokedAt: null }> {
    return this.fetch<{ success: true; revokedAt: null }>(
      `/api/agents/${id}/unrevoke`,
      { method: "POST" },
    );
  }

  async attachRuleSetToAgent(id: string, ruleSetId: string): Promise<{ success: true }> {
    return this.fetch<{ success: true }>(`/api/agents/${id}/rule-sets`, {
      method: "POST",
      body: JSON.stringify({ ruleSetId }),
    });
  }

  async detachRuleSetFromAgent(id: string, ruleSetId: string): Promise<{ success: true }> {
    return this.fetch<{ success: true }>(`/api/agents/${id}/rule-sets/${ruleSetId}`, {
      method: "DELETE",
    });
  }

  // Memories
  async listMemories(params?: {
    memoryType?: MemoryType;
    tags?: string;
    includeUser?: boolean;
    includePrivate?: boolean;
    cursor?: string;
    limit?: number;
    query?: string;
  }): Promise<{ items: MemoryEntryTier1[]; nextCursor: string | null }> {
    const query = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) query.set(key, String(value));
      });
    }
    return this.fetch<{ items: MemoryEntryTier1[]; nextCursor: string | null }>(
      `/api/memories?${query.toString()}`,
    );
  }

  async getMemoryEntry(id: string): Promise<{ entry: MemoryEntry; versions: { id: string; version: number; createdAt: string; content: string }[] }> {
    return this.fetch<{ entry: MemoryEntry; versions: { id: string; version: number; createdAt: string; content: string }[] }>(`/api/memories/${id}`);
  }

  async searchMemories(query: string, limit?: number): Promise<{ items: MemoryEntryTier1[]; nextCursor: string | null }> {
    const searchParams = new URLSearchParams({ query });
    if (limit) searchParams.set("limit", String(limit));
    return this.fetch<{ items: MemoryEntryTier1[]; nextCursor: string | null }>(
      `/api/memories?${searchParams.toString()}`,
    );
  }

  async createMemoryEntry(input: CreateMemoryEntryInput): Promise<MemoryEntry> {
    return this.fetch<MemoryEntry>("/api/memories", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateMemoryEntry(
    id: string,
    input: UpdateMemoryEntryInput,
  ): Promise<MemoryEntry> {
    return this.fetch<MemoryEntry>(`/api/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async deleteMemoryEntry(id: string): Promise<void> {
    return this.fetch<void>(`/api/memories/${id}`, {
      method: "DELETE",
    });
  }

  async markMemoryOutdated(id: string): Promise<void> {
    return this.fetch<void>(`/api/memories/${id}/outdated`, {
      method: "PATCH",
    });
  }

  async promoteMemoryScope(id: string, scope: MemoryScope): Promise<void> {
    return this.fetch<void>(`/api/memories/${id}/scope`, {
      method: "PATCH",
      body: JSON.stringify({ scope }),
    });
  }

  // Groups
  async listGroups(): Promise<{ groups: AgentGroup[] }> {
    return this.fetch<{ groups: AgentGroup[] }>("/api/groups");
  }

  async createGroup(input: {
    name: string;
    description?: string;
    memoryQuota?: number;
  }): Promise<AgentGroup> {
    return this.fetch<AgentGroup>("/api/groups", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async getGroup(id: string): Promise<AgentGroup> {
    return this.fetch<AgentGroup>(`/api/groups/${id}`);
  }

  async listGroupMembers(id: string): Promise<{ members: Agent[] }> {
    return this.fetch<{ members: Agent[] }>(`/api/groups/${id}/members`);
  }

  async listGroupRuleSets(id: string): Promise<{ ruleSets: RuleSet[] }> {
    return this.fetch<{ ruleSets: RuleSet[] }>(`/api/groups/${id}/rule-sets`);
  }

  async addGroupMember(id: string, agentId: string): Promise<void> {
    return this.fetch<void>(`/api/groups/${id}/members`, {
      method: "POST",
      body: JSON.stringify({ agentId }),
    });
  }

  async removeGroupMember(id: string, agentId: string): Promise<void> {
    return this.fetch<void>(`/api/groups/${id}/members/${agentId}`, {
      method: "DELETE",
    });
  }

  async updateGroup(
    id: string,
    input: { name?: string; description?: string; memoryQuota?: number },
  ): Promise<AgentGroup> {
    return this.fetch<AgentGroup>(`/api/groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  // Rules
  async listRules(): Promise<{ rules: Rule[] }> {
    return this.fetch<{ rules: Rule[] }>("/api/rules");
  }

  async createRule(input: { name: string; description: string }): Promise<Rule> {
    return this.fetch<Rule>("/api/rules", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listPersonalRules(): Promise<{ rules: Rule[] }> {
    return this.fetch<{ rules: Rule[] }>("/api/me/rules");
  }

  async createPersonalRule(input: { name: string; description: string }): Promise<Rule> {
    return this.fetch<Rule>("/api/me/rules", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updatePersonalRule(
    id: string,
    input: { name?: string; description?: string },
  ): Promise<Rule> {
    return this.fetch<Rule>(`/api/me/rules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async deletePersonalRule(id: string): Promise<void> {
    return this.fetch<void>(`/api/me/rules/${id}`, {
      method: "DELETE",
    });
  }

  async updateRule(
    id: string,
    input: { name?: string; description?: string },
  ): Promise<Rule> {
    return this.fetch<Rule>(`/api/rules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async listRuleSets(): Promise<{ ruleSets: RuleSet[] }> {
    return this.fetch<{ ruleSets: RuleSet[] }>("/api/rule-sets");
  }

  async createRuleSet(input: { name: string }): Promise<RuleSet> {
    return this.fetch<RuleSet>("/api/rule-sets", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listPersonalRuleSets(): Promise<{ ruleSets: RuleSet[] }> {
    return this.fetch<{ ruleSets: RuleSet[] }>("/api/me/rule-sets");
  }

  async createPersonalRuleSet(input: { name: string }): Promise<RuleSet> {
    return this.fetch<RuleSet>("/api/me/rule-sets", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async deletePersonalRuleSet(id: string): Promise<void> {
    return this.fetch<void>(`/api/me/rule-sets/${id}`, {
      method: "DELETE",
    });
  }

  async deleteRuleSet(id: string): Promise<void> {
    return this.fetch<void>(`/api/rule-sets/${id}`, {
      method: "DELETE",
    });
  }

  async addPersonalRuleToSet(ruleSetId: string, ruleId: string): Promise<void> {
    return this.fetch<void>(`/api/me/rule-sets/${ruleSetId}/rules`, {
      method: "POST",
      body: JSON.stringify({ ruleId }),
    });
  }

  async removePersonalRuleFromSet(ruleSetId: string, ruleId: string): Promise<void> {
    return this.fetch<void>(`/api/me/rule-sets/${ruleSetId}/rules/${ruleId}`, {
      method: "DELETE",
    });
  }

  async addRuleToSet(ruleSetId: string, ruleId: string): Promise<void> {
    return this.fetch<void>(`/api/rule-sets/${ruleSetId}/rules`, {
      method: "POST",
      body: JSON.stringify({ ruleId }),
    });
  }

  async removeRuleFromSet(ruleSetId: string, ruleId: string): Promise<void> {
    return this.fetch<void>(`/api/rule-sets/${ruleSetId}/rules/${ruleId}`, {
      method: "DELETE",
    });
  }

  // Metrics
  async getMetrics(): Promise<MetricsResponse> {
    return this.fetch<MetricsResponse>("/api/metrics");
  }

  // Audit (Step 10)
  async getAuditLogs(params?: {
    actorId?: string;
    action?: string;
    startDate?: string;
    endDate?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: AuditLog[]; nextCursor: string | null }> {
    const query = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) query.set(key, String(value));
      });
    }
    return this.fetch<{ items: AuditLog[]; nextCursor: string | null }>(
      "/api/audit?" + query.toString(),
    );
  }
}

interface ExtendedUser {
  id?: string;
  role?: string;
  tenantId?: string;
}

export async function getApiClient() {
  const session = await auth();
  if (!session || !session.user) {
    throw new Error("No session found");
  }

  if (isRefreshAccessTokenError((session as { error?: string }).error)) {
    throw new Error(SESSION_EXPIRED_ERROR_MESSAGE);
  }

  const sessionUser = session.user as ExtendedUser;
  if (!sessionUser.id) {
    throw new Error("User ID not found in session");
  }
  if (!sessionUser.tenantId) {
    throw new Error("Tenant ID not found in session");
  }

  // Fetch the user record to get the encrypted dashboard API key.
  let userRows = await db
    .select({ dashboardApiKeyEncrypted: tenantUsers.dashboardApiKeyEncrypted })
    .from(tenantUsers)
    .where(eq(tenantUsers.id, sessionUser.id))
    .limit(1);

  // Only run the full ensureDashboardAgent setup when the key is missing (first
  // visit or after a credential reset).  This avoids 5+ DB queries on every
  // single API call just to confirm nothing changed.  A lightweight 1-query
  // role sync always runs to keep RBAC current.
  if (userRows.length === 0 || !userRows[0].dashboardApiKeyEncrypted) {
    await ensureDashboardAgent(sessionUser.id, sessionUser.id, sessionUser.tenantId);
    userRows = await db
      .select({ dashboardApiKeyEncrypted: tenantUsers.dashboardApiKeyEncrypted })
      .from(tenantUsers)
      .where(eq(tenantUsers.id, sessionUser.id))
      .limit(1);
  } else {
    // Hot path: 1-query role sync keeps RBAC current without the full setup cost.
    await syncDashboardAgentRole(sessionUser.id);
  }

  if (userRows.length === 0 || !userRows[0].dashboardApiKeyEncrypted) {
    throw new Error("Dashboard agent not initialized");
  }

  const apiKey = decrypt(userRows[0].dashboardApiKeyEncrypted);
  const apiUrl = process.env.INTERNAL_API_URL || "http://localhost:3001";

  return new MonetApiClient({
    baseUrl: apiUrl,
    apiKey,
  });
}
