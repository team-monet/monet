import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import type { AgentGroup } from "@monet/types";
import { GroupsClient } from "./groups-client";

export default async function AdminGroupsPage() {
  await requireAdmin();

  let groups: AgentGroup[] = [];
  let error = "";

  try {
    const client = await getApiClient();
    const result = await client.listGroups();
    groups = result.groups;
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <GroupsClient groups={groups} error={error} />
    </div>
  );
}
