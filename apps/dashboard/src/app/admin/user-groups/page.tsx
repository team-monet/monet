import Link from "next/link";
import { AlertTriangle, Calendar, Plus, ShieldCheck, Users } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { listHumanGroupsForTenant } from "@/lib/user-groups";
import { createHumanGroupAction } from "./actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface ExtendedUser {
  tenantId?: string;
}

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function getSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function HumanGroupsPage({ searchParams }: PageProps) {
  const session = await requireAdmin();
  const sessionUser = session.user as ExtendedUser;
  const tenantId = sessionUser.tenantId;
  const params = await searchParams;

  const created = getSingleParam(params.created) === "1";
  const createError = getSingleParam(params.createError);
  let error = "";
  let groups = [] as Awaited<ReturnType<typeof listHumanGroupsForTenant>>;

  try {
    if (!tenantId) {
      throw new Error("Tenant ID not found in session");
    }

    groups = await listHumanGroupsForTenant(tenantId);
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">User Groups</h1>
          <p className="text-muted-foreground mt-1">
            Manage user memberships and control which agent groups they may use during registration.
          </p>
        </div>

        <Dialog>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create User Group
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create User Group</DialogTitle>
              <DialogDescription>
                Group users together to control access to agent groups.
              </DialogDescription>
            </DialogHeader>
            <form action={createHumanGroupAction} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required placeholder="e.g. Customer Success" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description">Description</Label>
                <Input
                  id="description"
                  name="description"
                  placeholder="What this user group is for"
                />
              </div>
              <DialogFooter>
                <Button type="submit">Create Group</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {created && (
        <Alert>
          <AlertTitle>User group created</AlertTitle>
          <AlertDescription>The new user group is ready for members and agent-group permissions.</AlertDescription>
        </Alert>
      )}

      {createError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not create user group</AlertTitle>
          <AlertDescription>{createError}</AlertDescription>
        </Alert>
      )}

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error loading user groups</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <Card className="shadow-sm">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User Group</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead>Allowed Agent Groups</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      No user groups created yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  groups.map((group) => (
                    <TableRow key={group.id}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="font-medium">{group.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {group.description || "No description"}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-normal">
                          <Users className="mr-1 h-3 w-3" />
                          {group.memberCount}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-normal">
                          <ShieldCheck className="mr-1 h-3 w-3" />
                          {group.allowedAgentGroupCount}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          {new Date(group.createdAt).toLocaleDateString()}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild variant="secondary" size="sm">
                          <Link href={`/admin/user-groups/${group.id}`}>Manage</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
