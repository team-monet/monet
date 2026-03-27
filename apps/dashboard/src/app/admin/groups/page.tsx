import { getApiClient } from "@/lib/api-client";
import { requireAdmin } from "@/lib/auth";
import type { AgentGroup } from "@monet/types";
import { createGroupAction, updateGroupAction } from "./actions";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Users, Settings2, Calendar, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogFooter, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger 
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function getSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminGroupsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  await requireAdmin();

  const createError = getSingleParam(params.createError);
  const created = getSingleParam(params.created) === "1";
  const updateError = getSingleParam(params.updateError);
  const updated = getSingleParam(params.updated) === "1";
  
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
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agent Groups</h1>
          <p className="text-muted-foreground mt-1">
            Manage agent groups and memory quotas for your organization.
          </p>
        </div>
        
        <Dialog>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Create Group
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Group</DialogTitle>
              <DialogDescription>
                Add a new agent group to your organization.
              </DialogDescription>
            </DialogHeader>
            <form action={createGroupAction} className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Group Name</Label>
                <Input id="name" name="name" required placeholder="e.g. Engineering" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description">Description</Label>
                <Input id="description" name="description" placeholder="Short description of the group" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="memoryQuota">Memory Quota (Entries)</Label>
                <Input id="memoryQuota" name="memoryQuota" type="number" min={1} step={1} placeholder="Optional. Leave blank for unlimited" />
              </div>
              <DialogFooter>
                <SubmitButton label="Create Group" pendingLabel="Creating..." />
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {created && (
        <Alert>
          <AlertTitle>Group created</AlertTitle>
          <AlertDescription>The new group has been added successfully.</AlertDescription>
        </Alert>
      )}

      {createError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not create group</AlertTitle>
          <AlertDescription>{createError}</AlertDescription>
        </Alert>
      )}

      {updated && (
        <Alert>
          <AlertTitle>Group updated</AlertTitle>
          <AlertDescription>Your changes were saved successfully.</AlertDescription>
        </Alert>
      )}

      {updateError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not update group</AlertTitle>
          <AlertDescription>{updateError}</AlertDescription>
        </Alert>
      )}

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error loading groups</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <Card className="shadow-sm">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">Group Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-[150px]">Memory Quota</TableHead>
                  <TableHead className="w-[150px]">Created</TableHead>
                  <TableHead className="w-[240px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      No groups created yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  groups.map((g) => (
                    <TableRow key={g.id} className="group transition-colors">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="flex h-8 w-8 items-center justify-center rounded bg-muted">
                            <Users className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <span className="font-semibold text-sm">{g.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm text-muted-foreground line-clamp-1">
                          {g.description || "-"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-normal">
                          {g.memoryQuota ? `${g.memoryQuota} entries` : g.memoryQuota === 0 ? "Unlimited" : "Default"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          {new Date(g.createdAt).toLocaleDateString()}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button variant="outline" size="sm">
                                <Settings2 className="mr-2 h-4 w-4" />
                                Edit
                              </Button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>Edit Group</DialogTitle>
                                <DialogDescription>
                                  Update group name, description, and quota.
                                </DialogDescription>
                              </DialogHeader>
                              <form action={updateGroupAction} className="grid gap-4 py-4">
                                <input type="hidden" name="groupId" value={g.id} />
                                <div className="grid gap-2">
                                  <Label htmlFor={`edit-name-${g.id}`}>Group Name</Label>
                                  <Input id={`edit-name-${g.id}`} name="name" required defaultValue={g.name} />
                                </div>
                                <div className="grid gap-2">
                                  <Label htmlFor={`edit-description-${g.id}`}>Description</Label>
                                  <Input id={`edit-description-${g.id}`} name="description" defaultValue={g.description} />
                                </div>
                                <div className="grid gap-2">
                                  <Label htmlFor={`edit-memoryQuota-${g.id}`}>Memory Quota (Entries)</Label>
                                  <Input
                                    id={`edit-memoryQuota-${g.id}`}
                                    name="memoryQuota"
                                    type="number"
                                    min={0}
                                    step={1}
                                    defaultValue={g.memoryQuota ?? undefined}
                                    placeholder="Leave blank for default · 0 = unlimited"
                                  />
                                  <p className="text-[11px] text-muted-foreground">
                                    0 = unlimited · blank = keep current quota
                                  </p>
                                </div>
                                <DialogFooter>
                                  <SubmitButton label="Save changes" pendingLabel="Saving..." />
                                </DialogFooter>
                              </form>
                            </DialogContent>
                          </Dialog>
                          <Button asChild variant="secondary" size="sm">
                            <Link href={`/admin/groups/${g.id}`}>View Details</Link>
                          </Button>
                        </div>
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
