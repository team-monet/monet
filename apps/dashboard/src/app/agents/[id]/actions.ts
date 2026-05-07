"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { getApiClient } from "@/lib/api-client";
import { buildMcpConfig, resolvePublicMcpUrl } from "@/lib/agent-connection";
import { updateDashboardCredentialIfOwnedAgent } from "@/lib/dashboard-agent";
import type { AgentTokenActionState, AgentMutationActionState, RuleSetMutationActionState } from "./actions-shared";

interface SessionUser {
  id?: string;
  tenantId?: string;
}

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function revalidateAgentPaths(agentId: string) {
  revalidatePath("/agents");
  revalidatePath(`/agents/${agentId}`);
}

export async function regenerateAgentTokenAction(
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
    const session = await auth();
    const sessionUser = session?.user as SessionUser | undefined;
    const client = await getApiClient();
    const result = await client.regenerateAgentToken(agentId);

    if (sessionUser?.id && sessionUser?.tenantId) {
      try {
        await updateDashboardCredentialIfOwnedAgent(
          sessionUser.id,
          sessionUser.tenantId,
          agentId,
          result.apiKey,
        );
      } catch (credentialSyncError: unknown) {
        console.error("Failed to sync dashboard-owned agent credential after token rotation", {
          agentId,
          userId: sessionUser.id,
          tenantId: sessionUser.tenantId,
          error: credentialSyncError,
        });
      }
    }

    revalidateAgentPaths(agentId);

    const mcpUrl = await resolvePublicMcpUrl(client.getTenantSlug());
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
  } catch (err: unknown) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Failed to revoke agent.",
    };
  }
  revalidateAgentPaths(agentId);
  return {
    status: "success",
    message: "Agent revoked.",
  };
}

export async function unrevokeAgentAction(
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
  } catch (err: unknown) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Failed to restore agent.",
    };
  }
  revalidateAgentPaths(agentId);
  return {
    status: "success",
    message: "Agent restored.",
  };
}

export async function attachRuleSetToAgentAction(
  formData: FormData,
): Promise<RuleSetMutationActionState> {
  const agentId = toSingle(formData.get("agentId"));
  const ruleSetId = toSingle(formData.get("ruleSetId"));

  if (!agentId || !ruleSetId) {
    return {
      status: "error",
      message: "Agent ID and rule set ID are required.",
    };
  }

  try {
    const client = await getApiClient();
    await client.attachRuleSetToAgent(agentId, ruleSetId);
  } catch (err: unknown) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Failed to attach rule set.",
    };
  }

  revalidateAgentPaths(agentId);
  return {
    status: "success",
    message: "The selected rule set is now attached to this agent.",
  };
}

export async function detachRuleSetFromAgentAction(
  formData: FormData,
): Promise<RuleSetMutationActionState> {
  const agentId = toSingle(formData.get("agentId"));
  const ruleSetId = toSingle(formData.get("ruleSetId"));

  if (!agentId || !ruleSetId) {
    return {
      status: "error",
      message: "Agent ID and rule set ID are required.",
    };
  }

  try {
    const client = await getApiClient();
    await client.detachRuleSetFromAgent(agentId, ruleSetId);
  } catch (err: unknown) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Failed to detach rule set.",
    };
  }

  revalidateAgentPaths(agentId);
  return {
    status: "success",
    message: "The rule set was removed from this agent.",
  };
}
