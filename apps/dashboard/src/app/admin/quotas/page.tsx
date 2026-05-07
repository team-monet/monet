import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import { AgentGroup, QuotaUtilization } from "@monet/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { QuotaGroupCard } from "./quota-group-card";

export default async function QuotasPage() {
  await requireAdmin();

  let groups: AgentGroup[] = [];
  let quotaUsage: QuotaUtilization[] = [];
  let error = "";

  try {
    const client = await getApiClient();
    const [groupResult, metricsResult] = await Promise.all([
      client.listGroups(),
      client.getMetrics().catch(() => null),
    ]);
    groups = groupResult.groups;
    if (metricsResult) {
      quotaUsage = metricsResult.health.quotaUtilization;
    }
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Resource Quotas</h1>
        <p className="text-muted-foreground mt-1">
          Manage memory storage limits for agent groups.
        </p>
        <p className="text-xs text-muted-foreground">
          Set a quota to limit memory entries per agent, or clear it to allow unlimited storage.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error loading quotas</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {groups.length === 0 ? (
            <div className="col-span-full py-20 text-center border rounded-lg bg-muted/20 border-dashed">
              <p className="text-muted-foreground">No agent groups found.</p>
            </div>
          ) : (
            groups.map((group) => {
              const usage = quotaUsage.find((q) => q.groupId === group.id);
              return (
                <QuotaGroupCard key={group.id} group={group} usage={usage} />
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
