import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";

export function AuditTableSkeleton() {
  return (
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
            {[...Array(8)].map((_, i) => (
              <TableRow key={i}>
                <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <div className="space-y-1">
                      <Skeleton className="h-4 w-24" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                  </div>
                </TableCell>
                <TableCell><Skeleton className="h-5 w-24 rounded-full" /></TableCell>
                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                <TableCell><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function AuditLoading() {
  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="space-y-1">
        <Skeleton className="h-10 w-[200px]" />
        <Skeleton className="h-4 w-[400px] mt-1" />
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-4 flex gap-4">
          <Skeleton className="h-10 w-full max-w-[200px]" />
          <Skeleton className="h-10 w-full max-w-[200px]" />
          <Skeleton className="h-10 w-[100px]" />
        </CardContent>
      </Card>

      <AuditTableSkeleton />
    </div>
  );
}
