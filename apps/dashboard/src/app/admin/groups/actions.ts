"use server";

import { getApiClient } from "@/lib/api-client";
import { revalidatePath } from "next/cache";
import type { GroupActionState, GroupMemberActionState } from "./actions-shared";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function parseOptionalNonNegativeInt(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return Number.NaN;
  return parsed;
}

function groupDetailPath(groupId: string) {
  return `/admin/groups/${groupId}`;
}

export async function createGroupAction(
  formData: FormData,
): Promise<GroupActionState> {
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));
  const memoryQuotaInput = toSingle(formData.get("memoryQuota"));
  const memoryQuota = parseOptionalNonNegativeInt(memoryQuotaInput);

  if (!name) {
    return { status: "error", message: "Group name is required" };
  }
  if (Number.isNaN(memoryQuota)) {
    return {
      status: "error",
      message: "Memory quota must be a non-negative integer (0 = unlimited)",
    };
  }

  try {
    const client = await getApiClient();
    await client.createGroup({
      name,
      description,
      memoryQuota: memoryQuota ?? undefined,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create group";
    return { status: "error", message };
  }

  revalidatePath("/admin/groups");
  revalidatePath("/admin/quotas");
  return { status: "success", message: "The new group has been added successfully." };
}

export async function updateGroupAction(
  formData: FormData,
): Promise<GroupActionState> {
  const groupId = toSingle(formData.get("groupId"));
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));
  const memoryQuotaInput = toSingle(formData.get("memoryQuota"));
  const memoryQuota = parseOptionalNonNegativeInt(memoryQuotaInput);

  if (!groupId || !name) {
    return { status: "error", message: "Group ID and name are required" };
  }
  if (Number.isNaN(memoryQuota)) {
    return {
      status: "error",
      message: "Memory quota must be a non-negative integer (0 = unlimited)",
    };
  }

  try {
    const client = await getApiClient();
    await client.updateGroup(groupId, {
      name,
      description,
      memoryQuota: memoryQuota ?? undefined,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update group";
    return { status: "error", message };
  }

  revalidatePath("/admin/groups");
  revalidatePath("/admin/quotas");
  return { status: "success", message: "Your changes were saved successfully." };
}

export async function addGroupRuleSetAction(
  formData: FormData,
): Promise<GroupActionState> {
  const groupId = toSingle(formData.get("groupId"));
  const ruleSetId = toSingle(formData.get("ruleSetId"));

  if (!groupId || !ruleSetId) {
    return { status: "error", message: "Group and rule set are required" };
  }

  try {
    const client = await getApiClient();
    await client.addGroupRuleSet(groupId, ruleSetId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to add rule set";
    return { status: "error", message };
  }

  revalidatePath("/admin/groups");
  revalidatePath(groupDetailPath(groupId));
  return { status: "success", message: "The rule set was applied to this group." };
}

export async function removeGroupRuleSetAction(
  formData: FormData,
): Promise<GroupActionState> {
  const groupId = toSingle(formData.get("groupId"));
  const ruleSetId = toSingle(formData.get("ruleSetId"));

  if (!groupId || !ruleSetId) {
    return { status: "error", message: "Group and rule set are required" };
  }

  try {
    const client = await getApiClient();
    await client.removeGroupRuleSet(groupId, ruleSetId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to remove rule set";
    return { status: "error", message };
  }

  revalidatePath("/admin/groups");
  revalidatePath(groupDetailPath(groupId));
  return { status: "success", message: "The rule set was removed from this group." };
}

export async function addGroupMemberAction(
  formData: FormData,
): Promise<GroupMemberActionState> {
  const groupId = toSingle(formData.get("groupId"));
  const agentId = toSingle(formData.get("agentId"));

  if (!groupId || !agentId) {
    return { status: "error", message: "Group and agent are required" };
  }

  try {
    const client = await getApiClient();
    await client.addGroupMember(groupId, agentId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to add member";
    return { status: "error", message };
  }

  revalidatePath("/admin/groups");
  revalidatePath(groupDetailPath(groupId));
  revalidatePath("/agents");
  return { status: "success", message: "The agent was added to the group.", action: "add", agentId };
}

export async function removeGroupMemberAction(
  formData: FormData,
): Promise<GroupMemberActionState> {
  const groupId = toSingle(formData.get("groupId"));
  const agentId = toSingle(formData.get("agentId"));

  if (!groupId || !agentId) {
    return { status: "error", message: "Group and agent are required" };
  }

  try {
    const client = await getApiClient();
    await client.removeGroupMember(groupId, agentId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to remove member";
    return { status: "error", message };
  }

  revalidatePath("/admin/groups");
  revalidatePath(groupDetailPath(groupId));
  revalidatePath("/agents");
  return { status: "success", message: "The agent was removed from the group.", action: "remove", agentId };
}
