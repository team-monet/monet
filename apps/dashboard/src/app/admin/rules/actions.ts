"use server";

import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { ActionState } from "./actions-shared";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

export async function createRuleAction(formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));

  if (!name || !description) {
    return { status: "error", message: "Rule name and description are required" };
  }

  try {
    const client = await getApiClient();
    await client.createRule({ name, description });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create rule";
    return { status: "error", message };
  }

  revalidatePath("/admin/rules");
  return { status: "success", message: "The new rule has been added successfully." };
}

export async function updateRuleAction(formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const ruleId = toSingle(formData.get("ruleId"));
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));

  if (!ruleId || !name || !description) {
    return { status: "error", message: "Rule ID, name, and description are required" };
  }

  try {
    const client = await getApiClient();
    await client.updateRule(ruleId, { name, description });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update rule";
    return { status: "error", message };
  }

  revalidatePath("/admin/rules");
  return { status: "success", message: "Your changes were saved successfully." };
}

export async function createRuleSetAction(formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const name = toSingle(formData.get("name"));

  if (!name) {
    return { status: "error", message: "Rule set name is required" };
  }

  try {
    const client = await getApiClient();
    await client.createRuleSet({ name });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create rule set";
    return { status: "error", message };
  }

  revalidatePath("/admin/rules");
  return { status: "success", message: "The new rule set has been created successfully." };
}

export async function deleteRuleSetAction(formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const returnTo = toSingle(formData.get("returnTo"));

  if (!ruleSetId) {
    return { status: "error", message: "Rule set ID is required" };
  }

  try {
    const client = await getApiClient();
    await client.deleteRuleSet(ruleSetId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete rule set";
    return { status: "error", message };
  }

  revalidatePath("/admin/rules");
  revalidatePath(`/admin/rules/sets/${ruleSetId}`);
  if (returnTo) {
    revalidatePath(returnTo);
  }
  return { status: "success", message: "The rule set has been removed." };
}

export async function addRuleToSetAction(formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const ruleId = toSingle(formData.get("ruleId"));
  const returnTo = toSingle(formData.get("returnTo")) || `/admin/rules/sets/${ruleSetId}`;

  if (!ruleSetId || !ruleId) {
    return { status: "error", message: "Rule set ID and rule ID are required" };
  }

  try {
    const client = await getApiClient();
    await client.addRuleToSet(ruleSetId, ruleId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to add rule to set";
    return { status: "error", message };
  }

  revalidatePath("/admin/rules");
  revalidatePath(`/admin/rules/sets/${ruleSetId}`);
  revalidatePath(returnTo);
  return { status: "success", message: "The rule was added to this set." };
}

export async function removeRuleFromSetAction(formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const ruleId = toSingle(formData.get("ruleId"));
  const returnTo = toSingle(formData.get("returnTo")) || `/admin/rules/sets/${ruleSetId}`;

  if (!ruleSetId || !ruleId) {
    return { status: "error", message: "Rule set ID and rule ID are required" };
  }

  try {
    const client = await getApiClient();
    await client.removeRuleFromSet(ruleSetId, ruleId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to remove rule from set";
    return { status: "error", message };
  }

  revalidatePath("/admin/rules");
  revalidatePath(`/admin/rules/sets/${ruleSetId}`);
  revalidatePath(returnTo);
  return { status: "success", message: "The rule was removed from this set." };
}
