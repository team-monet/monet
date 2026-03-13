"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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

function agentDetailPath(agentId: string) {
  return `/agents/${agentId}`;
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

    const mcpUrl = await resolvePublicMcpUrl();
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

export async function attachRuleSetToAgentAction(formData: FormData) {
  const agentId = toSingle(formData.get("agentId"));
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const returnTo = toSingle(formData.get("returnTo")) || agentDetailPath(agentId);

  if (!agentId || !ruleSetId) {
    redirect(`${returnTo}?ruleSetError=Agent%20ID%20and%20rule%20set%20ID%20are%20required`);
  }

  try {
    const client = await getApiClient();
    await client.attachRuleSetToAgent(agentId, ruleSetId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to attach rule set.";
    redirect(`${returnTo}?ruleSetError=${encodeURIComponent(message)}`);
  }

  revalidateAgentPaths(agentId);
  redirect(`${returnTo}?ruleSetAttached=1`);
}

export async function detachRuleSetFromAgentAction(formData: FormData) {
  const agentId = toSingle(formData.get("agentId"));
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const returnTo = toSingle(formData.get("returnTo")) || agentDetailPath(agentId);

  if (!agentId || !ruleSetId) {
    redirect(`${returnTo}?ruleSetError=Agent%20ID%20and%20rule%20set%20ID%20are%20required`);
  }

  try {
    const client = await getApiClient();
    await client.detachRuleSetFromAgent(agentId, ruleSetId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to detach rule set.";
    redirect(`${returnTo}?ruleSetError=${encodeURIComponent(message)}`);
  }

  revalidateAgentPaths(agentId);
  redirect(`${returnTo}?ruleSetDetached=1`);
}
