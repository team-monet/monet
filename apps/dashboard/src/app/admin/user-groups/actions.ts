"use server";

import { and, eq, inArray } from "drizzle-orm";
import {
  agentGroups,
  userGroupAgentGroupPermissions,
  userGroupMembers,
  userGroups,
  tenantUsers,
  tenantSchemaNameFromId,
  withTenantDrizzleScope,
  type Database,
  type TransactionClient,
} from "@monet/db";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { getSqlClient } from "@/lib/db";
import type { MemberActionState, UserGroupActionState } from "./actions-shared";

async function withTenantDb<T>(tenantId: string, fn: (db: Database, sql: TransactionClient) => Promise<T>): Promise<T> {
  return withTenantDrizzleScope(getSqlClient(), tenantSchemaNameFromId(tenantId), fn);
}

type AdminSessionUser = {
  tenantId?: string;
};

function toSingle(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function userGroupDetailPath(userGroupId: string) {
  return `/admin/user-groups/${userGroupId}`;
}

async function requireAdminTenantId() {
  const session = await requireAdmin();
  const sessionUser = session.user as AdminSessionUser;

  if (!sessionUser.tenantId) {
    throw new Error("Tenant ID not found in session");
  }

  return sessionUser.tenantId;
}

async function ensureUserGroupInTenant(tenantId: string, userGroupId: string) {
  return withTenantDb(tenantId, async (db) => {
    const [group] = await db
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(
        and(eq(userGroups.id, userGroupId), eq(userGroups.tenantId, tenantId)),
      )
      .limit(1);

    return group ?? null;
  });
}

export async function createUserGroupAction(
  formData: FormData,
): Promise<UserGroupActionState> {
  const tenantId = await requireAdminTenantId();
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));

  if (!name) {
    return { status: "error", message: "User group name is required" };
  }

  try {
    await withTenantDb(tenantId, async (db) => {
      await db.insert(userGroups).values({
        tenantId,
        name,
        description,
      });
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create user group";
    return { status: "error", message };
  }

  revalidatePath("/admin/user-groups");
  return {
    status: "success",
    message: "The new user group is ready for members and agent-group permissions.",
  };
}

export async function updateUserGroupAction(
  formData: FormData,
): Promise<UserGroupActionState> {
  const tenantId = await requireAdminTenantId();
  const userGroupId = toSingle(formData.get("userGroupId"));
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));
  if (!userGroupId || !name) {
    return { status: "error", message: "Group ID and name are required" };
  }

  const group = await ensureUserGroupInTenant(tenantId, userGroupId);
  if (!group) {
    return { status: "error", message: "User group not found" };
  }

  try {
    await withTenantDb(tenantId, async (db) => {
      await db
        .update(userGroups)
        .set({ name, description })
        .where(eq(userGroups.id, userGroupId));
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update user group";
    return { status: "error", message };
  }

  revalidatePath("/admin/user-groups");
  revalidatePath(userGroupDetailPath(userGroupId));
  return { status: "success", message: "The group details were saved." };
}

export async function addUserGroupMemberAction(
  formData: FormData,
): Promise<MemberActionState> {
  const tenantId = await requireAdminTenantId();
  const userGroupId = toSingle(formData.get("userGroupId"));
  const userId = toSingle(formData.get("userId"));

  if (!userGroupId || !userId) {
    return { status: "error", message: "User group and user are required" };
  }

  const [group, user] = await Promise.all([
    ensureUserGroupInTenant(tenantId, userGroupId),
    withTenantDb(tenantId, async (db) => {
      return db
        .select({ id: tenantUsers.id })
        .from(tenantUsers)
        .where(and(eq(tenantUsers.id, userId), eq(tenantUsers.tenantId, tenantId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    }),
  ]);

  if (!group || !user) {
    return { status: "error", message: "User group or user not found" };
  }

  try {
    await withTenantDb(tenantId, async (db) => {
      await db
        .insert(userGroupMembers)
        .values({ userGroupId, userId })
        .onConflictDoNothing();
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to add member";
    return { status: "error", message };
  }

  revalidatePath("/admin/user-groups");
  revalidatePath(userGroupDetailPath(userGroupId));
  return { status: "success", message: "The user now belongs to this user group.", action: "add", userId };
}

export async function removeUserGroupMemberAction(
  formData: FormData,
): Promise<MemberActionState> {
  const tenantId = await requireAdminTenantId();
  const userGroupId = toSingle(formData.get("userGroupId"));
  const userId = toSingle(formData.get("userId"));

  if (!userGroupId || !userId) {
    return { status: "error", message: "User group and user are required" };
  }

  const group = await ensureUserGroupInTenant(tenantId, userGroupId);
  if (!group) {
    return { status: "error", message: "User group not found" };
  }

  try {
    await withTenantDb(tenantId, async (db) => {
      await db
        .delete(userGroupMembers)
        .where(
          and(
            eq(userGroupMembers.userGroupId, userGroupId),
            eq(userGroupMembers.userId, userId),
          ),
        );
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to remove member";
    return { status: "error", message };
  }

  revalidatePath("/admin/user-groups");
  revalidatePath(userGroupDetailPath(userGroupId));
  return { status: "success", message: "The user was removed from this user group.", action: "remove", userId };
}

export async function saveUserGroupAgentPermissionsAction(
  formData: FormData,
): Promise<UserGroupActionState> {
  const tenantId = await requireAdminTenantId();
  const userGroupId = toSingle(formData.get("userGroupId"));

  if (!userGroupId) {
    return { status: "error", message: "User group is required" };
  }

  const group = await ensureUserGroupInTenant(tenantId, userGroupId);
  if (!group) {
    return { status: "error", message: "User group not found" };
  }

  const selectedAgentGroupIds = formData
    .getAll("agentGroupId")
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);

  const agentGroupRows =
    selectedAgentGroupIds.length === 0
      ? []
      : await withTenantDb(tenantId, async (db) => {
          return db
            .select({ id: agentGroups.id })
            .from(agentGroups)
            .where(
              and(
                eq(agentGroups.tenantId, tenantId),
                inArray(agentGroups.id, selectedAgentGroupIds),
              ),
            );
        });

  if (agentGroupRows.length !== selectedAgentGroupIds.length) {
    return { status: "error", message: "One or more agent groups were invalid" };
  }

  try {
    await withTenantDb(tenantId, async (db) => {
      await db.transaction(async (tx) => {
        await tx
          .delete(userGroupAgentGroupPermissions)
          .where(eq(userGroupAgentGroupPermissions.userGroupId, userGroupId));

        if (selectedAgentGroupIds.length > 0) {
          await tx.insert(userGroupAgentGroupPermissions).values(
            selectedAgentGroupIds.map((agentGroupId) => ({
              userGroupId,
              agentGroupId,
            })),
          );
        }
      });
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to save permissions";
    return { status: "error", message };
  }

  revalidatePath("/admin/user-groups");
  revalidatePath(userGroupDetailPath(userGroupId));
  revalidatePath("/agents");
  return {
    status: "success",
    message: "The allowed agent groups for this user group were updated.",
  };
}
