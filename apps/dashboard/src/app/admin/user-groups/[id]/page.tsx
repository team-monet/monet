import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  Settings2,
  ShieldCheck,
  User,
  Users,
} from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { getUserGroupDetail } from "@/lib/user-groups";
import {
  addHumanGroupMemberAction,
  removeHumanGroupMemberAction,
  saveHumanGroupAgentPermissionsAction,
  updateHumanGroupAction,
} from "../actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function getSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function HumanGroupDetailPage({ params, searchParams }: PageProps) {
  const [{ id }, query, session] = await Promise.all([
    params,
    searchParams,
    requireAdmin(),
  ]);
  const sessionUser = session.user as ExtendedUser;
  const tenantId = sessionUser.tenantId;

  const updated = getSingleParam(query.updated) === "1";
  const updateError = getSingleParam(query.updateError);
  const memberAdded = getSingleParam(query.memberAdded) === "1";
  const memberRemoved = getSingleParam(query.memberRemoved) === "1";
  const memberError = getSingleParam(query.memberError);
  const permissionsSaved = getSingleParam(query.permissionsSaved) === "1";
  const permissionsError = getSingleParam(query.permissionsError);

  let error = "";
  let detail: Awaited<ReturnType<typeof getUserGroupDetail>> = null;

  try {
    if (!tenantId) {
      throw new Error("Tenant ID not found in session");
    }

    detail = await getUserGroupDetail(tenantId, id);
    if (!detail) {
      error = "User group not found.";
    }
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  if (error || !detail) {
    return (
      <div className="flex flex-col gap-6 p-4">
        <Button asChild variant="outline" className="w-fit">
          <Link href="/admin/user-groups">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to User Groups
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load user group</AlertTitle>
          <AlertDescription>{error || "User group not found."}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const memberIds = new Set(detail.members.map((member) => member.id));
  const availableUsers = detail.tenantUsers.filter((user) => !memberIds.has(user.id));

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link href="/admin/user-groups">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to User Groups
            </Link>
          </Button>
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight">{detail.group.name}</h1>
            <p className="text-muted-foreground">
              {detail.group.description || "No description provided."}
            </p>
          </div>
        </div>

        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">
              <Settings2 className="mr-2 h-4 w-4" />
              Edit Group
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit User Group</DialogTitle>
              <DialogDescription>
                Update the name and description used for access management.
              </DialogDescription>
            </DialogHeader>
            <form action={updateHumanGroupAction} className="grid gap-4">
              <input type="hidden" name="humanGroupId" value={detail.group.id} />
              <div className="grid gap-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required defaultValue={detail.group.name} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="description">Description</Label>
                <Input id="description" name="description" defaultValue={detail.group.description} />
              </div>
              <DialogFooter>
                <SubmitButton label="Save changes" pendingLabel="Saving..." />
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {updated && (
        <Alert>
          <AlertTitle>User group updated</AlertTitle>
          <AlertDescription>The group details were saved.</AlertDescription>
        </Alert>
      )}

      {updateError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not update user group</AlertTitle>
          <AlertDescription>{updateError}</AlertDescription>
        </Alert>
      )}

      {memberAdded && (
        <Alert>
          <AlertTitle>Member added</AlertTitle>
          <AlertDescription>The user now belongs to this user group.</AlertDescription>
        </Alert>
      )}

      {memberRemoved && (
        <Alert>
          <AlertTitle>Member removed</AlertTitle>
          <AlertDescription>The user was removed from this user group.</AlertDescription>
        </Alert>
      )}

      {memberError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not update members</AlertTitle>
          <AlertDescription>{memberError}</AlertDescription>
        </Alert>
      )}

      {permissionsSaved && (
        <Alert>
          <AlertTitle>Permissions saved</AlertTitle>
          <AlertDescription>The allowed agent groups for this user group were updated.</AlertDescription>
        </Alert>
      )}

      {permissionsError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not update permissions</AlertTitle>
          <AlertDescription>{permissionsError}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Members</CardDescription>
            <CardTitle className="text-2xl">{detail.members.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Allowed Agent Groups</CardDescription>
            <CardTitle className="text-2xl">{detail.allowedAgentGroupIds.size}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Created</CardDescription>
            <CardTitle className="text-base">
              <span className="inline-flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                {new Date(detail.group.createdAt).toLocaleDateString()}
              </span>
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Members
            </CardTitle>
            <CardDescription>Add or remove users from this access group.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form action={addHumanGroupMemberAction} className="flex flex-col gap-3 md:flex-row md:items-end">
              <input type="hidden" name="humanGroupId" value={detail.group.id} />
              <div className="grid flex-1 gap-2">
                <Label htmlFor="userId">Add User</Label>
                <select
                  id="userId"
                  name="userId"
                  required
                  disabled={availableUsers.length === 0}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                  defaultValue=""
                >
                  <option value="" disabled>
                    Select a user
                  </option>
                  {availableUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.email ?? user.externalId}
                    </option>
                  ))}
                </select>
              </div>
              <SubmitButton label="Add Member" pendingLabel="Adding..." disabled={availableUsers.length === 0} />
            </form>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.members.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                      No users belong to this group yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  detail.members.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{member.email ?? member.externalId}</span>
                          <span className="text-xs text-muted-foreground">{member.externalId}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-normal">
                          <User className="mr-1 h-3 w-3" />
                          {member.role}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(member.joinedAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <form action={removeHumanGroupMemberAction}>
                          <input type="hidden" name="humanGroupId" value={detail.group.id} />
                          <input type="hidden" name="userId" value={member.id} />
                          <SubmitButton label="Remove" pendingLabel="Removing..." variant="outline" size="sm" />
                        </form>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Available Users</CardTitle>
            <CardDescription>
              {availableUsers.length === 0
                ? "All tenant users are already members."
                : `${availableUsers.length} users can be added.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {availableUsers.slice(0, 8).map((user) => (
              <div key={user.id} className="rounded-md border p-2 text-sm">
                <p className="font-medium">{user.email ?? user.externalId}</p>
                <p className="text-xs text-muted-foreground">{user.externalId}</p>
              </div>
            ))}
            {availableUsers.length > 8 && (
              <p className="text-xs text-muted-foreground">
                +{availableUsers.length - 8} more users available
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Allowed Agent Groups
          </CardTitle>
          <CardDescription>
            Users in this group may register or bind agents into the selected agent groups.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={saveHumanGroupAgentPermissionsAction} className="space-y-4">
            <input type="hidden" name="humanGroupId" value={detail.group.id} />
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {detail.tenantAgentGroups.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No agent groups exist yet. Create agent groups first.
                </p>
              ) : (
                detail.tenantAgentGroups.map((agentGroup) => (
                  <label
                    key={agentGroup.id}
                    className="flex items-start gap-3 rounded-md border p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      name="agentGroupId"
                      value={agentGroup.id}
                      defaultChecked={detail.allowedAgentGroupIds.has(agentGroup.id)}
                      className="mt-0.5"
                    />
                    <span className="flex flex-col">
                      <span className="font-medium">{agentGroup.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {agentGroup.description || "No description"}
                      </span>
                    </span>
                  </label>
                ))
              )}
            </div>
            <SubmitButton label="Save Permissions" pendingLabel="Saving..." disabled={detail.tenantAgentGroups.length === 0} />
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
