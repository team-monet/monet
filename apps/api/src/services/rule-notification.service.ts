import type postgres from "postgres";
import type { SessionStore } from "../mcp/session-store";
import { getActiveRulesForAgent } from "./rule.service";

export async function pushRulesToAgent(
  agentId: string,
  sessionStore: SessionStore,
  sql: postgres.Sql,
  schemaName: string,
): Promise<void> {
  const sessions = sessionStore.getByAgentId(agentId);
  if (sessions.length === 0) {
    return;
  }

  const rules = await getActiveRulesForAgent(sql, schemaName, agentId);

  await Promise.allSettled(
    sessions.map(async (session) => {
      await session.server.server.notification({
        method: "notifications/rules/updated",
        params: { rules },
      });
    }),
  );
}
