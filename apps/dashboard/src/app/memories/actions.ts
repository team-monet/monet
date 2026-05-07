"use server";

import { getApiClient } from "@/lib/api-client";
import { revalidatePath } from "next/cache";
import type { MemoryMutationActionState } from "./actions-shared";

export async function searchMemoriesAction(query: string, limit?: number, cursor?: string, groupId?: string) {
  const client = await getApiClient();
  // MonetApiClient.listMemories handles all params now
  return client.listMemories({ query, limit, cursor, groupId });
}

export async function listGroupsAction() {
  const client = await getApiClient();
  return client.listGroups();
}

export async function deleteMemoryAction(
  formData: FormData,
): Promise<MemoryMutationActionState> {
  const id = formData.get("id");
  if (typeof id !== "string" || !id) {
    return { status: "error", message: "Missing memory id" };
  }

  try {
    const client = await getApiClient();
    await client.deleteMemoryEntry(id);
    revalidatePath(`/memories/${id}`);
    revalidatePath("/memories");
  } catch (error: unknown) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Failed to delete memory",
    } satisfies MemoryMutationActionState;
  }

  return { status: "success", message: "Memory deleted" };
}

export async function markMemoryOutdatedAction(
  formData: FormData,
): Promise<MemoryMutationActionState> {
  const id = formData.get("id");
  if (typeof id !== "string" || !id) {
    return { status: "error", message: "Missing memory id" };
  }

  try {
    const client = await getApiClient();
    await client.markMemoryOutdated(id);
    revalidatePath(`/memories/${id}`);
    revalidatePath("/memories");
  } catch (error: unknown) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Failed to mark memory as outdated",
    } satisfies MemoryMutationActionState;
  }

  return { status: "success", message: "Memory marked as outdated" };
}

export async function promoteMemoryScopeAction(
  formData: FormData,
): Promise<MemoryMutationActionState> {
  const id = formData.get("id");
  const scope = formData.get("scope");
  if (typeof id !== "string" || !id) {
    return { status: "error", message: "Missing memory id" };
  }
  if (scope !== "private" && scope !== "user" && scope !== "group") {
    return { status: "error", message: "Invalid promotion scope" };
  }

  try {
    const client = await getApiClient();
    await client.promoteMemoryScope(id, scope);
    revalidatePath(`/memories/${id}`);
    revalidatePath("/memories");
  } catch (error: unknown) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Failed to promote memory scope",
    } satisfies MemoryMutationActionState;
  }

  return { status: "success", message: `Memory promoted to ${scope} scope` };
}
