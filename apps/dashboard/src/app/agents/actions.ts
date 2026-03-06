"use server";

import { getApiClient } from "@/lib/api-client";

export async function getAgentStatusAction(id: string) {
  const client = await getApiClient();
  return client.getAgentStatus(id);
}
