"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { getApiClient } from "@/lib/api-client";

const MAX_INSTRUCTIONS_LENGTH = 4000;

export async function getTenantSettingsAction() {
  await requireAdmin();
  const client = await getApiClient();
  return client.getTenantSettings();
}

export async function updateTenantSettingsAction(
  formData: FormData,
): Promise<{ status: "idle" | "success" | "error"; message: string }> {
  await requireAdmin();
  const rawInstructions = formData.get("tenantAgentInstructions");
  const tenantAgentInstructions =
    typeof rawInstructions === "string" ? rawInstructions : "";

  if (tenantAgentInstructions.length > MAX_INSTRUCTIONS_LENGTH) {
    return {
      status: "error",
      message: `Instructions must be ${MAX_INSTRUCTIONS_LENGTH} characters or fewer.`,
    };
  }

  try {
    const client = await getApiClient();
    await client.updateTenantSettings({ tenantAgentInstructions });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to update tenant settings";
    return { status: "error", message };
  }

  revalidatePath("/admin/settings");
  return {
    status: "success",
    message: "Your instruction changes were saved successfully.",
  };
}
