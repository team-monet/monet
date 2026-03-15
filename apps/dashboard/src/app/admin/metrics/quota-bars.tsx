import type { QuotaUtilization } from "@monet/types";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface QuotaBarsProps {
  data: QuotaUtilization[];
}

function quotaColor(pct: number): string {
  if (pct >= 90) return "text-red-500";
  if (pct >= 70) return "text-yellow-500";
  return "text-green-500";
}

function progressColor(pct: number): string {
  if (pct >= 90) return "[&>[data-slot=progress-indicator]]:bg-red-500";
  if (pct >= 70) return "[&>[data-slot=progress-indicator]]:bg-yellow-500";
  return "[&>[data-slot=progress-indicator]]:bg-green-500";
}

export function QuotaBars({ data }: QuotaBarsProps) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quota Utilization</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No groups found.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Quota Utilization</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.map((group) => {
          const pct = group.quota != null && group.quota > 0 ? Math.round((group.current / group.quota) * 100) : 0;
          return (
            <div key={group.groupId} className="space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="font-medium">{group.groupName}</span>
                <span className={group.quota === null ? "text-muted-foreground" : quotaColor(pct)}>
                  {group.quota === null
                    ? `${group.current.toLocaleString()} entries`
                    : `${group.current.toLocaleString()} / ${group.quota.toLocaleString()} (${pct}%)`}
                </span>
              </div>
              {group.quota !== null && <Progress value={pct} className={progressColor(pct)} />}
              {group.quota === null && (
                <p className="text-[11px] text-muted-foreground">
                  No group quota set — agents enforced at {group.effectiveQuotaPerAgent.toLocaleString()} entries each
                </p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
