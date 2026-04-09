import { and, eq, isNull } from "drizzle-orm";
import {
  tenantSchemaNameFromId,
  tenantUsers,
  tenantAdminNominations,
  withTenantDrizzleScope,
} from "@monet/db";
import { db, getSqlClient } from "./db";
import { ensureDashboardAgent } from "./dashboard-agent";
import { ensureDefaultUserGroupMembership } from "./user-groups";

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || "";
}

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

type UpsertTenantUserFromLoginInput = {
  tenantId: string;
  externalId: string;
  displayName?: string | null;
  email?: string | null;
  emailVerified: boolean;
};

export async function upsertTenantUserFromLogin(
  input: UpsertTenantUserFromLoginInput,
) {
  const schemaName = tenantSchemaNameFromId(input.tenantId);
  const normalizedEmail = normalizeEmail(input.email);
  const normalizedDisplayName = normalizeOptionalText(input.displayName);
  const now = new Date();

  let [dbUser] = await withTenantDrizzleScope(getSqlClient(), schemaName, async (tenantDb) => tenantDb
    .select()
    .from(tenantUsers)
    .where(
      and(
        eq(tenantUsers.tenantId, input.tenantId),
        eq(tenantUsers.externalId, input.externalId),
      ),
    )
    .limit(1));

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

  // Some tenant IdPs rotate or remap subject identifiers across reconfiguration.
  // If that happens, fall back to a verified email match so we reuse the
  // existing tenant user record instead of creating duplicates and losing role state.
  if (!dbUser && normalizedEmail && input.emailVerified) {
    if (nomination?.claimedByUserId) {
      [dbUser] = await withTenantDrizzleScope(getSqlClient(), schemaName, async (tenantDb) => tenantDb
        .select()
        .from(tenantUsers)
        .where(
          and(
            eq(tenantUsers.tenantId, input.tenantId),
            eq(tenantUsers.id, nomination.claimedByUserId!),
          ),
        )
        .limit(1));
    }

    if (!dbUser) {
      [dbUser] = await withTenantDrizzleScope(getSqlClient(), schemaName, async (tenantDb) => tenantDb
        .select()
        .from(tenantUsers)
        .where(
          and(
            eq(tenantUsers.tenantId, input.tenantId),
            eq(tenantUsers.email, normalizedEmail),
          ),
        )
        .limit(1));
    }
  }

  const canClaimNomination =
    Boolean(nomination) &&
    input.emailVerified &&
    (!nomination!.claimedByUserId ||
      nomination!.claimedByUserId === dbUser?.id);

  if (!dbUser) {
    const [newUser] = await withTenantDrizzleScope(getSqlClient(), schemaName, async (tenantDb) => tenantDb
      .insert(tenantUsers)
      .values({
        externalId: input.externalId,
        tenantId: input.tenantId,
        displayName: normalizedDisplayName,
        email: normalizedEmail || null,
        role: canClaimNomination ? "tenant_admin" : "user",
        lastLoginAt: now,
      })
      .returning());
    dbUser = newUser;
  } else {
    const desiredRole =
      canClaimNomination && dbUser.role !== "tenant_admin"
        ? "tenant_admin"
        : dbUser.role;

    const [updatedUser] = await withTenantDrizzleScope(getSqlClient(), schemaName, async (tenantDb) => tenantDb
      .update(tenantUsers)
      .set({
        externalId: input.externalId,
        displayName: normalizedDisplayName ?? dbUser.displayName ?? null,
        email: normalizedEmail || null,
        role: desiredRole,
        lastLoginAt: now,
      })
      .where(eq(tenantUsers.id, dbUser.id))
      .returning());
    dbUser = updatedUser;
  }

  if (
    canClaimNomination &&
    nomination &&
    nomination.claimedByUserId !== dbUser.id
  ) {
    await db
      .update(tenantAdminNominations)
      .set({
        claimedByUserId: dbUser.id,
        claimedAt: nomination.claimedAt ?? now,
      })
      .where(eq(tenantAdminNominations.id, nomination.id));
  }

  await ensureDefaultUserGroupMembership(dbUser.tenantId, dbUser.id);
  await ensureDashboardAgent(dbUser.id, dbUser.externalId, dbUser.tenantId);
  return dbUser;
}
