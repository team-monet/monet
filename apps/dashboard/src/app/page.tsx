import Link from "next/link";
import { getApiClient } from "@/lib/api-client";
import { requireAuth } from "@/lib/auth";
import type { Agent, AgentGroup, AuditLog, MemoryEntryTier1, Rule } from "@monet/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Bot,
  History,
  Scale,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";

interface ExtendedUser {
  name?: string | null;
  role?: string | null;
}

function formatDate(value: string | Date) {
  return new Date(value).toLocaleString();
}

export default async function DashboardPage() {
  const session = await requireAuth();
  const sessionUser = session.user as ExtendedUser;
  const isAdmin = sessionUser.role === "tenant_admin";

  let memories: MemoryEntryTier1[] = [];
  let memoryHasMore = false;
  let agents: Agent[] = [];
  let groups: AgentGroup[] = [];
  let rules: Rule[] = [];
  let audit: AuditLog[] = [];
  let fatalError = "";
  const partialErrors: string[] = [];

  try {
    const client = await getApiClient();
    const requests: Array<Promise<unknown>> = [
      client.listMemories({ limit: 20, includeUser: true, includePrivate: true }),
      client.listAgents(),
      client.listGroups(),
      client.listRules(),
    ];

    if (isAdmin) {
      requests.push(client.getAuditLogs({ limit: 5 }));
    }

    const results = await Promise.allSettled(requests);

    const memoryResult = results[0];
    if (memoryResult.status === "fulfilled") {
      const value = memoryResult.value as { items: MemoryEntryTier1[]; nextCursor: string | null };
      memories = value.items;
      memoryHasMore = value.nextCursor !== null;
    } else {
      partialErrors.push("Memories could not be loaded.");
    }

    const agentResult = results[1];
    if (agentResult.status === "fulfilled") {
      agents = agentResult.value as Agent[];
    } else {
      partialErrors.push("Agents could not be loaded.");
    }

    const groupResult = results[2];
    if (groupResult.status === "fulfilled") {
      groups = (groupResult.value as { groups: AgentGroup[] }).groups;
    } else {
      partialErrors.push("Groups could not be loaded.");
    }

    const rulesResult = results[3];
    if (rulesResult?.status === "fulfilled") {
      rules = (rulesResult.value as { rules: Rule[] }).rules;
    } else {
      partialErrors.push("Rules summary could not be loaded.");
    }

    if (isAdmin) {
      const auditResult = results[4];
      if (auditResult?.status === "fulfilled") {
        audit = (auditResult.value as { items: AuditLog[] }).items;
      } else {
        partialErrors.push("Audit summary could not be loaded.");
      }
    }
  } catch (err: unknown) {
    fatalError = err instanceof Error ? err.message : "Failed to load dashboard data";
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Welcome back{sessionUser.name ? `, ${sessionUser.name}` : ""}. Here is the latest platform snapshot.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/memories/search">
              <Search className="mr-2 h-4 w-4" />
              Search
            </Link>
          </Button>
          <Button asChild>
            <Link href="/memories">
              <BookOpen className="mr-2 h-4 w-4" />
              View Memories
            </Link>
          </Button>
        </div>
      </div>

      {fatalError && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load dashboard</AlertTitle>
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
              <BookOpen className="h-4 w-4" />
              Memories
            </CardDescription>
            <CardTitle className="text-2xl">{memoryHasMore ? `${memories.length}+` : memories.length}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm" variant="ghost" className="px-0">
              <Link href="/memories">Open Memories</Link>
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
              <Link href="/agents">Manage Agents</Link>
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
            {isAdmin ? (
              <Button asChild size="sm" variant="ghost" className="px-0">
                <Link href="/admin/groups">Manage Groups</Link>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">Group management requires tenant admin access.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Access Level
            </CardDescription>
            <CardTitle className="text-2xl">{isAdmin ? "Admin" : "User"}</CardTitle>
          </CardHeader>
          <CardContent>
            {isAdmin ? (
              <Button asChild size="sm" variant="ghost" className="px-0">
                <Link href="/admin/audit">Open Audit Log</Link>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">Admin tools are hidden for your role.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Recent Memories</CardTitle>
            <CardDescription>Most recent memory entries available to your dashboard agent.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {memories.length === 0 ? (
              <p className="text-sm text-muted-foreground">No memories found.</p>
            ) : (
              memories.slice(0, 6).map((memory) => (
                <div key={memory.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="uppercase text-[10px]">
                        {memory.memoryType}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{formatDate(memory.createdAt)}</span>
                    </div>
                    <p className="text-sm font-medium line-clamp-2">{memory.summary}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">{memory.id}</p>
                  </div>
                  <Button asChild size="icon" variant="ghost" className="h-8 w-8 shrink-0">
                    <Link href={`/memories/${memory.id}`}>
                      <ArrowRight className="h-4 w-4" />
                      <span className="sr-only">Open memory</span>
                    </Link>
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{isAdmin ? "Rules & Audit" : "Rules"}</CardTitle>
            <CardDescription>
              {isAdmin
                ? "Shared guidance and recent control-plane activity."
                : "Shared guidance available to every tenant user."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border p-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Scale className="h-4 w-4" />
                Shared Rules
              </div>
              <p className="mt-1 text-2xl font-semibold">{rules.length}</p>
              <Button asChild size="sm" variant="ghost" className="px-0 mt-1">
                <Link href={isAdmin ? "/admin/rules" : "/rules"}>{isAdmin ? "Manage Rules" : "Open My Rules"}</Link>
              </Button>
            </div>

            {isAdmin ? (
              <>
                <div className="rounded-md border p-3">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <History className="h-4 w-4" />
                    Recent Audit Events
                  </div>
                  {audit.length === 0 ? (
                    <p className="mt-2 text-sm text-muted-foreground">No recent audit entries.</p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {audit.slice(0, 4).map((entry) => (
                        <div key={entry.id} className="text-sm">
                          <div className="font-medium">{entry.action.replace(/_/g, " ")}</div>
                          <div className="text-xs text-muted-foreground">{formatDate(entry.created_at)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  <Button asChild size="sm" variant="ghost" className="px-0 mt-2">
                    <Link href="/admin/audit">View Audit Log</Link>
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                You can create personal rules for yourself, and tenant admins still manage the shared catalog.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
