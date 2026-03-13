"use server";

import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

export async function createRuleAction(formData: FormData) {
  await requireAdmin();
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));

  if (!name || !description) {
    redirect("/admin/rules?createError=Rule%20name%20and%20description%20are%20required");
  }

  try {
    const client = await getApiClient();
    await client.createRule({ name, description });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create rule";
    redirect(`/admin/rules?createError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/rules");
  redirect("/admin/rules?created=1");
}

export async function updateRuleAction(formData: FormData) {
  await requireAdmin();
  const ruleId = toSingle(formData.get("ruleId"));
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));

  if (!ruleId || !name || !description) {
    redirect("/admin/rules?updateError=Rule%20ID,%20name,%20and%20description%20are%20required");
  }

  try {
    const client = await getApiClient();
    await client.updateRule(ruleId, { name, description });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update rule";
    redirect(`/admin/rules?updateError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/rules");
  redirect("/admin/rules?updated=1");
}

export async function createRuleSetAction(formData: FormData) {
  await requireAdmin();
  const name = toSingle(formData.get("name"));

  if (!name) {
    redirect("/admin/rules?setError=Rule%20set%20name%20is%20required");
  }

  try {
    const client = await getApiClient();
    await client.createRuleSet({ name });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create rule set";
    redirect(`/admin/rules?setError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/rules");
  redirect("/admin/rules?setCreated=1");
}

export async function deleteRuleSetAction(formData: FormData) {
  await requireAdmin();
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const returnTo = toSingle(formData.get("returnTo")) || "/admin/rules";

  if (!ruleSetId) {
    redirect(`${returnTo}?setError=Rule%20set%20ID%20is%20required`);
  }

  try {
    const client = await getApiClient();
    await client.deleteRuleSet(ruleSetId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete rule set";
    redirect(`${returnTo}?setError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/rules");
  revalidatePath(`/admin/rules/sets/${ruleSetId}`);
  redirect(`${returnTo}?setDeleted=1`);
}

export async function addRuleToSetAction(formData: FormData) {
  await requireAdmin();
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const ruleId = toSingle(formData.get("ruleId"));
  const returnTo = toSingle(formData.get("returnTo")) || `/admin/rules/sets/${ruleSetId}`;

  if (!ruleSetId || !ruleId) {
    redirect(`${returnTo}?setError=Rule%20set%20ID%20and%20rule%20ID%20are%20required`);
  }

  try {
    const client = await getApiClient();
    await client.addRuleToSet(ruleSetId, ruleId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to add rule to set";
    redirect(`${returnTo}?setError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/rules");
  revalidatePath(`/admin/rules/sets/${ruleSetId}`);
  redirect(`${returnTo}?ruleAdded=1`);
}

export async function removeRuleFromSetAction(formData: FormData) {
  await requireAdmin();
  const ruleSetId = toSingle(formData.get("ruleSetId"));
  const ruleId = toSingle(formData.get("ruleId"));
  const returnTo = toSingle(formData.get("returnTo")) || `/admin/rules/sets/${ruleSetId}`;

  if (!ruleSetId || !ruleId) {
    redirect(`${returnTo}?setError=Rule%20set%20ID%20and%20rule%20ID%20are%20required`);
  }

  try {
    const client = await getApiClient();
    await client.removeRuleFromSet(ruleSetId, ruleId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to remove rule from set";
    redirect(`${returnTo}?setError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/rules");
  revalidatePath(`/admin/rules/sets/${ruleSetId}`);
  redirect(`${returnTo}?ruleRemoved=1`);
}
