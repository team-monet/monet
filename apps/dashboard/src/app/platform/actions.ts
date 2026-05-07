"use server";

import { revalidatePath } from "next/cache";
import {
  CreateTenantInput,
  normalizeTenantSlug,
  slugifyTenantName,
} from "@monet/types";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  createPlatformTenant,
  saveTenantAdminNomination,
  saveTenantOidcConfig,
} from "@/lib/platform-tenants";
import type { PlatformActionState } from "./actions-shared";

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

export async function createPlatformTenantAction(
  formData: FormData,
): Promise<PlatformActionState> {
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
    return { status: "error", message };
  }

  try {
    const result = await createPlatformTenant(parsed.data);
    revalidatePath("/platform");
    revalidatePath(tenantDetailPath(result.tenant.id));
    return {
      status: "success",
      message: `Tenant "${result.tenant.name}" created successfully.`,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create tenant";
    return { status: "error", message };
  }
}

export async function saveTenantOidcConfigAction(
  formData: FormData,
): Promise<PlatformActionState> {
  await requirePlatformAdmin();

  const tenantId = toSingle(formData.get("tenantId"));
  const issuer = toSingle(formData.get("issuer"));
  const clientId = toSingle(formData.get("clientId"));
  const clientSecret = toSingle(formData.get("clientSecret"));

  if (!tenantId) {
    return { status: "error", message: "Tenant ID is required" };
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
    return { status: "error", message };
  }

  revalidatePath("/platform");
  revalidatePath(tenantDetailPath(tenantId));
  return { status: "success", message: "Tenant OIDC configuration saved." };
}

export async function saveTenantAdminNominationAction(
  formData: FormData,
): Promise<PlatformActionState> {
  const session = await requirePlatformAdmin();
  const sessionUser = session.user as { id?: string };

  const tenantId = toSingle(formData.get("tenantId"));
  const email = toSingle(formData.get("email"));

  if (!tenantId) {
    return { status: "error", message: "Tenant ID is required" };
  }

  if (!email) {
    return { status: "error", message: "Admin email is required." };
  }

  if (!sessionUser.id) {
    return {
      status: "error",
      message: "Platform admin session is invalid.",
    };
  }

  try {
    await saveTenantAdminNomination({
      tenantId,
      email,
      createdByPlatformAdminId: sessionUser.id,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save tenant admin nomination";
    return { status: "error", message };
  }

  revalidatePath(tenantDetailPath(tenantId));
  return { status: "success", message: "Tenant admin nomination saved." };
}
