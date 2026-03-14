"use server";

import { getApiClient } from "@/lib/api-client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function revalidateRulePaths(ruleSetId?: string) {
  revalidatePath("/rules");
  if (ruleSetId) {
    revalidatePath(`/rules/sets/${ruleSetId}`);
  }
}

export async function createPersonalRuleAction(formData: FormData) {
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));

  if (!name || !description) {
    redirect("/rules?createError=Rule%20name%20and%20description%20are%20required");
  }

  try {
    const client = await getApiClient();
    await client.createPersonalRule({ name, description });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create rule";
    redirect(`/rules?createError=${encodeURIComponent(message)}`);
  }

  revalidateRulePaths();
  redirect("/rules?created=1");
}

export async function updatePersonalRuleAction(formData: FormData) {
  const ruleId = toSingle(formData.get("ruleId"));
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));

  if (!ruleId || !name || !description) {
    redirect("/rules?updateError=Rule%20ID,%20name,%20and%20description%20are%20required");
  }

  try {
    const client = await getApiClient();
    await client.updatePersonalRule(ruleId, { name, description });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update rule";
    redirect(`/rules?updateError=${encodeURIComponent(message)}`);
  }

  revalidateRulePaths();
  redirect("/rules?updated=1");
}

export async function deletePersonalRuleAction(formData: FormData) {
  const ruleId = toSingle(formData.get("ruleId"));
  const returnTo = toSingle(formData.get("returnTo")) || "/rules";

  if (!ruleId) {
    redirect(`${returnTo}?deleteError=Rule%20ID%20is%20required`);
  }

  try {
    const client = await getApiClient();
    await client.deletePersonalRule(ruleId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete rule";
    redirect(`${returnTo}?deleteError=${encodeURIComponent(message)}`);
  }

  revalidateRulePaths();
  redirect(`${returnTo}?deleted=1`);
}

export async function createPersonalRuleSetAction(formData: FormData) {
  const name = toSingle(formData.get("name"));

  if (!name) {
    redirect("/rules?setError=Rule%20set%20name%20is%20required");
  }

  try {
    const client = await getApiClient();
    await client.createPersonalRuleSet({ name });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create rule set";
    redirect(`/rules?setError=${encodeURIComponent(message)}`);
  }

  revalidateRulePaths();
  redirect("/rules?setCreated=1");
}

export async function deletePersonalRuleSetAction(formData: FormData) {
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const returnTo = toSingle(formData.get("returnTo")) || "/rules";

  if (!ruleSetId) {
    redirect(`${returnTo}?setError=Rule%20set%20ID%20is%20required`);
  }

  try {
    const client = await getApiClient();
    await client.deletePersonalRuleSet(ruleSetId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete rule set";
    redirect(`${returnTo}?setError=${encodeURIComponent(message)}`);
  }

  revalidateRulePaths(ruleSetId);
  redirect(`${returnTo}?setDeleted=1`);
}

export async function addPersonalRuleToSetAction(formData: FormData) {
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const ruleId = toSingle(formData.get("ruleId"));
  const returnTo = toSingle(formData.get("returnTo")) || `/rules/sets/${ruleSetId}`;

  if (!ruleSetId || !ruleId) {
    redirect(`${returnTo}?setError=Rule%20set%20ID%20and%20rule%20ID%20are%20required`);
  }

  try {
    const client = await getApiClient();
    await client.addPersonalRuleToSet(ruleSetId, ruleId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to add rule to set";
    redirect(`${returnTo}?setError=${encodeURIComponent(message)}`);
  }

  revalidateRulePaths(ruleSetId);
  redirect(`${returnTo}?ruleAdded=1`);
}

export async function removePersonalRuleFromSetAction(formData: FormData) {
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const ruleId = toSingle(formData.get("ruleId"));
  const returnTo = toSingle(formData.get("returnTo")) || `/rules/sets/${ruleSetId}`;

  if (!ruleSetId || !ruleId) {
    redirect(`${returnTo}?setError=Rule%20set%20ID%20and%20rule%20ID%20are%20required`);
  }

  try {
    const client = await getApiClient();
    await client.removePersonalRuleFromSet(ruleSetId, ruleId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to remove rule from set";
    redirect(`${returnTo}?setError=${encodeURIComponent(message)}`);
  }

  revalidateRulePaths(ruleSetId);
  redirect(`${returnTo}?ruleRemoved=1`);
}
