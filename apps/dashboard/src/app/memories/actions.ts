"use server";

import { getApiClient } from "@/lib/api-client";
import { revalidatePath } from "next/cache";
import { MemoryScope } from "@monet/types";

export async function searchMemoriesAction(query: string, limit?: number, cursor?: string) {
  const client = await getApiClient();
  // MonetApiClient.listMemories handles all params now
  return client.listMemories({ query, limit, cursor });
}

export async function deleteMemoryAction(id: string) {
  const client = await getApiClient();
  await client.deleteMemoryEntry(id);
  revalidatePath("/memories");
}

export async function markMemoryOutdatedAction(id: string) {
  const client = await getApiClient();
  // We need to add markOutdated to MonetApiClient or use a generic update
  // The API has PATCH /api/memories/:id/outdated
  // I'll add it to MonetApiClient
  await client.markMemoryOutdated(id);
  revalidatePath(`/memories/${id}`);
  revalidatePath("/memories");
}

export async function promoteMemoryScopeAction(id: string, scope: MemoryScope) {
  const client = await getApiClient();
  await client.promoteMemoryScope(id, scope);
  revalidatePath(`/memories/${id}`);
  revalidatePath("/memories");
}
