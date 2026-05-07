import { requireAdmin } from "@/lib/auth";
import { listUserGroupsForTenant } from "@/lib/user-groups";
import { UserGroupsClient } from "./user-groups-client";

interface ExtendedUser {
  tenantId?: string;
}

export default async function UserGroupsPage() {
  const session = await requireAdmin();
  const sessionUser = session.user as ExtendedUser;
  const tenantId = sessionUser.tenantId;

  let error = "";
  let groups = [] as Awaited<ReturnType<typeof listUserGroupsForTenant>>;

  try {
    if (!tenantId) {
      throw new Error("Tenant ID not found in session");
    }

    groups = await listUserGroupsForTenant(tenantId);
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <UserGroupsClient groups={groups} error={error} />
    </div>
  );
}
