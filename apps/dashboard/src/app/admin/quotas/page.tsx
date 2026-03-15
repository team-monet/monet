import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import { AgentGroup, QuotaUtilization } from "@monet/types";
import { updateGroupQuotaAction } from "./actions";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Database, Save, Users, Zap } from "lucide-react";

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function getSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function QuotasPage({ searchParams }: PageProps) {
  const params = await searchParams;
  await requireAdmin();

  const updated = getSingleParam(params.updated) === "1";
  const updateError = getSingleParam(params.updateError);

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
          Setting a quota back to unlimited is not supported yet.
        </p>
      </div>

      {updated && (
        <Alert>
          <AlertTitle>Quota updated</AlertTitle>
          <AlertDescription>The group quota has been updated successfully.</AlertDescription>
        </Alert>
      )}

      {updateError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not update quota</AlertTitle>
          <AlertDescription>{updateError}</AlertDescription>
        </Alert>
      )}

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
              return (
                <Card key={group.id} className="shadow-sm">
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2 text-primary mb-1">
                      <Users className="h-4 w-4" />
                      <span className="text-xs font-bold uppercase tracking-wider">Agent Group</span>
                    </div>
                    <CardTitle>{group.name}</CardTitle>
                    <CardDescription className="line-clamp-1">{group.description || "No description provided."}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                          <Database className="h-3.5 w-3.5" />
                          Current Quota
                        </span>
                        <span className="font-medium">
                          {group.memoryQuota === null
                            ? "Default (10,000 per agent)"
                            : `${group.memoryQuota} Entries`}
                        </span>
                      </div>
                      {(() => {
                        const usage = quotaUsage.find((q) => q.groupId === group.id);
                        if (usage) {
                          const pct = usage.quota != null && usage.quota > 0 ? Math.round((usage.current / usage.quota) * 100) : 0;
                          return (
                            <p className="text-[11px] text-muted-foreground">
                              Currently using <span className="font-medium">{usage.current.toLocaleString()}</span> entries
                              {usage.quota === null ? "" : ` (${pct}% of quota)`}
                            </p>
                          );
                        }
                        return (
                          <p className="text-[11px] text-muted-foreground">
                            Usage data loading...
                          </p>
                        );
                      })()}
                      <p className="text-[11px] text-muted-foreground">
                        Use a positive integer. Clearing quota to unlimited is not available yet.
                      </p>
                    </div>

                    <form action={updateGroupQuotaAction} className="space-y-3 pt-2">
                      <input type="hidden" name="groupId" value={group.id} />
                      <div className="grid gap-1.5">
                        <Label htmlFor={`quota-${group.id}`} className="text-xs">Update Quota (Entries)</Label>
                        <div className="flex gap-2">
                          <Input
                            id={`quota-${group.id}`}
                            type="number"
                            name="quota"
                            min={1}
                            step={1}
                            required
                            defaultValue={group.memoryQuota ?? ""}
                            placeholder={group.memoryQuota === null ? "e.g. 1000" : "Enter a new quota"}
                            className="h-9"
                          />
                          <SubmitButton size="sm" type="submit" className="h-9 px-3">
                            <Save className="h-4 w-4" />
                            <span className="sr-only">Save</span>
                          </SubmitButton>
                        </div>
                      </div>
                    </form>
                  </CardContent>
                  <CardFooter className="bg-muted/30 border-t py-3 flex justify-between">
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Zap className="h-3 w-3" />
                      Quota changes apply immediately
                    </div>
                  </CardFooter>
                </Card>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
