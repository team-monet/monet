import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  ShieldCheck,
} from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { getUserPrimaryLabel, getUserSecondaryLabel } from "@/lib/user-display";
import { getUserGroupDetail } from "@/lib/user-groups";
import { UserGroupMembersManager } from "./user-group-members-manager";
import { EditUserGroupDialog, UserGroupPermissionsForm } from "./user-group-settings-forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface ExtendedUser {
  tenantId?: string;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function UserGroupDetailPage({ params }: PageProps) {
  const [{ id }, session] = await Promise.all([params, requireAdmin()]);
  const sessionUser = session.user as ExtendedUser;
  const tenantId = sessionUser.tenantId;

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

        <EditUserGroupDialog userGroupId={detail.group.id} name={detail.group.name} description={detail.group.description} />
      </div>

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
        <UserGroupMembersManager
          userGroupId={detail.group.id}
          members={detail.members}
          availableUsers={availableUsers}
        />

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
                <p className="font-medium">{getUserPrimaryLabel(user)}</p>
                {getUserSecondaryLabel(user) && (
                  <p className="text-xs text-muted-foreground">
                    {getUserSecondaryLabel(user)}
                  </p>
                )}
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
          <UserGroupPermissionsForm
            userGroupId={detail.group.id}
            tenantAgentGroups={detail.tenantAgentGroups}
            allowedAgentGroupIds={detail.allowedAgentGroupIds}
          />
        </CardContent>
      </Card>
    </div>
  );
}
