"use client";

import { useState, useEffect } from "react";
import { getAgentStatusAction } from "./actions";
import { Agent } from "@monet/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Bot, User, Activity, ShieldAlert, Calendar } from "lucide-react";

interface AgentListProps {
  initialAgents: Agent[];
  initialGroupMemberships: Record<string, string[]>;
}

export default function AgentList({ initialAgents, initialGroupMemberships }: AgentListProps) {
  const [agents] = useState<Agent[]>(initialAgents);
  const [statuses, setStatuses] = useState<Record<string, { activeSessions: number; revoked: boolean }>>({});

  useEffect(() => {
    const fetchStatuses = async () => {
      const newStatuses: Record<string, { activeSessions: number; revoked: boolean }> = {};
      await Promise.all(
        agents.map(async (agent) => {
          try {
            const status = await getAgentStatusAction(agent.id);
            newStatuses[agent.id] = status;
          } catch {
            newStatuses[agent.id] = { activeSessions: 0, revoked: false };
          }
        }),
      );
      setStatuses(newStatuses);
    };

    fetchStatuses();
    const interval = setInterval(fetchStatuses, 5000);
    return () => clearInterval(interval);
  }, [agents]);

  return (
    <Card className="shadow-sm">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Sessions</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Groups</TableHead>
              <TableHead className="text-right">Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No agents registered in this tenant.
                </TableCell>
              </TableRow>
            ) : (
              agents.map((agent) => {
                const info = statuses[agent.id];
                const activeSessions = info?.activeSessions ?? 0;
                const revoked = info?.revoked ?? false;
                const groups = initialGroupMemberships[agent.id] ?? [];

                return (
                  <TableRow key={agent.id} className="hover:bg-muted/50 transition-colors">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
                          {agent.isAutonomous ? <Bot className="h-5 w-5 text-primary" /> : <User className="h-5 w-5 text-muted-foreground" />}
                        </div>
                        <div className="flex flex-col">
                          <span className="font-semibold text-sm">{agent.externalId}</span>
                          <span className="text-[10px] font-mono text-muted-foreground">{agent.id}</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-sm">
                        <Activity className={`h-3.5 w-3.5 ${activeSessions > 0 ? "text-green-500 animate-pulse" : "text-muted-foreground"}`} />
                        <span>{activeSessions} active</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {revoked ? (
                        <Badge variant="destructive" className="uppercase text-[10px] gap-1">
                          <ShieldAlert className="h-3 w-3" />
                          Revoked
                        </Badge>
                      ) : activeSessions > 0 ? (
                        <Badge variant="default" className="bg-green-600 hover:bg-green-600 uppercase text-[10px]">
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
