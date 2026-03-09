import { and, eq, isNull } from "drizzle-orm";
import {
  humanUsers,
  tenantAdminNominations,
} from "@monet/db";
import { db } from "./db";
import { ensureDashboardAgent } from "./dashboard-agent";
import { ensureDefaultUserGroupMembership } from "./user-groups";

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || "";
}

type UpsertTenantUserFromLoginInput = {
  tenantId: string;
  externalId: string;
  email?: string | null;
  emailVerified: boolean;
};

export async function upsertTenantUserFromLogin(
  input: UpsertTenantUserFromLoginInput,
) {
  const normalizedEmail = normalizeEmail(input.email);
  const now = new Date();

  let [dbUser] = await db
    .select()
    .from(humanUsers)
    .where(
      and(
        eq(humanUsers.tenantId, input.tenantId),
        eq(humanUsers.externalId, input.externalId),
      ),
    )
    .limit(1);

  const [nomination] = normalizedEmail
    ? await db
        .select()
        .from(tenantAdminNominations)
        .where(
          and(
            eq(tenantAdminNominations.tenantId, input.tenantId),
            eq(tenantAdminNominations.email, normalizedEmail),
            isNull(tenantAdminNominations.revokedAt),
          ),
        )
        .limit(1)
    : [];

  const canClaimNomination =
    Boolean(nomination) &&
    input.emailVerified &&
    (!nomination!.claimedByHumanUserId ||
      nomination!.claimedByHumanUserId === dbUser?.id);

  if (!dbUser) {
    const [newUser] = await db
      .insert(humanUsers)
      .values({
        externalId: input.externalId,
        tenantId: input.tenantId,
        email: normalizedEmail || null,
        role: canClaimNomination ? "tenant_admin" : "user",
        lastLoginAt: now,
      })
      .returning();
    dbUser = newUser;
  } else {
    const desiredRole =
      canClaimNomination && dbUser.role !== "tenant_admin"
        ? "tenant_admin"
        : dbUser.role;

    const [updatedUser] = await db
      .update(humanUsers)
      .set({
        email: normalizedEmail || null,
        role: desiredRole,
        lastLoginAt: now,
      })
      .where(eq(humanUsers.id, dbUser.id))
      .returning();
    dbUser = updatedUser;
  }

  if (
    canClaimNomination &&
    nomination &&
    nomination.claimedByHumanUserId !== dbUser.id
  ) {
    await db
      .update(tenantAdminNominations)
      .set({
        claimedByHumanUserId: dbUser.id,
        claimedAt: nomination.claimedAt ?? now,
      })
      .where(eq(tenantAdminNominations.id, nomination.id));
  }

  await ensureDefaultUserGroupMembership(dbUser.tenantId, dbUser.id);
  await ensureDashboardAgent(dbUser.id, dbUser.externalId, dbUser.tenantId);
  return dbUser;
}
