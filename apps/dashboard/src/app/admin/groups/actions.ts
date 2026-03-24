"use server";

import { getApiClient } from "@/lib/api-client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function parseOptionalPositiveInt(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return Number.NaN;
  return parsed;
}

function groupDetailPath(groupId: string) {
  return `/admin/groups/${groupId}`;
}

export async function createGroupAction(formData: FormData) {
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));
  const memoryQuotaInput = toSingle(formData.get("memoryQuota"));
  const memoryQuota = parseOptionalPositiveInt(memoryQuotaInput);

  if (!name) {
    redirect("/admin/groups?createError=Group%20name%20is%20required");
  }
  if (Number.isNaN(memoryQuota)) {
    redirect("/admin/groups?createError=Memory%20quota%20must%20be%20a%20positive%20integer");
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
    redirect(`/admin/groups?createError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/groups");
  revalidatePath("/admin/quotas");
  redirect("/admin/groups?created=1");
}

export async function updateGroupAction(formData: FormData) {
  const groupId = toSingle(formData.get("groupId"));
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));
  const memoryQuotaInput = toSingle(formData.get("memoryQuota"));
  const memoryQuota = parseOptionalPositiveInt(memoryQuotaInput);

  if (!groupId || !name) {
    redirect("/admin/groups?updateError=Group%20ID%20and%20name%20are%20required");
  }
  if (Number.isNaN(memoryQuota)) {
    redirect("/admin/groups?updateError=Memory%20quota%20must%20be%20a%20positive%20integer");
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
    redirect(`/admin/groups?updateError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/groups");
  revalidatePath("/admin/quotas");
  redirect("/admin/groups?updated=1");
}

export async function addGroupRuleSetAction(formData: FormData) {
  const groupId = toSingle(formData.get("groupId"));
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const redirectPath = groupId ? groupDetailPath(groupId) : "/admin/groups";

  if (!groupId || !ruleSetId) {
    redirect(`${redirectPath}?ruleSetError=Group%20and%20rule%20set%20are%20required`);
  }

  try {
    const client = await getApiClient();
    await client.addGroupRuleSet(groupId, ruleSetId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to add rule set";
    redirect(`${redirectPath}?ruleSetError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/groups");
  revalidatePath(groupDetailPath(groupId));
  redirect(`${groupDetailPath(groupId)}?ruleSetAdded=1`);
}

export async function removeGroupRuleSetAction(formData: FormData) {
  const groupId = toSingle(formData.get("groupId"));
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const redirectPath = groupId ? groupDetailPath(groupId) : "/admin/groups";

  if (!groupId || !ruleSetId) {
    redirect(`${redirectPath}?ruleSetError=Group%20and%20rule%20set%20are%20required`);
  }

  try {
    const client = await getApiClient();
    await client.removeGroupRuleSet(groupId, ruleSetId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to remove rule set";
    redirect(`${redirectPath}?ruleSetError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/groups");
  revalidatePath(groupDetailPath(groupId));
  redirect(`${groupDetailPath(groupId)}?ruleSetRemoved=1`);
}

export async function addGroupMemberAction(formData: FormData) {
  const groupId = toSingle(formData.get("groupId"));
  const agentId = toSingle(formData.get("agentId"));
  const redirectPath = groupId ? groupDetailPath(groupId) : "/admin/groups";

  if (!groupId || !agentId) {
    redirect(`${redirectPath}?memberError=Group%20and%20agent%20are%20required`);
  }

  try {
    const client = await getApiClient();
    await client.addGroupMember(groupId, agentId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to add member";
    redirect(`${redirectPath}?memberError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/groups");
  revalidatePath(groupDetailPath(groupId));
  revalidatePath("/agents");
  redirect(`${groupDetailPath(groupId)}?memberAdded=1`);
}

export async function removeGroupMemberAction(formData: FormData) {
  const groupId = toSingle(formData.get("groupId"));
  const agentId = toSingle(formData.get("agentId"));
  const redirectPath = groupId ? groupDetailPath(groupId) : "/admin/groups";

  if (!groupId || !agentId) {
    redirect(`${redirectPath}?memberError=Group%20and%20agent%20are%20required`);
  }

  try {
    const client = await getApiClient();
    await client.removeGroupMember(groupId, agentId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to remove member";
    redirect(`${redirectPath}?memberError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/groups");
  revalidatePath(groupDetailPath(groupId));
  revalidatePath("/agents");
  redirect(`${groupDetailPath(groupId)}?memberRemoved=1`);
}
