"use server";

import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { QuotaActionState } from "./actions-shared";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

export async function updateGroupQuotaAction(
  formData: FormData,
): Promise<QuotaActionState> {
  await requireAdmin();
  const groupId = toSingle(formData.get("groupId"));
  const quotaInput = toSingle(formData.get("quota"));
  const quota = Number(quotaInput);

  if (!groupId) {
    return { status: "error", message: "Group ID is required" };
  }

  if (!quotaInput || !Number.isInteger(quota) || quota < 0) {
    return {
      status: "error",
      message: "Quota must be a non-negative integer (0 = unlimited)",
    };
  }

  try {
    const client = await getApiClient();
    await client.updateGroup(groupId, { memoryQuota: quota });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update quota";
    return { status: "error", message };
  }

  revalidatePath("/admin/quotas");
  revalidatePath("/admin/groups");
  return { status: "success", message: "Quota updated successfully." };
}

export async function clearGroupQuotaAction(
  formData: FormData,
): Promise<QuotaActionState> {
  await requireAdmin();
  const groupId = toSingle(formData.get("groupId"));

  if (!groupId) {
    return { status: "error", message: "Group ID is required" };
  }

  try {
    const client = await getApiClient();
    await client.updateGroup(groupId, { memoryQuota: 0 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to clear quota";
    return { status: "error", message };
  }

  revalidatePath("/admin/quotas");
  revalidatePath("/admin/groups");
  return { status: "success", message: "Quota cleared successfully." };
}
