"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, X } from "lucide-react";

interface AuditFiltersProps {
  initialAction?: string;
  stateKey: string;
}

const ACTION_OPTIONS = [
  { value: "memory.create", label: "Memory Create" },
  { value: "memory.update", label: "Memory Update" },
  { value: "memory.delete", label: "Memory Delete" },
  { value: "memory.mark_outdated", label: "Memory Mark Outdated" },
  { value: "memory.scope_change", label: "Memory Scope Change" },
  { value: "rule.create", label: "Rule Create" },
  { value: "rule.update", label: "Rule Update" },
  { value: "rule.delete", label: "Rule Delete" },
  { value: "rule_set.create", label: "Rule Set Create" },
  { value: "rule_set.delete", label: "Rule Set Delete" },
  { value: "rule_set_rule.add", label: "Rule Set Rule Add" },
  { value: "rule_set_rule.remove", label: "Rule Set Rule Remove" },
  { value: "agent_rule_set.associate", label: "Agent Rule Set Associate" },
  { value: "agent_rule_set.dissociate", label: "Agent Rule Set Dissociate" },
];

export function AuditFilters({ initialAction, stateKey }: AuditFiltersProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isUpdating, setIsUpdating] = useState(false);
  const [, startTransition] = useTransition();
  const currentQuery = searchParams.toString();

  // Clear loading state when the server-rendered page state updates.
  useEffect(() => {
    setIsUpdating(false);
  }, [stateKey]);

  // Safety timeout
  useEffect(() => {
    if (!isUpdating) return;
    const timer = setTimeout(() => setIsUpdating(false), 5000);
    return () => clearTimeout(timer);
  }, [isUpdating]);

  const updateAction = (value: string) => {
    const params = new URLSearchParams(currentQuery);
    if (value === "all") {
      params.delete("action");
    } else {
      params.set("action", value);
    }
    params.delete("cursor");

    const nextQuery = params.toString();
    if (nextQuery === currentQuery) {
      return;
    }

    const nextUrl = nextQuery ? `${pathname}?${nextQuery}` : pathname;
    
    setIsUpdating(true);
    startTransition(() => {
      router.replace(nextUrl);
    });
  };

  return (
    <div className="p-4 grid gap-4 md:grid-cols-[minmax(220px,280px)_1fr] items-end">
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-xs uppercase text-muted-foreground font-semibold">Action Type</Label>
          {isUpdating ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading...
            </span>
          ) : null}
        </div>
        <Select value={initialAction ?? "all"} onValueChange={updateAction} disabled={isUpdating}>
          <SelectTrigger aria-busy={isUpdating}>
            <SelectValue placeholder="All Actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Actions</SelectItem>
            {ACTION_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex justify-start md:justify-end">
        {initialAction && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={isUpdating}
            onClick={() => updateAction("all")}
          >
            {isUpdating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <X className="mr-2 h-4 w-4" />
            )}
            {isUpdating ? "Loading..." : "Clear Filter"}
          </Button>
        )}
      </div>
    </div>
  );
}
