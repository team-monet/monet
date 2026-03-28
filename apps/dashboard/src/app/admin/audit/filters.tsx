"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, X } from "lucide-react";

interface AuditFiltersProps {
  initialAction?: string;
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

export function AuditFilters({ initialAction }: AuditFiltersProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const currentQuery = searchParams.toString();

  const updateAction = (value: string) => {
    const params = new URLSearchParams(currentQuery);
    if (value === "all") {
      params.delete("action");
    } else {
      params.set("action", value);
    }
    params.delete("cursor");

    const query = params.toString();
    const nextUrl = query ? `${pathname}?${query}` : pathname;

    if (nextUrl === (currentQuery ? `${pathname}?${currentQuery}` : pathname)) {
      return;
    }

    startTransition(() => {
      router.replace(nextUrl);
    });
  };

  return (
    <div className="p-4 grid gap-4 md:grid-cols-[minmax(220px,280px)_1fr] items-end">
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-xs uppercase text-muted-foreground font-semibold">Action Type</Label>
        </div>
        <Select value={initialAction ?? "all"} onValueChange={updateAction}>
          <SelectTrigger>
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
            onClick={() => {
              if (!currentQuery) return;
              startTransition(() => {
                router.replace(pathname);
              });
            }}
          >
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading...
              </>
            ) : (
              <>
                <X className="mr-2 h-4 w-4" />
                Clear Filter
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
