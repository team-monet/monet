import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import type { AuditLog } from "@monet/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { 
  Pagination, 
  PaginationContent, 
  PaginationItem, 
  PaginationNext, 
} from "@/components/ui/pagination";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Calendar, User, Bot, ShieldCheck } from "lucide-react";
import { AuditFilters } from "./filters";
import { Suspense } from "react";
import { AuditTableSkeleton } from "./loading";
import { LocalizedDateTime } from "@/components/localized-date-time";

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function getSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function actorTypeLabel(actorType: string) {
  if (actorType === "user") {
    return "User";
  }
  if (actorType === "system") {
    return "System";
  }
  if (actorType === "agent") {
    return "Agent";
  }
  return actorType;
}

// Auth: relies on requireAdmin() in the parent AdminAuditPage — do not render outside that guard.
async function AuditTable({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  
  const actorId = getSingleParam(params.actorId);
  const rawAction = getSingleParam(params.action);
  const action = rawAction && rawAction !== "all" ? rawAction : undefined;
  const startDate = getSingleParam(params.startDate);
  const endDate = getSingleParam(params.endDate);
  const cursor = getSingleParam(params.cursor);

  let logs: AuditLog[] = [];
  let nextCursor: string | null = null;
  let error = "";

  try {
    const client = await getApiClient();
    const result = await client.getAuditLogs({
      actorId,
      action,
      startDate,
      endDate,
      cursor,
      limit: 20,
    });
    logs = result.items;
    nextCursor = result.nextCursor;
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Error loading audit logs</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      <Card className="shadow-sm">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[200px]">Timestamp</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead className="w-[120px]">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No audit logs found.
                  </TableCell>
                </TableRow>
              ) : (
                logs.map((log) => (
                  <TableRow key={log.id} className="text-sm">
                    <TableCell className="text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <Calendar className="h-3.5 w-3.5" />
                        <LocalizedDateTime date={log.created_at} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {log.actor_type === "agent" ? (
                          <Bot className="h-4 w-4 text-primary" />
                        ) : log.actor_type === "system" ? (
                          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <User className="h-4 w-4 text-muted-foreground" />
                        )}
                        <div className="flex flex-col">
                          <span className="font-medium">
                            {log.actor_display_name ?? actorTypeLabel(log.actor_type)}
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[120px]" title={log.actor_id}>
                            {actorTypeLabel(log.actor_type)} · {log.actor_id}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-normal capitalize">
                        {log.action.replace(/[._]/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      {log.target_id || "-"}
                    </TableCell>
                    <TableCell>
                      {log.outcome === "success" ? (
                        <Badge variant="default" className="bg-green-600 hover:bg-green-600 uppercase text-[10px]">
                          Success
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="uppercase text-[10px]">
                          Failed
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {nextCursor && (
        <div className="flex justify-center mt-4">
          {(() => {
            const nextParams = new URLSearchParams();
            nextParams.set("cursor", nextCursor);
            if (actorId) nextParams.set("actorId", actorId);
            if (action) nextParams.set("action", action);
            if (startDate) nextParams.set("startDate", startDate);
            if (endDate) nextParams.set("endDate", endDate);
            const nextHref = `/admin/audit?${nextParams.toString()}`;

            return (
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationNext href={nextHref} />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            );
          })()}
        </div>
      )}
    </>
  );
}

export default async function AdminAuditPage({ searchParams }: PageProps) {
  await requireAdmin();
  const params = await searchParams;
  const rawAction = getSingleParam(params.action);
  const action = rawAction && rawAction !== "all" ? rawAction : undefined;

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Audit Log</h1>
        <p className="text-muted-foreground mt-1">
          Trace all administrative and system actions for security and compliance.
        </p>
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-0">
          <AuditFilters initialAction={action} />
        </CardContent>
      </Card>

      <Suspense fallback={<AuditTableSkeleton />}>
        <AuditTable searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
