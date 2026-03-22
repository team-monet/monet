"use client";

import { MemoryType } from "@monet/types";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { 
  Select as ShadSelect, 
  SelectContent as ShadSelectContent, 
  SelectItem as ShadSelectItem, 
  SelectTrigger as ShadSelectTrigger, 
  SelectValue as ShadSelectValue 
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { SESSION_EXPIRED_ERROR_MESSAGE } from "@/lib/session-errors";

interface MemoryFiltersProps {
  initialType?: MemoryType;
  initialTag?: string;
  initialIncludeUser: boolean;
  initialIncludePrivate: boolean;
  errorMessage?: string;
  stateKey: string;
}

export function MemoryFilters({
  initialType,
  initialTag,
  initialIncludeUser,
  initialIncludePrivate,
  errorMessage,
  stateKey,
}: MemoryFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isUpdating, setIsUpdating] = useState(false);
  const [, startTransition] = useTransition();
  const currentQuery = searchParams.toString();
  const isSessionExpired = errorMessage === SESSION_EXPIRED_ERROR_MESSAGE;

  // Clear loading state when the server-rendered page state updates.
  useEffect(() => {
    setIsUpdating(false);
  }, [stateKey]);

  // Safety timeout to ensure the UI doesn't stay stuck forever
  useEffect(() => {
    if (!isUpdating) return;
    const timer = setTimeout(() => setIsUpdating(false), 5000);
    return () => clearTimeout(timer);
  }, [isUpdating]);

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
    <div className="relative mb-6 rounded-lg border bg-card p-4 shadow-sm">
      {isUpdating && (
        <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-10 rounded-lg">
          <div className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium shadow-sm">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Loading memories...
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-6">
        <div className="grid min-w-[180px] gap-2">
          <Label className="text-xs uppercase text-muted-foreground font-semibold">Memory Type</Label>
          <ShadSelect 
            value={initialType || "all"} 
            disabled={isUpdating}
            onValueChange={(val) => updateUrl({ memoryType: val === "all" ? "" : val })}
          >
            <ShadSelectTrigger aria-busy={isUpdating}>
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
              disabled={isUpdating}
              onCheckedChange={(checked) => updateUrl({ includeUser: !!checked })}
            />
            <Label htmlFor="includeUser" className="text-sm cursor-pointer">Include User</Label>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox 
              id="includePrivate" 
              checked={initialIncludePrivate} 
              disabled={isUpdating}
              onCheckedChange={(checked) => updateUrl({ includePrivate: !!checked })}
            />
            <Label htmlFor="includePrivate" className="text-sm cursor-pointer">Include Private</Label>
          </div>
        </div>

        <div className="ml-auto">
          {(initialType || initialTag || initialIncludeUser || initialIncludePrivate) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={isUpdating}
              onClick={() => {
                setIsUpdating(true);
                startTransition(() => {
                  router.replace(pathname);
                });
              }}
            >
              {isUpdating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <X className="mr-2 h-4 w-4" />
              )}
              {isUpdating ? "Loading..." : "Clear Filters"}
            </Button>
          )}
        </div>
      </div>

      {errorMessage ? (
        <Alert variant="destructive" className="mt-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{errorMessage}</span>
            {isSessionExpired ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/login">Log in again</Link>
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
