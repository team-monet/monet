import Link from "next/link";
import { Activity, ArrowLeft, Bot, Calendar, Scale, ShieldAlert, User, Users } from "lucide-react";
import type { AgentDetail, RuleSet } from "@monet/types";
import { getApiClient } from "@/lib/api-client";
import { requireAuth } from "@/lib/auth";
import { formatAgentDisplayName } from "@/lib/agent-display";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import AgentDetailActions from "./agent-detail-actions";
import { attachRuleSetToAgentAction, detachRuleSetFromAgentAction } from "./actions";

interface ExtendedUser {
  id?: string;
  role?: string | null;
}

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function getSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AgentDetailPage({ params, searchParams }: PageProps) {
  const [{ id }, query, session] = await Promise.all([params, searchParams, requireAuth()]);
  const sessionUser = session.user as ExtendedUser;
  const isAdmin = sessionUser.role === "tenant_admin";
  const isOwnAgent = sessionUser.id !== undefined;
  const ruleSetAttached = getSingleParam(query.ruleSetAttached) === "1";
  const ruleSetDetached = getSingleParam(query.ruleSetDetached) === "1";
  const ruleSetError = getSingleParam(query.ruleSetError);

  let agent: AgentDetail | null = null;
  let status: { activeSessions: number; revoked: boolean } | null = null;
  let allRuleSets: RuleSet[] = [];
  let error = "";

  try {
    const client = await getApiClient();
    [agent, status] = await Promise.all([
      client.getAgent(id),
      client.getAgentStatus(id),
    ]);

    const canManageRuleSets = Boolean(agent) && (isAdmin || agent.userId === sessionUser.id);
    if (canManageRuleSets) {
      allRuleSets = (await client.listRuleSets()).ruleSets;
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

  const yours = agent.userId === sessionUser.id && isOwnAgent;
  const canRegenerate = isAdmin || yours;
  const canManageRuleSets = isAdmin || yours;
  const availableRuleSets = allRuleSets.filter(
    (ruleSet) => !agent.ruleSets.some((attachedRuleSet) => attachedRuleSet.id === ruleSet.id),
  );
  const returnTo = `/agents/${agent.id}`;

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
              {yours && <Badge variant="secondary">Yours</Badge>}
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

      {ruleSetAttached && (
        <Alert>
          <AlertTitle>Rule set attached</AlertTitle>
          <AlertDescription>The selected rule set is now attached to this agent.</AlertDescription>
        </Alert>
      )}

      {ruleSetDetached && (
        <Alert>
          <AlertTitle>Rule set detached</AlertTitle>
          <AlertDescription>The rule set was removed from this agent.</AlertDescription>
        </Alert>
      )}

      {ruleSetError && (
        <Alert variant="destructive">
          <AlertTitle>Rule set update failed</AlertTitle>
          <AlertDescription>{ruleSetError}</AlertDescription>
        </Alert>
      )}

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
        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Scale className="h-4 w-4" />
                Direct Rule Sets
              </CardTitle>
              <CardDescription>
                Rule sets currently attached directly to this agent. Group-inherited guidance is applied separately.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {agent.ruleSets.length === 0 ? (
                <p className="text-sm text-muted-foreground">No direct rule sets are attached to this agent.</p>
              ) : (
                agent.ruleSets.map((ruleSet) => (
                  <div key={ruleSet.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                    <div className="space-y-1">
                      <Link href={`/admin/rules/sets/${ruleSet.id}`} className="font-medium hover:underline">
                        {ruleSet.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {ruleSet.ruleIds.length} {ruleSet.ruleIds.length === 1 ? "rule" : "rules"}
                      </p>
                    </div>
                    {canManageRuleSets && (
                      <form action={detachRuleSetFromAgentAction}>
                        <input type="hidden" name="agentId" value={agent.id} />
                        <input type="hidden" name="ruleSetId" value={ruleSet.id} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <SubmitButton label="Detach" pendingLabel="Detaching..." variant="outline" size="sm" />
                      </form>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Attach Rule Set</CardTitle>
              <CardDescription>
                {canManageRuleSets
                  ? "Apply a shared rule set from the tenant catalog to this agent."
                  : "Only tenant admins or the agent owner can modify direct rule sets."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {canManageRuleSets ? (
                <>
                  <form action={attachRuleSetToAgentAction} className="space-y-3">
                    <input type="hidden" name="agentId" value={agent.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <div className="grid gap-2">
                      <label htmlFor="ruleSetId" className="text-sm font-medium">
                        Available rule sets
                      </label>
                      <select
                        id="ruleSetId"
                        name="ruleSetId"
                        className="h-10 rounded-md border bg-background px-3 text-sm"
                        defaultValue={availableRuleSets[0]?.id ?? ""}
                        disabled={availableRuleSets.length === 0}
                      >
                        {availableRuleSets.length === 0 ? (
                          <option value="">No more rule sets available</option>
                        ) : (
                          availableRuleSets.map((ruleSet) => (
                            <option key={ruleSet.id} value={ruleSet.id}>
                              {ruleSet.name}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    <SubmitButton
                      label="Attach Rule Set"
                      pendingLabel="Attaching..."
                      className="w-full"
                      disabled={availableRuleSets.length === 0}
                    />
                  </form>
                  <Button asChild variant="ghost" className="px-0">
                    <Link href="/admin/rules">Browse shared rules</Link>
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Rule sets can be reviewed in the shared rules catalog.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
