import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentContext } from "../middleware/context";

export class SessionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLimitError";
  }
}

const DEFAULT_IDLE_TTL_MS = 8 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TOTAL_SESSIONS = 1000;

function currentIdleTtlMs(): number {
  const raw = process.env.MCP_SESSION_IDLE_TTL_MS;
  if (!raw) return DEFAULT_IDLE_TTL_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_IDLE_TTL_MS;
  }

  return Math.floor(parsed);
}

export function maxSessionsPerAgent(): number {
  const raw = process.env.MCP_MAX_SESSIONS_PER_AGENT;
  if (!raw) return 5;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 5;
  }

  return Math.floor(parsed);
}

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  agentContext: AgentContext;
  tenantId?: string;
  tenantSlug?: string;
  tenantSchemaName: string;
  connectedAt: Date;
  lastActivityAt: Date;
  state?: McpSessionState;
  initializedAt?: Date;
  failedAt?: Date;
  closedAt?: Date;
  lastError?: string;
}

export type McpSessionState = "initializing" | "ready" | "closing" | "closed" | "failed";

export class SessionStore {
  private sessions = new Map<string, McpSession>();
  private inFlightRequests = new Map<string, number>();
  private versions = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;

  add(sessionId: string, session: McpSession): void {
    if (this.sessions.size >= MAX_TOTAL_SESSIONS) {
      throw new SessionLimitError("Total session limit reached");
    }
    const agentSessionCount = this.getByAgentId(session.agentContext.id).length;
    if (agentSessionCount >= maxSessionsPerAgent()) {
      throw new SessionLimitError("Per-agent session limit reached");
    }
    this.sessions.set(sessionId, {
      ...session,
      state: session.state ?? "ready",
      initializedAt: session.initializedAt ?? new Date(),
    });
    this.inFlightRequests.set(sessionId, 0);
    this.versions.set(sessionId, 0);
  }

  get(sessionId: string): McpSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAll(): Array<[string, McpSession]> {
    return Array.from(this.sessions.entries());
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.inFlightRequests.delete(sessionId);
    this.versions.delete(sessionId);
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastActivityAt = new Date();
    this.bumpVersion(sessionId);
  }

  getInFlightCount(sessionId: string): number {
    return this.inFlightRequests.get(sessionId) ?? 0;
  }

  setState(sessionId: string, state: McpSessionState, details?: { error?: string }): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const now = new Date();
    session.state = state;
    if (state === "ready") {
      session.initializedAt = now;
      session.failedAt = undefined;
      session.closedAt = undefined;
      session.lastError = undefined;
    } else if (state === "failed") {
      session.failedAt = now;
      session.lastError = details?.error;
    } else if (state === "closed") {
      session.closedAt = now;
    }
    this.bumpVersion(sessionId);
    return true;
  }

  getByAgentId(agentId: string): McpSession[] {
    return Array.from(this.sessions.values()).filter(
      (session) => session.agentContext.id === agentId,
    );
  }

  getEntriesByAgentId(agentId: string): Array<[string, McpSession]> {
    return Array.from(this.sessions.entries()).filter(
      ([, session]) => session.agentContext.id === agentId,
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.setState(sessionId, "closing");

    this.sessions.delete(sessionId);
    this.inFlightRequests.delete(sessionId);
    this.versions.delete(sessionId);
    await Promise.allSettled([
      session.transport.close(),
      session.server.close(),
    ]);
  }

  beginRequest(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if ((session.state ?? "ready") !== "ready") return false;

    const current = this.inFlightRequests.get(sessionId) ?? 0;
    this.inFlightRequests.set(sessionId, current + 1);
    return true;
  }

  endRequest(sessionId: string): void {
    const current = this.inFlightRequests.get(sessionId);
    if (current === undefined) return;
    if (current <= 1) {
      this.inFlightRequests.set(sessionId, 0);
      this.bumpVersion(sessionId);
      return;
    }
    this.inFlightRequests.set(sessionId, current - 1);
    this.bumpVersion(sessionId);
  }

  async closeIfIdle(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const idleTtlMs = currentIdleTtlMs();
    const initialVersion = this.versions.get(sessionId) ?? 0;
    const firstIdleCheck = Date.now() - session.lastActivityAt.getTime() > idleTtlMs;
    if (!firstIdleCheck) return false;
    if ((this.inFlightRequests.get(sessionId) ?? 0) > 0) return false;
    if ((session.state ?? "ready") !== "ready") return false;

    const latest = this.sessions.get(sessionId);
    if (!latest) return false;
    const latestVersion = this.versions.get(sessionId) ?? 0;
    if (latestVersion !== initialVersion) return false;
    const secondIdleCheck = Date.now() - latest.lastActivityAt.getTime() > idleTtlMs;
    if (!secondIdleCheck) return false;
    if ((this.inFlightRequests.get(sessionId) ?? 0) > 0) return false;
    if ((latest.state ?? "ready") !== "ready") return false;

    await this.closeSession(sessionId);
    return true;
  }

  async closeSessionsForAgent(agentId: string): Promise<number> {
    const sessionIds = this.getEntriesByAgentId(agentId).map(([sessionId]) => sessionId);
    await Promise.all(sessionIds.map((sessionId) => this.closeSession(sessionId)));
    return sessionIds.length;
  }

  count(): number {
    return this.sessions.size;
  }

  startIdleSweep(
    onExpired: (
      sessionId: string,
      session: McpSession,
    ) => void | Promise<void>,
  ): void {
    if (this.sweepTimer) return;
    const idleTtlMs = currentIdleTtlMs();

    this.sweepTimer = setInterval(async () => {
      const now = Date.now();
      for (const [sessionId, session] of this.sessions) {
        if (now - session.lastActivityAt.getTime() <= idleTtlMs) {
          continue;
        }
        if ((this.inFlightRequests.get(sessionId) ?? 0) > 0) {
          continue;
        }

        try {
          await onExpired(sessionId, session);
        } catch (error) {
          console.error("MCP idle session sweep failed", {
            sessionId,
            error,
          });
        }
      }
    }, SWEEP_INTERVAL_MS);
  }

  stopIdleSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private bumpVersion(sessionId: string): void {
    const current = this.versions.get(sessionId);
    if (current === undefined) return;
    this.versions.set(sessionId, current + 1);
  }
}

export const sessionStore = new SessionStore();
