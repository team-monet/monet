import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentContext } from "../middleware/context";

const IDLE_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  agentContext: AgentContext;
  tenantSchemaName: string;
  connectedAt: Date;
  lastActivityAt: Date;
}

export class SessionStore {
  private sessions = new Map<string, McpSession>();
  private sweepTimer: NodeJS.Timeout | null = null;

  add(sessionId: string, session: McpSession): void {
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
