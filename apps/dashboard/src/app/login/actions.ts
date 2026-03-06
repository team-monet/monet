"use server";

import { db } from "@/lib/db";
import { tenants, tenantOauthConfigs } from "@monet/db";
import { eq } from "drizzle-orm";

type LoginValidationSuccess = {
  success: true;
  provider: "dev-bypass" | "tenant-oauth";
  cookieTenantSlug: string;
  orgSlug?: string;
};

type LoginValidationError = {
  error: string;
};

type LoginValidationResult = LoginValidationSuccess | LoginValidationError;

const TEST_ORG_SLUG = "test-org";
const TEST_ORG_NAME = "Test Org";
const MISSING_RELATION_ERROR_CODE = "42P01";

function isMissingRelationError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === MISSING_RELATION_ERROR_CODE
  );
}

export async function validateTenantAction(slug: string): Promise<LoginValidationResult> {
  const trimmedSlug = slug.trim();
  const normalizedSlug = trimmedSlug.toLowerCase();
  const isTestOrg = normalizedSlug === TEST_ORG_SLUG;
  const isDevBypassEnabled =
    process.env.NODE_ENV === "development" &&
    process.env.DEV_BYPASS_AUTH !== "false";

  if (!trimmedSlug) {
    return { error: "Please enter your organization slug" };
  }

  if (isTestOrg && isDevBypassEnabled) {
    return {
      success: true,
      provider: "dev-bypass",
      cookieTenantSlug: TEST_ORG_SLUG,
      orgSlug: TEST_ORG_SLUG,
    };
  }

  // test-org maps to the seeded tenant name in local development data.
  const searchTerm = isTestOrg ? TEST_ORG_NAME : trimmedSlug;

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.name, searchTerm))
    .limit(1);

  if (!tenant) {
    return { error: "Organization not found" };
  }

  let oauth: { id: string } | undefined;
  try {
    [oauth] = await db
      .select({ id: tenantOauthConfigs.id })
      .from(tenantOauthConfigs)
      .where(eq(tenantOauthConfigs.tenantId, tenant.id))
      .limit(1);
  } catch (error) {
    if (isMissingRelationError(error)) {
      if (isTestOrg) {
        return {
          error:
            "test-org requires development bypass auth. Start with `pnpm --filter @monet/dashboard dev:seeded` or set DEV_BYPASS_AUTH=true.",
        };
      }
      return {
        error:
          "SSO configuration table is missing. Run `pnpm db:migrate` and restart the dashboard.",
      };
    }
    throw error;
  }

  if (!oauth) {
    if (isTestOrg && !isDevBypassEnabled) {
      return {
        error:
          "test-org requires development bypass auth. Start with `pnpm --filter @monet/dashboard dev:seeded` or set DEV_BYPASS_AUTH=true.",
      };
    }
    return { error: "SSO not configured for this organization" };
  }

  return {
    success: true,
    provider: "tenant-oauth",
    cookieTenantSlug: isTestOrg ? TEST_ORG_SLUG : trimmedSlug,
  };
}
