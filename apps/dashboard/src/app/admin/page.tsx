import Link from "next/link";
import { redirect } from "next/navigation";
import { getApiClient } from "@/lib/api-client";
import { requireAuth } from "@/lib/auth";
import type { Agent, AgentGroup, AuditLog, Rule, RuleSet } from "@monet/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  History,
  Layers,
  Scale,
  ShieldCheck,
  Users,
} from "lucide-react";

function formatDate(value: string | Date) {
  return new Date(value).toLocaleString();
}

function formatAction(action: string) {
  return action.replace(/[._]/g, " ");
}

export default async function AdminOverviewPage() {
  const session = await requireAuth();
  const sessionUser = session.user as { role?: string | null };
  if (sessionUser.role !== "tenant_admin") {
    redirect("/");
  }

  let rules: Rule[] = [];
  let ruleSets: RuleSet[] = [];
  let agents: Agent[] = [];
  let groups: AgentGroup[] = [];
  let audit: AuditLog[] = [];
  let fatalError = "";
  const partialErrors: string[] = [];

  try {
    const client = await getApiClient();
    const results = await Promise.allSettled([
      client.listRules(),
      client.listRuleSets(),
      client.listAgents(),
      client.listGroups(),
      client.getAuditLogs({ limit: 20 }),
    ]);

    if (results[0].status === "fulfilled") {
      rules = (results[0].value as { rules: Rule[] }).rules;
    } else {
      partialErrors.push("Rules could not be loaded.");
    }

    if (results[1].status === "fulfilled") {
      ruleSets = (results[1].value as { ruleSets: RuleSet[] }).ruleSets;
    } else {
      partialErrors.push("Rule sets could not be loaded.");
    }

    if (results[2].status === "fulfilled") {
      agents = results[2].value as Agent[];
    } else {
      partialErrors.push("Agents could not be loaded.");
    }

    if (results[3].status === "fulfilled") {
      groups = (results[3].value as { groups: AgentGroup[] }).groups;
    } else {
      partialErrors.push("Groups could not be loaded.");
    }

    if (results[4].status === "fulfilled") {
      const auditResult = results[4].value as { items: AuditLog[] };
      audit = auditResult.items.filter((e) =>
        e.action.startsWith("rule.") ||
        e.action.startsWith("rule_set.") ||
        e.action.startsWith("rule_set_rule.") ||
        e.action.startsWith("agent_rule_set.")
      );
    } else {
      partialErrors.push("Audit logs could not be loaded.");
    }
  } catch (err: unknown) {
    fatalError = err instanceof Error ? err.message : "Failed to load admin data";
  }

  const ruleNameById = new Map(rules.map((r) => [r.id, r.name]));

  return (
    <div className="flex flex-col gap-6 p-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Policy Overview</h1>
        <p className="text-muted-foreground mt-1">
          Admin dashboard showing rule coverage, governance, and recent policy changes.
        </p>
      </div>

      {fatalError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load admin data</AlertTitle>
          <AlertDescription>{fatalError}</AlertDescription>
        </Alert>
      )}

      {!fatalError && partialErrors.length > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Some data is unavailable</AlertTitle>
          <AlertDescription>{partialErrors.join(" ")}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Scale className="h-4 w-4" />
              Shared Rules
            </CardDescription>
            <CardTitle className="text-2xl">{rules.length}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm" variant="ghost" className="px-0">
              <Link href="/admin/rules">Manage Rules</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Layers className="h-4 w-4" />
              Rule Sets
            </CardDescription>
            <CardTitle className="text-2xl">{ruleSets.length}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm" variant="ghost" className="px-0">
              <Link href="/admin/rules">Manage Rule Sets</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Bot className="h-4 w-4" />
              Agents
            </CardDescription>
            <CardTitle className="text-2xl">{agents.length}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm" variant="ghost" className="px-0">
              <Link href="/agents">View Agents</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Groups
            </CardDescription>
            <CardTitle className="text-2xl">{groups.length}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm" variant="ghost" className="px-0">
              <Link href="/admin/groups">Manage Groups</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              Rule Set Coverage
            </CardTitle>
            <CardDescription>
              Rule sets and the rules they contain.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {ruleSets.length === 0 ? (
              <p className="text-sm text-muted-foreground">No rule sets defined yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rule Set</TableHead>
                    <TableHead className="w-[80px] text-center">Rules</TableHead>
                    <TableHead>Contains</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ruleSets.map((rs) => (
                    <TableRow key={rs.id}>
                      <TableCell className="font-medium">
                        <Link href={`/admin/rules/sets/${rs.id}`} className="hover:underline">
                          {rs.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary">{rs.ruleIds.length}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {rs.ruleIds.length === 0
                          ? "Empty"
                          : rs.ruleIds
                              .slice(0, 3)
                              .map((id) => ruleNameById.get(id) ?? id.slice(0, 8))
                              .join(", ") + (rs.ruleIds.length > 3 ? ` +${rs.ruleIds.length - 3} more` : "")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              Recent Policy Changes
            </CardTitle>
            <CardDescription>
              Rule and policy audit events.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {audit.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent policy changes.</p>
            ) : (
              <div className="space-y-3">
                {audit.slice(0, 10).map((entry) => (
                  <div key={entry.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant={entry.outcome === "success" ? "secondary" : "destructive"} className="text-[10px] uppercase">
                          {entry.outcome}
                        </Badge>
                        <span className="text-sm font-medium">{formatAction(entry.action)}</span>
                      </div>
                      {entry.actor_display_name && (
                        <p className="text-xs text-muted-foreground">by {entry.actor_display_name}</p>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(entry.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <Button asChild size="sm" variant="ghost" className="px-0 mt-3">
              <Link href="/admin/audit">
                View Full Audit Log
                <ArrowRight className="ml-2 h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
