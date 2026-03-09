import type { Agent } from "@monet/types";

type AgentDisplayInput = Pick<Agent, "displayName" | "externalId" | "isAutonomous" | "owner">;

export function formatAgentDisplayName(agent: AgentDisplayInput) {
  if (agent.displayName) {
    return agent.displayName;
  }

  if (agent.isAutonomous) {
    return `${agent.externalId} (Autonomous)`;
  }

  if (agent.owner?.label) {
    return `${agent.externalId} · ${agent.owner.label}`;
  }

  return agent.externalId;
}
