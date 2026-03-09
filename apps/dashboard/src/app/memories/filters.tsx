"use client";

import { MemoryType } from "@monet/types";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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

interface MemoryFiltersProps {
  initialType?: MemoryType;
  initialIncludeUser: boolean;
  initialIncludePrivate: boolean;
}

export function MemoryFilters({
  initialType,
  initialIncludeUser,
  initialIncludePrivate,
}: MemoryFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const updateUrl = (updates: Record<string, string | boolean | undefined>) => {
    const params = new URLSearchParams(searchParams.toString());
    Object.entries(updates).forEach(([key, value]) => {
      if (value === undefined || value === false || value === "" || value === "all") {
        params.delete(key);
      } else {
        params.set(key, String(value));
      }
    });
    params.delete("cursor");
    startTransition(() => {
      router.push(`/memories?${params.toString()}`);
    });
  };

  return (
    <div className="flex flex-wrap gap-6 items-end p-4 border rounded-lg bg-card mb-6 shadow-sm relative">
      {isPending && (
        <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-10 rounded-lg">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}
      <div className="grid gap-2 min-w-[180px]">
        <Label className="text-xs uppercase text-muted-foreground font-semibold">Memory Type</Label>
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
        {(initialType || initialIncludeUser || initialIncludePrivate) && (
          <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
            <Link href="/memories">
              <X className="mr-2 h-4 w-4" />
              Clear Filters
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
