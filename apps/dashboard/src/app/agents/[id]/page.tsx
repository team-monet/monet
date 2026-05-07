import Link from "next/link";
import { Activity, ArrowLeft, Bot, Calendar, ShieldAlert, User, Users } from "lucide-react";
import type { AgentDetail, RuleSet } from "@monet/types";
import { getApiClient } from "@/lib/api-client";
import { requireAuth } from "@/lib/auth";
import { formatAgentDisplayName } from "@/lib/agent-display";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import AgentDetailActions from "./agent-detail-actions";
import { AgentRulesManager } from "./agent-rules-manager";

interface ExtendedUser {
  id?: string;
  role?: string | null;
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AgentDetailPage({ params }: PageProps) {
  const [{ id }, session] = await Promise.all([params, requireAuth()]);
  const sessionUser = session.user as ExtendedUser;
  const isAdmin = sessionUser.role === "tenant_admin";

  let agent: AgentDetail | null = null;
  let status: { activeSessions: number; revoked: boolean } | null = null;
  let sharedRuleSets: RuleSet[] = [];
  let personalRuleSets: RuleSet[] = [];
  let error = "";

  try {
    const client = await getApiClient();
    [agent, status] = await Promise.all([
      client.getAgent(id),
      client.getAgentStatus(id),
    ]);

    const canManageRuleSets = Boolean(agent) && (isAdmin || (agent.userId != null && agent.userId === sessionUser.id));
    if (canManageRuleSets) {
      sharedRuleSets = (await client.listRuleSets()).ruleSets;
      if (agent.userId != null && agent.userId === sessionUser.id) {
        personalRuleSets = (await client.listPersonalRuleSets()).ruleSets;
      }
    }
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "Failed to load agent details";
  }

  if (error || !agent || !status) {
    return (
      <div className="flex flex-col gap-6 p-4">
        <Button asChild variant="outline" className="w-fit">
          <Link href="/agents">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Agents
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertTitle>Could not load agent</AlertTitle>
          <AlertDescription>{error || "The requested agent could not be found."}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const isOwnedBySessionUser = agent.userId != null && agent.userId === sessionUser.id;
  const canRegenerate = isAdmin || isOwnedBySessionUser;
  const canManageRuleSets = isAdmin || isOwnedBySessionUser;
  const availableRuleSets = [...sharedRuleSets, ...personalRuleSets].filter(
    (ruleSet) => !agent.ruleSets.some((attachedRuleSet) => attachedRuleSet.id === ruleSet.id),
  );

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <Button asChild variant="outline" size="sm" className="w-fit">
            <Link href="/agents">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Agents
            </Link>
          </Button>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-bold tracking-tight">
                {formatAgentDisplayName(agent)}
              </h1>
              {isOwnedBySessionUser && <Badge variant="secondary">Yours</Badge>}
              {status.revoked && (
                <Badge variant="destructive" className="gap-1">
                  <ShieldAlert className="h-3 w-3" />
                  Revoked
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground">
              {agent.isAutonomous
                ? "Autonomous tenant agent"
                : `User Proxy agent${agent.owner?.label ? ` for ${agent.owner.label}` : ""}`}
            </p>
          </div>
        </div>

        <div className="flex flex-col items-start gap-2 md:items-end">
          <div className="flex gap-2">
            <Badge variant="outline" className="font-normal uppercase">
              {agent.isAutonomous ? (
                <>
                  <Bot className="mr-1 h-3 w-3" />
                  Autonomous
                </>
              ) : (
                <>
                  <User className="mr-1 h-3 w-3" />
                  User Proxy
                </>
              )}
            </Badge>
            <Badge variant={status.activeSessions > 0 ? "default" : "secondary"} className={status.activeSessions > 0 ? "bg-green-600 hover:bg-green-600" : ""}>
              <Activity className="mr-1 h-3 w-3" />
              {status.activeSessions} active session{status.activeSessions === 1 ? "" : "s"}
            </Badge>
          </div>
          <AgentDetailActions
            agentId={agent.id}
            canRegenerate={canRegenerate}
            isAdmin={isAdmin}
            isRevoked={status.revoked}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Agent UUID</CardDescription>
            <CardTitle className="text-sm font-mono break-all">{agent.id}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Created</CardDescription>
            <CardTitle className="text-base">
              <span className="inline-flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                {new Date(agent.createdAt).toLocaleString()}
              </span>
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Owner</CardDescription>
            <CardTitle className="text-base">
              {agent.isAutonomous ? "Autonomous" : agent.owner?.label ?? "Unbound"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Status</CardDescription>
            <CardTitle className="text-base">
              {status.revoked ? "Revoked" : status.activeSessions > 0 ? "Online" : "Offline"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Groups
            </CardTitle>
            <CardDescription>Current group memberships for this agent.</CardDescription>
          </CardHeader>
          <CardContent>
            {agent.groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">This agent is not assigned to any groups.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {agent.groups.map((group) => (
                  <Badge key={group.id} variant="secondary" className="font-normal">
                    {group.name}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Identity</CardTitle>
            <CardDescription>Display and ownership metadata.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="text-muted-foreground">Display name</p>
              <p className="font-medium">{formatAgentDisplayName(agent)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Raw name</p>
              <p className="font-medium">{agent.externalId}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Owner label</p>
              <p className="font-medium">{agent.owner?.label ?? "Autonomous"}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {(canManageRuleSets || agent.ruleSets.length > 0) && (
        <AgentRulesManager
          agentId={agent.id}
          sessionUserId={sessionUser.id}
          canManageRuleSets={canManageRuleSets}
          isOwnedBySessionUser={isOwnedBySessionUser}
          attachedRuleSets={agent.ruleSets}
          availableRuleSets={availableRuleSets}
        />
      )}
    </div>
  );
}
