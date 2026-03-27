"use server";

import { getApiClient } from "@/lib/api-client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

export async function updateGroupQuotaAction(formData: FormData) {
  const groupId = toSingle(formData.get("groupId"));
  const quotaInput = toSingle(formData.get("quota"));
  const quota = Number(quotaInput);

  if (!groupId) {
    redirect("/admin/quotas?updateError=Group%20ID%20is%20required");
  }

  if (!quotaInput || !Number.isInteger(quota) || quota < 0) {
    redirect("/admin/quotas?updateError=Quota%20must%20be%20a%20non-negative%20integer%20(0%20%3D%20unlimited)");
  }

  try {
    const client = await getApiClient();
    await client.updateGroup(groupId, { memoryQuota: quota });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update quota";
    redirect(`/admin/quotas?updateError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/quotas");
  revalidatePath("/admin/groups");
  redirect("/admin/quotas?updated=1");
}

export async function clearGroupQuotaAction(formData: FormData) {
  const groupId = toSingle(formData.get("groupId"));

  if (!groupId) {
    redirect("/admin/quotas?updateError=Group%20ID%20is%20required");
  }

  try {
    const client = await getApiClient();
    await client.updateGroup(groupId, { memoryQuota: 0 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to clear quota";
    redirect(`/admin/quotas?updateError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/quotas");
  revalidatePath("/admin/groups");
  redirect("/admin/quotas?updated=1");
}
