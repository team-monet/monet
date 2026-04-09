import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentContext } from "../middleware/context";

export class SessionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLimitError";
  }
}

const IDLE_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SESSIONS_PER_AGENT = 5;
const MAX_TOTAL_SESSIONS = 1000;

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  agentContext: AgentContext;
  tenantId?: string;
  tenantSlug?: string;
  tenantSchemaName: string;
  connectedAt: Date;
  lastActivityAt: Date;
}

export class SessionStore {
  private sessions = new Map<string, McpSession>();
  private sweepTimer: NodeJS.Timeout | null = null;

  add(sessionId: string, session: McpSession): void {
    if (this.sessions.size >= MAX_TOTAL_SESSIONS) {
      throw new SessionLimitError("Total session limit reached");
    }
    const agentSessionCount = this.getByAgentId(session.agentContext.id).length;
    if (agentSessionCount >= MAX_SESSIONS_PER_AGENT) {
      throw new SessionLimitError("Per-agent session limit reached");
    }
    this.sessions.set(sessionId, session);
  }

  get(sessionId: string): McpSession | undefined {
    return this.sessions.get(sessionId);
  }

  getAll(): Array<[string, McpSession]> {
    return Array.from(this.sessions.entries());
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastActivityAt = new Date();
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

    this.sessions.delete(sessionId);
    await Promise.allSettled([
      session.transport.close(),
      session.server.close(),
    ]);
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

    this.sweepTimer = setInterval(async () => {
      const now = Date.now();
      for (const [sessionId, session] of this.sessions) {
        if (now - session.lastActivityAt.getTime() > IDLE_TTL_MS) {
          await onExpired(sessionId, session);
        }
      }
    }, SWEEP_INTERVAL_MS);
  }

  stopIdleSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

export const sessionStore = new SessionStore();
