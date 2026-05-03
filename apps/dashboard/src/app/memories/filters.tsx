"use client";

import { MemoryType } from "@monet/types";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import {
  Select as ShadSelect,
  SelectContent as ShadSelectContent,
  SelectItem as ShadSelectItem,
  SelectTrigger as ShadSelectTrigger,
  SelectValue as ShadSelectValue
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, X } from "lucide-react";

interface GroupOption {
  id: string;
  name: string;
}

interface MemoryFiltersProps {
  initialType?: MemoryType;
  initialGroupId?: string;
  initialIncludeUser: boolean;
  initialIncludePrivate: boolean;
  groups: GroupOption[];
}

export function MemoryFilters({
  initialType,
  initialGroupId,
  initialIncludeUser,
  initialIncludePrivate,
  groups,
}: MemoryFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const currentQuery = searchParams.toString();

  const updateUrl = (updates: Record<string, string | boolean | undefined>) => {
    const params = new URLSearchParams(currentQuery);
    Object.entries(updates).forEach(([key, value]) => {
      if (value === undefined || value === false || value === "" || value === "all") {
        params.delete(key);
      } else {
        params.set(key, String(value));
      }
    });
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
    <div className="relative mb-6 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-end gap-6">
        <div className="grid min-w-[180px] gap-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs uppercase text-muted-foreground font-semibold">Memory Type</Label>
          </div>
          <ShadSelect
            value={initialType || "all"}
            onValueChange={(val) => updateUrl({ memoryType: val === "all" ? "" : val })}
          >
            <ShadSelectTrigger>
              <ShadSelectValue placeholder="Select type" />
            </ShadSelectTrigger>
            <ShadSelectContent>
              <ShadSelectItem value="all">All Types</ShadSelectItem>
              <ShadSelectItem value="fact">Fact</ShadSelectItem>
              <ShadSelectItem value="preference">Preference</ShadSelectItem>
              <ShadSelectItem value="decision">Decision</ShadSelectItem>
              <ShadSelectItem value="pattern">Pattern</ShadSelectItem>
              <ShadSelectItem value="issue">Issue</ShadSelectItem>
              <ShadSelectItem value="procedure">Procedure</ShadSelectItem>
            </ShadSelectContent>
          </ShadSelect>
        </div>

        <div className="grid min-w-[180px] gap-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs uppercase text-muted-foreground font-semibold">Group</Label>
          </div>
          <ShadSelect
            value={initialGroupId || "all"}
            onValueChange={(val) => updateUrl({ groupId: val === "all" ? "" : val })}
          >
            <ShadSelectTrigger>
              <ShadSelectValue placeholder="Select group" />
            </ShadSelectTrigger>
            <ShadSelectContent>
              <ShadSelectItem value="all">All Groups</ShadSelectItem>
              {groups.map((g) => (
                <ShadSelectItem key={g.id} value={g.id}>
                  {g.name}
                </ShadSelectItem>
              ))}
            </ShadSelectContent>
          </ShadSelect>
        </div>

        <div className="flex items-center gap-6 py-2">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="includeUser"
              checked={initialIncludeUser}
              onCheckedChange={(checked) => updateUrl({ includeUser: !!checked })}
            />
            <Label htmlFor="includeUser" className="text-sm cursor-pointer">Include User</Label>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="includePrivate"
              checked={initialIncludePrivate}
              onCheckedChange={(checked) => updateUrl({ includePrivate: !!checked })}
            />
            <Label htmlFor="includePrivate" className="text-sm cursor-pointer">Include Private</Label>
          </div>
        </div>

        <div className="ml-auto">
          {(initialType || initialGroupId || initialIncludeUser || initialIncludePrivate || currentQuery) && (
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
                  Clear Filters
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
