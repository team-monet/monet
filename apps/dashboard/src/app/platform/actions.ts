"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  CreateTenantInput,
  normalizeTenantSlug,
  slugifyTenantName,
} from "@monet/types";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  createPlatformTenant,
  saveTenantOidcConfig,
} from "@/lib/platform-tenants";

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function tenantDetailPath(tenantId: string) {
  return `/platform/tenants/${tenantId}`;
}

function firstFieldError(
  fieldErrors: Record<string, string[] | undefined>,
  ...keys: string[]
) {
  for (const key of keys) {
    const message = fieldErrors[key]?.[0];
    if (message) {
      return message;
    }
  }

  return "Invalid input.";
}

export async function createPlatformTenantAction(formData: FormData) {
  await requirePlatformAdmin();

  const name = toSingle(formData.get("name"));
  const slugInput = toSingle(formData.get("slug"));
  const isolationMode = toSingle(formData.get("isolationMode")) || "logical";
  const slug = slugInput ? normalizeTenantSlug(slugInput) : slugifyTenantName(name);

  const parsed = CreateTenantInput.safeParse({
    name,
    slug,
    isolationMode,
  });

  if (!parsed.success) {
    const message = firstFieldError(
      parsed.error.flatten().fieldErrors,
      "name",
      "slug",
      "isolationMode",
    );
    redirect(`/platform?createError=${encodeURIComponent(message)}`);
  }

  try {
    const result = await createPlatformTenant(parsed.data);
    revalidatePath("/platform");
    redirect(`${tenantDetailPath(result.tenant.id)}?created=1`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create tenant";
    redirect(`/platform?createError=${encodeURIComponent(message)}`);
  }
}

export async function saveTenantOidcConfigAction(formData: FormData) {
  await requirePlatformAdmin();

  const tenantId = toSingle(formData.get("tenantId"));
  const issuer = toSingle(formData.get("issuer"));
  const clientId = toSingle(formData.get("clientId"));
  const clientSecret = toSingle(formData.get("clientSecret"));

  if (!tenantId) {
    redirect("/platform?configError=Tenant%20ID%20is%20required");
  }

  try {
    await saveTenantOidcConfig({
      tenantId,
      issuer,
      clientId,
      clientSecret,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save tenant OIDC configuration";
    redirect(
      `${tenantDetailPath(tenantId)}?configError=${encodeURIComponent(message)}`,
    );
  }

  revalidatePath("/platform");
  revalidatePath(tenantDetailPath(tenantId));
  redirect(`${tenantDetailPath(tenantId)}?oidcSaved=1`);
}
