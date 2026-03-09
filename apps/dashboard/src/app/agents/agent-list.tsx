"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Agent } from "@monet/types";
import { Activity, Bot, Calendar, ChevronRight, ShieldAlert, User } from "lucide-react";
import { getAgentStatusAction } from "./actions";
import { formatAgentDisplayName } from "@/lib/agent-display";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface AgentListProps {
  initialAgents: Agent[];
  initialGroupMemberships: Record<string, string[]>;
  isAdmin: boolean;
}

export default function AgentList({
  initialAgents,
  initialGroupMemberships,
  isAdmin,
}: AgentListProps) {
  const router = useRouter();
  const [statuses, setStatuses] = useState<Record<string, { activeSessions: number; revoked: boolean }>>({});

  useEffect(() => {
    const fetchStatuses = async () => {
      const nextStatuses: Record<string, { activeSessions: number; revoked: boolean }> = {};

      await Promise.all(
        initialAgents.map(async (agent) => {
          try {
            nextStatuses[agent.id] = await getAgentStatusAction(agent.id);
          } catch {
            nextStatuses[agent.id] = {
              activeSessions: 0,
              revoked: Boolean(agent.revokedAt),
            };
          }
        }),
      );

      setStatuses(nextStatuses);
    };

    void fetchStatuses();
    const interval = window.setInterval(fetchStatuses, 5000);
    return () => window.clearInterval(interval);
  }, [initialAgents]);

  const columnCount = isAdmin ? 7 : 6;

  return (
    <Card className="shadow-sm">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              {isAdmin && <TableHead>Owner</TableHead>}
              <TableHead>Sessions</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Groups</TableHead>
              <TableHead className="text-right">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initialAgents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="h-24 text-center text-muted-foreground">
                  {isAdmin ? "No agents registered in this tenant." : "You have not registered any agents yet."}
                </TableCell>
              </TableRow>
            ) : (
              initialAgents.map((agent) => {
                const info = statuses[agent.id];
                const activeSessions = info?.activeSessions ?? 0;
                const revoked = info?.revoked ?? Boolean(agent.revokedAt);
                const groups = initialGroupMemberships[agent.id] ?? [];

                return (
                  <TableRow
                    key={agent.id}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                    onClick={() => router.push(`/agents/${agent.id}`)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        router.push(`/agents/${agent.id}`);
                      }
                    }}
                    tabIndex={0}
                    role="link"
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
                          {agent.isAutonomous ? (
                            <Bot className="h-5 w-5 text-primary" />
                          ) : (
                            <User className="h-5 w-5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-semibold text-sm">
                            {formatAgentDisplayName(agent)}
                          </span>
                          <span className="truncate text-[10px] font-mono text-muted-foreground">
                            {agent.id}
                          </span>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </TableCell>

                    {isAdmin && (
                      <TableCell>
                        <span className="text-sm text-muted-foreground">
                          {agent.isAutonomous ? "Autonomous" : agent.owner?.label ?? "-"}
                        </span>
                      </TableCell>
                    )}

                    <TableCell>
                      <div className="flex items-center gap-1.5 text-sm">
                        <Activity
                          className={`h-3.5 w-3.5 ${
                            activeSessions > 0 ? "text-green-500 animate-pulse" : "text-muted-foreground"
                          }`}
                        />
                        <span>{activeSessions} active</span>
                      </div>
                    </TableCell>

                    <TableCell>
                      {revoked ? (
                        <Badge variant="destructive" className="gap-1 uppercase text-[10px]">
                          <ShieldAlert className="h-3 w-3" />
                          Revoked
                        </Badge>
                      ) : activeSessions > 0 ? (
                        <Badge variant="default" className="bg-green-600 uppercase text-[10px] hover:bg-green-600">
                          Online
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="uppercase text-[10px]">
                          Offline
                        </Badge>
                      )}
                    </TableCell>

                    <TableCell>
                      <Badge variant="outline" className="font-normal text-[10px] uppercase">
                        {agent.isAutonomous ? "Autonomous" : "Human Proxy"}
                      </Badge>
                    </TableCell>

                    <TableCell>
                      {groups.length === 0 ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {groups.slice(0, 2).map((groupName) => (
                            <Badge key={groupName} variant="secondary" className="text-[10px] font-normal">
                              {groupName}
                            </Badge>
                          ))}
                          {groups.length > 2 && (
                            <Badge variant="outline" className="text-[10px] font-normal">
                              +{groups.length - 2}
                            </Badge>
                          )}
                        </div>
                      )}
                    </TableCell>

                    <TableCell className="text-right" suppressHydrationWarning>
                      <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        {new Date(agent.createdAt).toLocaleDateString()}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
