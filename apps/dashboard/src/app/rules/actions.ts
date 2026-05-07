"use server";

import { getApiClient } from "@/lib/api-client";
import { revalidatePath } from "next/cache";
import type { ActionState } from "./actions-shared";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function revalidateRulePaths(ruleSetId?: string) {
  revalidatePath("/rules");
  if (ruleSetId) {
    revalidatePath(`/rules/sets/${ruleSetId}`);
  }
}

export async function createPersonalRuleAction(formData: FormData): Promise<ActionState> {
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));

  if (!name || !description) {
    return { status: "error", message: "Rule name and description are required" };
  }

  try {
    const client = await getApiClient();
    await client.createPersonalRule({ name, description });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create rule";
    return { status: "error", message };
  }

  revalidateRulePaths();
  return { status: "success", message: "Your personal rule has been added." };
}

export async function updatePersonalRuleAction(formData: FormData): Promise<ActionState> {
  const ruleId = toSingle(formData.get("ruleId"));
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));

  if (!ruleId || !name || !description) {
    return { status: "error", message: "Rule ID, name, and description are required" };
  }

  try {
    const client = await getApiClient();
    await client.updatePersonalRule(ruleId, { name, description });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update rule";
    return { status: "error", message };
  }

  revalidateRulePaths();
  return { status: "success", message: "Your changes were saved successfully." };
}

export async function deletePersonalRuleAction(formData: FormData): Promise<ActionState> {
  const ruleId = toSingle(formData.get("ruleId"));
  const returnTo = toSingle(formData.get("returnTo")) || "/rules";

  if (!ruleId) {
    return { status: "error", message: "Rule ID is required" };
  }

  try {
    const client = await getApiClient();
    await client.deletePersonalRule(ruleId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete rule";
    return { status: "error", message };
  }

  revalidateRulePaths();
  revalidatePath(returnTo);
  return { status: "success", message: "The personal rule has been removed." };
}

export async function createPersonalRuleSetAction(formData: FormData): Promise<ActionState> {
  const name = toSingle(formData.get("name"));

  if (!name) {
    return { status: "error", message: "Rule set name is required" };
  }

  try {
    const client = await getApiClient();
    await client.createPersonalRuleSet({ name });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create rule set";
    return { status: "error", message };
  }

  revalidateRulePaths();
  return { status: "success", message: "The personal rule set has been created." };
}

export async function deletePersonalRuleSetAction(formData: FormData): Promise<ActionState> {
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const returnTo = toSingle(formData.get("returnTo")) || "/rules";

  if (!ruleSetId) {
    return { status: "error", message: "Rule set ID is required" };
  }

  try {
    const client = await getApiClient();
    await client.deletePersonalRuleSet(ruleSetId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete rule set";
    return { status: "error", message };
  }

  revalidateRulePaths(ruleSetId);
  revalidatePath(returnTo);
  return { status: "success", message: "The personal rule set has been removed." };
}

export async function addPersonalRuleToSetAction(formData: FormData): Promise<ActionState> {
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const ruleId = toSingle(formData.get("ruleId"));
  const returnTo = toSingle(formData.get("returnTo")) || `/rules/sets/${ruleSetId}`;

  if (!ruleSetId || !ruleId) {
    return { status: "error", message: "Rule set ID and rule ID are required" };
  }

  try {
    const client = await getApiClient();
    await client.addPersonalRuleToSet(ruleSetId, ruleId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to add rule to set";
    return { status: "error", message };
  }

  revalidateRulePaths(ruleSetId);
  revalidatePath(returnTo);
  return { status: "success", message: "The rule was added to this set." };
}

export async function removePersonalRuleFromSetAction(formData: FormData): Promise<ActionState> {
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const ruleId = toSingle(formData.get("ruleId"));
  const returnTo = toSingle(formData.get("returnTo")) || `/rules/sets/${ruleSetId}`;

  if (!ruleSetId || !ruleId) {
    return { status: "error", message: "Rule set ID and rule ID are required" };
  }

  try {
    const client = await getApiClient();
    await client.removePersonalRuleFromSet(ruleSetId, ruleId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to remove rule from set";
    return { status: "error", message };
  }

  revalidateRulePaths(ruleSetId);
  revalidatePath(returnTo);
  return { status: "success", message: "The rule was removed from this set." };
}
