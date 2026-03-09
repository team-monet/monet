"use server";

import { and, eq, inArray } from "drizzle-orm";
import {
  agentGroups,
  humanGroupAgentGroupPermissions,
  humanGroupMembers,
  humanGroups,
  humanUsers,
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

function humanGroupDetailPath(humanGroupId: string) {
  return `/admin/human-groups/${humanGroupId}`;
}

async function requireAdminTenantId() {
  const session = await requireAdmin();
  const sessionUser = session.user as AdminSessionUser;

  if (!sessionUser.tenantId) {
    throw new Error("Tenant ID not found in session");
  }

  return sessionUser.tenantId;
}

async function ensureHumanGroupInTenant(tenantId: string, humanGroupId: string) {
  const [group] = await db
    .select({ id: humanGroups.id })
    .from(humanGroups)
    .where(
      and(eq(humanGroups.id, humanGroupId), eq(humanGroups.tenantId, tenantId)),
    )
    .limit(1);

  return group ?? null;
}

export async function createHumanGroupAction(formData: FormData) {
  const tenantId = await requireAdminTenantId();
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));

  if (!name) {
    redirect("/admin/human-groups?createError=User%20group%20name%20is%20required");
  }

  try {
    await db.insert(humanGroups).values({
      tenantId,
      name,
      description,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create user group";
    redirect(`/admin/human-groups?createError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/human-groups");
  redirect("/admin/human-groups?created=1");
}

export async function updateHumanGroupAction(formData: FormData) {
  const tenantId = await requireAdminTenantId();
  const humanGroupId = toSingle(formData.get("humanGroupId"));
  const name = toSingle(formData.get("name"));
  const description = toSingle(formData.get("description"));
  const redirectPath = humanGroupId
    ? humanGroupDetailPath(humanGroupId)
    : "/admin/human-groups";

  if (!humanGroupId || !name) {
    redirect(`${redirectPath}?updateError=Group%20ID%20and%20name%20are%20required`);
  }

  const group = await ensureHumanGroupInTenant(tenantId, humanGroupId);
  if (!group) {
    redirect(`${redirectPath}?updateError=User%20group%20not%20found`);
  }

  try {
    await db
      .update(humanGroups)
      .set({ name, description })
      .where(eq(humanGroups.id, humanGroupId));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update user group";
    redirect(`${redirectPath}?updateError=${encodeURIComponent(message)}`);
  }

  revalidatePath("/admin/human-groups");
  revalidatePath(redirectPath);
  redirect(`${redirectPath}?updated=1`);
}

export async function addHumanGroupMemberAction(formData: FormData) {
  const tenantId = await requireAdminTenantId();
  const humanGroupId = toSingle(formData.get("humanGroupId"));
  const userId = toSingle(formData.get("userId"));
  const redirectPath = humanGroupId
    ? humanGroupDetailPath(humanGroupId)
    : "/admin/human-groups";

  if (!humanGroupId || !userId) {
    redirect(`${redirectPath}?memberError=User%20group%20and%20user%20are%20required`);
  }

  const [group, user] = await Promise.all([
    ensureHumanGroupInTenant(tenantId, humanGroupId),
    db
      .select({ id: humanUsers.id })
      .from(humanUsers)
      .where(and(eq(humanUsers.id, userId), eq(humanUsers.tenantId, tenantId)))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);

  if (!group || !user) {
    redirect(`${redirectPath}?memberError=User%20group%20or%20user%20not%20found`);
  }

  await db
    .insert(humanGroupMembers)
    .values({ humanGroupId, userId })
    .onConflictDoNothing();

  revalidatePath("/admin/human-groups");
  revalidatePath(redirectPath);
  redirect(`${redirectPath}?memberAdded=1`);
}

export async function removeHumanGroupMemberAction(formData: FormData) {
  const tenantId = await requireAdminTenantId();
  const humanGroupId = toSingle(formData.get("humanGroupId"));
  const userId = toSingle(formData.get("userId"));
  const redirectPath = humanGroupId
    ? humanGroupDetailPath(humanGroupId)
    : "/admin/human-groups";

  if (!humanGroupId || !userId) {
    redirect(`${redirectPath}?memberError=User%20group%20and%20user%20are%20required`);
  }

  const group = await ensureHumanGroupInTenant(tenantId, humanGroupId);
  if (!group) {
    redirect(`${redirectPath}?memberError=User%20group%20not%20found`);
  }

  await db
    .delete(humanGroupMembers)
    .where(
      and(
        eq(humanGroupMembers.humanGroupId, humanGroupId),
        eq(humanGroupMembers.userId, userId),
      ),
    );

  revalidatePath("/admin/human-groups");
  revalidatePath(redirectPath);
  redirect(`${redirectPath}?memberRemoved=1`);
}

export async function saveHumanGroupAgentPermissionsAction(formData: FormData) {
  const tenantId = await requireAdminTenantId();
  const humanGroupId = toSingle(formData.get("humanGroupId"));
  const redirectPath = humanGroupId
    ? humanGroupDetailPath(humanGroupId)
    : "/admin/human-groups";

  if (!humanGroupId) {
    redirect(`${redirectPath}?permissionsError=User%20group%20is%20required`);
  }

  const group = await ensureHumanGroupInTenant(tenantId, humanGroupId);
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
      .delete(humanGroupAgentGroupPermissions)
      .where(eq(humanGroupAgentGroupPermissions.humanGroupId, humanGroupId));

    if (selectedAgentGroupIds.length > 0) {
      await tx.insert(humanGroupAgentGroupPermissions).values(
        selectedAgentGroupIds.map((agentGroupId) => ({
          humanGroupId,
          agentGroupId,
        })),
      );
    }
  });

  revalidatePath("/admin/human-groups");
  revalidatePath(redirectPath);
  revalidatePath("/agents");
  redirect(`${redirectPath}?permissionsSaved=1`);
}
