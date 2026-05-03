import { getApiClient } from "@/lib/api-client";
import { MemoryEntryTier1, MemoryType } from "@monet/types";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MemoryFilters } from "./filters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Search, ChevronRight, Calendar, Bot } from "lucide-react";
import { 
  Pagination, 
  PaginationContent, 
  PaginationItem, 
  PaginationNext, 
} from "@/components/ui/pagination";
import { formatMemoryAuthor } from "@/lib/memory-display";
import { ClickableRow } from "./clickable-row";
import { isSessionExpiredError } from "@/lib/session-errors";
import { Suspense } from "react";
import { MemoriesTableSkeleton } from "./loading";
import { LocalizedDateTime } from "@/components/localized-date-time";

interface PageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

function getMemoryTypeVariant(type: MemoryType): "default" | "secondary" | "outline" | "destructive" {
  switch (type) {
    case "fact": return "default";
    case "preference": return "secondary";
    case "decision": return "outline";
    default: return "outline";
  }
}

function getScopeColor(scope: string) {
  switch (scope) {
    case "group": return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
    case "user": return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
    case "private": return "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200";
    default: return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
  }
}

async function MemoriesTable({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  const type = params.memoryType as MemoryType;
  const tag = params.tag as string;
  const groupId = params.groupId as string;
  const includeUser = params.includeUser === "true";
  const includePrivate = params.includePrivate === "true";
  const cursor = params.cursor as string;
  const limit = 20;

  let memories: MemoryEntryTier1[] = [];
  let nextCursor: string | null = null;
  let error = "";

  try {
    const client = await getApiClient();
    const result = await client.listMemories({
      memoryType: type,
      tags: tag,
      groupId,
      includeUser,
      includePrivate,
      cursor,
      limit,
    });
    memories = result.items;
    nextCursor = result.nextCursor;
  } catch (err: unknown) {
    if (isSessionExpiredError(err)) {
      redirect("/login");
    }

    error =
      err instanceof Error
        ? err.message
        : "An unexpected error occurred. Please try again later.";
  }

  let nextPageHref: string | null = null;
  if (nextCursor) {
    const nextParams = new URLSearchParams({ cursor: nextCursor });
    if (type) nextParams.set("memoryType", type);
    if (tag) nextParams.set("tag", tag);
    if (groupId) nextParams.set("groupId", groupId);
    if (includeUser) nextParams.set("includeUser", "true");
    if (includePrivate) nextParams.set("includePrivate", "true");
    nextPageHref = `/memories?${nextParams.toString()}`;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
        {error}
      </div>
    );
  }

  return (
    <>
      <Card className="shadow-sm">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Type</TableHead>
                <TableHead className="w-[100px]">Scope</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead className="w-[180px]">Metadata</TableHead>
                <TableHead className="w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {memories.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No memories found.
                  </TableCell>
                </TableRow>
              ) : (
                memories.map((m) => (
                  <ClickableRow key={m.id} href={`/memories/${m.id}`} className="group">
                    <TableCell>
                      <div className="flex flex-col gap-1.5">
                        <Badge variant={getMemoryTypeVariant(m.memoryType)} className="w-fit uppercase text-[10px]">
                          {m.memoryType}
                        </Badge>
                        {m.outdated && (
                          <Badge variant="destructive" className="w-fit text-[9px] h-4 px-1.5 uppercase">
                            Outdated
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${getScopeColor(m.memoryScope)}`}>
                        {m.memoryScope}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-md">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium text-sm line-clamp-2">{m.summary}</span>
                        <div className="flex flex-wrap gap-1">
                          {m.tags.slice(0, 3).map(tag => (
                            <span key={tag} className="text-[10px] text-muted-foreground">#{tag}</span>
                          ))}
                          {m.tags.length > 3 && <span className="text-[10px] text-muted-foreground">+{m.tags.length - 3}</span>}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <Calendar className="h-3 w-3" />
                          <LocalizedDateTime date={m.createdAt} dateOnly />
                        </div>
                        <div className="flex items-center gap-1.5 truncate max-w-[150px]">
                          <Bot className="h-3 w-3 shrink-0" />
                          <span className="truncate">{formatMemoryAuthor(m)}</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" asChild className="opacity-0 group-hover:opacity-100 transition-opacity">
                        <Link href={`/memories/${m.id}`}>
                          <ChevronRight className="h-4 w-4" />
                          <span className="sr-only">View</span>
                        </Link>
                      </Button>
                    </TableCell>
                  </ClickableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {nextPageHref && (
        <div className="flex justify-center mt-4">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationNext href={nextPageHref} />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </>
  );
}

export default async function MemoriesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const type = params.memoryType as MemoryType;
  const tag = params.tag as string;
  const groupId = params.groupId as string;
  const includeUser = params.includeUser === "true";
  const includePrivate = params.includePrivate === "true";
  const cursor = params.cursor as string;

  let groups: { id: string; name: string }[] = [];
  try {
    const client = await getApiClient();
    const result = await client.listGroups();
    groups = result.groups;
  } catch {
    // ignore - filters will show "All Groups" only
  }

  // Key forces Suspense to remount (and show skeleton) when filters change
  const suspenseKey = [type, tag, groupId, includeUser, includePrivate, cursor].filter(Boolean).join("|") || "default";

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Memories</h1>
          <p className="text-muted-foreground mt-1">
            Browse and filter agent memories across your organization.
          </p>
        </div>
        <Button asChild>
          <Link href="/memories/search">
            <Search className="mr-2 h-4 w-4" />
            Semantic Search
          </Link>
        </Button>
      </div>

      <MemoryFilters
        initialType={type}
        initialGroupId={groupId}
        initialIncludeUser={includeUser}
        initialIncludePrivate={includePrivate}
        groups={groups}
      />

      <Suspense key={suspenseKey} fallback={<MemoriesTableSkeleton />}>
        <MemoriesTable searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
