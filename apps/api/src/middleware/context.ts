import type { Env } from "hono";
import type { Database, SqlClient } from "@monet/db";
import type { SessionStore } from "../mcp/session-store";

export interface AgentContext {
  id: string;
  externalId: string;
  tenantId: string;
  isAutonomous: boolean;
  userId: string | null;
  role: string | null;
}

export interface AppEnv extends Env {
  Variables: {
    requestId: string;
    agent: AgentContext;
    tenantId: string;
    tenantSchemaName: string;
    db: Database;
    sql: SqlClient;
    sessionStore: SessionStore;
  };
}
