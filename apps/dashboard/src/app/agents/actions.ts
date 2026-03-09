"use server";

import { auth } from "@/lib/auth";
import { getApiClient } from "@/lib/api-client";
import { revalidatePath } from "next/cache";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function resolvePublicMcpUrl() {
  const baseUrl =
    process.env.MCP_BASE_URL ||
    process.env.PUBLIC_API_URL ||
    process.env.API_BASE_URL ||
    process.env.INTERNAL_API_URL ||
    process.env.NEXTAUTH_URL ||
    "http://localhost:3001";

  try {
    return new URL("/mcp", baseUrl).toString();
  } catch {
    return `${baseUrl.replace(/\/$/, "")}/mcp`;
  }
}

export type RegisterAgentFormState =
  | {
      status: "idle";
      message?: string;
    }
  | {
      status: "error";
      message: string;
    }
  | {
      status: "success";
      message: string;
      agentId: string;
      apiKey: string;
      mcpUrl: string;
      mcpConfig: string;
    };

export const initialRegisterAgentFormState: RegisterAgentFormState = {
  status: "idle",
};

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
      message: "A human user must be selected for Human Proxy agents.",
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

    const mcpUrl = resolvePublicMcpUrl();
    const mcpConfig = JSON.stringify(
      {
        mcpServers: {
          monet: {
            url: mcpUrl,
            headers: {
              Authorization: `Bearer ${result.apiKey}`,
            },
          },
        },
      },
      null,
      2,
    );

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
