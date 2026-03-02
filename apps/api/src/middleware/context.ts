import type { Env } from "hono";
import type { Database } from "@monet/db";
import type postgres from "postgres";

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
    agent: AgentContext;
    tenantId: string;
    tenantSchemaName: string;
    db: Database;
    sql: postgres.Sql;
  };
}
