"use server";

import { and, eq, inArray } from "drizzle-orm";
import {
  agentGroups,
  userGroupAgentGroupPermissions,
  userGroupMembers,
  userGroups,
  tenantUsers,
} from "@monet/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

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
  const [group] = await db
    .select({ id: userGroups.id })
    .from(userGroups)
    .where(
      and(eq(userGroups.id, userGroupId), eq(userGroups.tenantId, tenantId)),
    )
    .limit(1);

  return group ?? null;
}

export async function createUserGroupAction(formData: FormData) {
  const tenantId = await requireAdminTenantId();
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));

  if (!name) {
    redirect("/admin/user-groups?createError=User%20group%20name%20is%20required");
  }

  try {
    await db.insert(userGroups).values({
      tenantId,
      name,
      description,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create user group";
    redirect(`/admin/user-groups?createError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/user-groups");
  redirect("/admin/user-groups?created=1");
}

export async function updateUserGroupAction(formData: FormData) {
  const tenantId = await requireAdminTenantId();
  const userGroupId = toSingle(formData.get("userGroupId"));
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));
  const redirectPath = userGroupId
    ? userGroupDetailPath(userGroupId)
    : "/admin/user-groups";

  if (!userGroupId || !name) {
    redirect(`${redirectPath}?updateError=Group%20ID%20and%20name%20are%20required`);
  }

  const group = await ensureUserGroupInTenant(tenantId, userGroupId);
  if (!group) {
    redirect(`${redirectPath}?updateError=User%20group%20not%20found`);
  }

  try {
    await db
      .update(userGroups)
      .set({ name, description })
      .where(eq(userGroups.id, userGroupId));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update user group";
    redirect(`${redirectPath}?updateError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/user-groups");
  revalidatePath(redirectPath);
  redirect(`${redirectPath}?updated=1`);
}

export async function addUserGroupMemberAction(formData: FormData) {
  const tenantId = await requireAdminTenantId();
  const userGroupId = toSingle(formData.get("userGroupId"));
  const userId = toSingle(formData.get("userId"));
  const redirectPath = userGroupId
    ? userGroupDetailPath(userGroupId)
    : "/admin/user-groups";

  if (!userGroupId || !userId) {
    redirect(`${redirectPath}?memberError=User%20group%20and%20user%20are%20required`);
  }

  const [group, user] = await Promise.all([
    ensureUserGroupInTenant(tenantId, userGroupId),
    db
      .select({ id: tenantUsers.id })
      .from(tenantUsers)
      .where(and(eq(tenantUsers.id, userId), eq(tenantUsers.tenantId, tenantId)))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  if (!group || !user) {
    redirect(`${redirectPath}?memberError=User%20group%20or%20user%20not%20found`);
  }

  await db
    .insert(userGroupMembers)
    .values({ userGroupId, userId })
    .onConflictDoNothing();

  revalidatePath("/admin/user-groups");
  revalidatePath(redirectPath);
  redirect(`${redirectPath}?memberAdded=1`);
}

export async function removeUserGroupMemberAction(formData: FormData) {
  const tenantId = await requireAdminTenantId();
  const userGroupId = toSingle(formData.get("userGroupId"));
  const userId = toSingle(formData.get("userId"));
  const redirectPath = userGroupId
    ? userGroupDetailPath(userGroupId)
    : "/admin/user-groups";

  if (!userGroupId || !userId) {
    redirect(`${redirectPath}?memberError=User%20group%20and%20user%20are%20required`);
  }

  const group = await ensureUserGroupInTenant(tenantId, userGroupId);
  if (!group) {
    redirect(`${redirectPath}?memberError=User%20group%20not%20found`);
  }

  await db
    .delete(userGroupMembers)
    .where(
      and(
        eq(userGroupMembers.userGroupId, userGroupId),
        eq(userGroupMembers.userId, userId),
      ),
    );

  revalidatePath("/admin/user-groups");
  revalidatePath(redirectPath);
  redirect(`${redirectPath}?memberRemoved=1`);
}

export async function saveUserGroupAgentPermissionsAction(formData: FormData) {
  const tenantId = await requireAdminTenantId();
  const userGroupId = toSingle(formData.get("userGroupId"));
  const redirectPath = userGroupId
    ? userGroupDetailPath(userGroupId)
    : "/admin/user-groups";

  if (!userGroupId) {
    redirect(`${redirectPath}?permissionsError=User%20group%20is%20required`);
  }

  const group = await ensureUserGroupInTenant(tenantId, userGroupId);
  if (!group) {
    redirect(`${redirectPath}?permissionsError=User%20group%20not%20found`);
  }

  const selectedAgentGroupIds = formData
    .getAll("agentGroupId")
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);

  const agentGroupRows =
    selectedAgentGroupIds.length === 0
      ? []
      : await db
          .select({ id: agentGroups.id })
          .from(agentGroups)
          .where(
            and(
              eq(agentGroups.tenantId, tenantId),
              inArray(agentGroups.id, selectedAgentGroupIds),
            ),
          );

  if (agentGroupRows.length !== selectedAgentGroupIds.length) {
    redirect(`${redirectPath}?permissionsError=One%20or%20more%20agent%20groups%20were%20invalid`);
  }

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

  revalidatePath("/admin/user-groups");
  revalidatePath(redirectPath);
  revalidatePath("/agents");
  redirect(`${redirectPath}?permissionsSaved=1`);
}
