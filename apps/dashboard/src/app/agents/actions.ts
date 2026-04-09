"use server";

import { auth } from "@/lib/auth";
import { getApiClient } from "@/lib/api-client";
import { buildMcpConfig, resolvePublicMcpUrl } from "@/lib/agent-connection";
import { revalidatePath } from "next/cache";
import type { RegisterAgentFormState } from "./actions-shared";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

export async function getAgentStatusAction(id: string) {
  const client = await getApiClient();
  return client.getAgentStatus(id);
}

export async function registerAgentAction(
  _previousState: RegisterAgentFormState,
  formData: FormData,
): Promise<RegisterAgentFormState> {
  const name = toSingle(formData.get("name"));
  const groupId = toSingle(formData.get("groupId"));
  const type = toSingle(formData.get("type"));
  const selectedUserId = toSingle(formData.get("userId"));
  const session = await auth();
  const sessionUser = session?.user as { role?: string } | undefined;
  const isAdmin = sessionUser?.role === "tenant_admin";

  if (!name) {
    return {
      status: "error",
      message: "Agent name is required.",
    };
  }

  if (!groupId) {
    return {
      status: "error",
      message: "A group must be selected.",
    };
  }

  const isAutonomous = isAdmin && type === "autonomous";
  const userId = isAdmin && !isAutonomous ? selectedUserId : undefined;

  if (isAdmin && !isAutonomous && !userId) {
    return {
      status: "error",
      message: "A user must be selected for User Proxy agents.",
    };
  }

  try {
    const client = await getApiClient();
    const result = await client.registerAgent({
      externalId: name,
      groupId,
      isAutonomous,
      userId,
    });

    revalidatePath("/agents");
    revalidatePath(`/agents/${result.agent.id}`);

    const mcpUrl = await resolvePublicMcpUrl(client.getTenantSlug());
    const mcpConfig = buildMcpConfig(result.apiKey, mcpUrl);

    return {
      status: "success",
      message: "Agent registered.",
      agentId: result.agent.id,
      apiKey: result.apiKey,
      mcpUrl,
      mcpConfig,
    };
  } catch (err: unknown) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Failed to register agent.",
    };
  }
}
