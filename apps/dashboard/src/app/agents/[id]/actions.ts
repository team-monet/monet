"use server";

import { revalidatePath } from "next/cache";
import { getApiClient } from "@/lib/api-client";
import { buildMcpConfig, resolvePublicMcpUrl } from "@/lib/agent-connection";
import type { AgentTokenActionState, AgentMutationActionState } from "./actions-shared";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function revalidateAgentPaths(agentId: string) {
  revalidatePath("/agents");
  revalidatePath(`/agents/${agentId}`);
}

export async function regenerateAgentTokenAction(
  _previousState: AgentTokenActionState,
  formData: FormData,
): Promise<AgentTokenActionState> {
  const agentId = toSingle(formData.get("agentId"));

  if (!agentId) {
    return {
      status: "error",
      message: "Agent ID is required.",
    };
  }

  try {
    const client = await getApiClient();
    const result = await client.regenerateAgentToken(agentId);
    revalidateAgentPaths(agentId);

    const mcpUrl = resolvePublicMcpUrl();
    return {
      status: "success",
      message: "Agent token regenerated.",
      apiKey: result.apiKey,
      mcpUrl,
      mcpConfig: buildMcpConfig(result.apiKey, mcpUrl),
    };
  } catch (err: unknown) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Failed to regenerate agent token.",
    };
  }
}

export async function revokeAgentAction(
  _previousState: AgentMutationActionState,
  formData: FormData,
): Promise<AgentMutationActionState> {
  const agentId = toSingle(formData.get("agentId"));

  if (!agentId) {
    return {
      status: "error",
      message: "Agent ID is required.",
    };
  }

  try {
    const client = await getApiClient();
    await client.revokeAgent(agentId);
    revalidateAgentPaths(agentId);
    return {
      status: "success",
      message: "Agent revoked.",
    };
  } catch (err: unknown) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Failed to revoke agent.",
    };
  }
}

export async function unrevokeAgentAction(
  _previousState: AgentMutationActionState,
  formData: FormData,
): Promise<AgentMutationActionState> {
  const agentId = toSingle(formData.get("agentId"));

  if (!agentId) {
    return {
      status: "error",
      message: "Agent ID is required.",
    };
  }

  try {
    const client = await getApiClient();
    await client.unrevokeAgent(agentId);
    revalidateAgentPaths(agentId);
    return {
      status: "success",
      message: "Agent restored.",
    };
  } catch (err: unknown) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Failed to restore agent.",
    };
  }
}
