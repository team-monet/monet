import { db } from "../src/lib/db";
import { humanUsers, tenants } from "@monet/db";
import { eq } from "drizzle-orm";

export async function getDevBypassUser() {
  if (process.env.NODE_ENV !== "development" || process.env.DEV_BYPASS_AUTH !== "true") {
    return null;
  }

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, "test-org"))
    .limit(1);

  if (!tenant) {
    console.warn("Dev bypass: Test Org not found. Run seed-test-data.ts first.");
    return null;
  }

  const [user] = await db
    .select()
    .from(humanUsers)
    .where(eq(humanUsers.tenantId, tenant.id))
    .limit(1);

  if (!user) {
    console.warn("Dev bypass: Test user not found in Test Org.");
    return null;
  }

  return {
    id: user.id,
    externalId: user.externalId,
    tenantId: tenant.id,
    role: user.role,
  };
}

export const devBypassProvider = {
  id: "dev-bypass",
  name: "Dev Bypass",
  type: "credentials" as const,
  credentials: {
    orgSlug: { label: "Organization Slug", type: "text" },
  },
  async authorize(credentials: any) {
    if (credentials?.orgSlug === "test-org") {
      const user = await getDevBypassUser();
      if (user) {
        return {
          id: user.externalId, // NextAuth uses user.id for the external ID usually
          tenantId: user.tenantId,
          role: user.role,
          name: "Test User",
          email: "test@example.com",
        };
      }
    }
    return null;
  },
};
