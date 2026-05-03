import { getApiClient } from "@/lib/api-client";
import { auth } from "@/lib/auth";
import { MemoryEntry, MemoryScope, MemoryType } from "@monet/types";
import Link from "next/link";
import { MemoryActions } from "./memory-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronLeft, Calendar, Tag, Sparkles, Info, History, FileText } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { formatMemoryAuthor } from "@/lib/memory-display";

interface PageProps {
  params: Promise<{ id: string }>;
}

function getMemoryTypeVariant(type: MemoryType): "default" | "secondary" | "outline" | "destructive" {
  switch (type) {
    case "fact": return "default";
    case "preference": return "secondary";
    case "decision": return "outline";
    default: return "outline";
  }
}

export default async function MemoryEntryDetailPage({ params }: PageProps) {
  const { id } = await params;
  await auth();

  let memory: MemoryEntry | null = null;
  let versions: { id: string; version: number; createdAt: string; content: string }[] = [];
  let error = "";
  let groupName: string | null = null;

  try {
    const client = await getApiClient();
    const result = await client.getMemoryEntry(id);
    memory = result.entry;
    versions = result.versions;
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  if (!error && memory?.groupId) {
    try {
      const client = await getApiClient();
      const groupsResult = await client.listGroups();
      groupName = groupsResult.groups.find((g) => g.id === memory.groupId)?.name ?? null;
    } catch {
      // Best effort only; UI falls back to rendering raw group UUID.
    }
  }

  if (error || !memory) {
    return (
      <div className="p-4 md:p-8">
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive">Error</CardTitle>
            <CardDescription>{error || "MemoryEntry not found"}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild variant="outline">
              <Link href="/memories">
                <ChevronLeft className="mr-2 h-4 w-4" />
                Back to Memories
              </Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 max-w-5xl mx-auto w-full">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild className="-ml-2 h-8">
          <Link href="/memories">
            <ChevronLeft className="mr-2 h-4 w-4" />
            Back to Memories
          </Link>
        </Button>
      </div>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">Memory Detail</h1>
          <div className="text-muted-foreground flex items-center gap-2">
            <span className="font-mono text-xs">{memory.id}</span>
            <Separator orientation="vertical" className="h-4" />
            <Badge variant={getMemoryTypeVariant(memory.memoryType)} className="uppercase text-[10px]">
              {memory.memoryType}
            </Badge>
          </div>
        </div>
      </div>

      <Tabs defaultValue="content" className="w-full">
        <TabsList className="grid w-full grid-cols-3 md:w-[400px]">
          <TabsTrigger value="content" className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Content
          </TabsTrigger>
          <TabsTrigger value="metadata" className="flex items-center gap-2">
            <Info className="h-4 w-4" />
            Metadata
          </TabsTrigger>
          <TabsTrigger value="versions" className="flex items-center gap-2">
            <History className="h-4 w-4" />
            History ({versions.length})
          </TabsTrigger>
        </TabsList>
        
        <TabsContent value="content" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Summary</CardTitle>
              <CardDescription>{memory.summary || "No summary available"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg bg-muted p-4 font-mono text-sm whitespace-pre-wrap leading-relaxed border">
                {memory.content}
              </div>
              
              {(memory.tags.length > 0 || memory.autoTags.length > 0) && (
                <div className="flex flex-wrap gap-2 pt-2">
                  {memory.tags.map((tag: string) => (
                    <Badge key={tag} variant="outline" className="flex items-center gap-1">
                      <Tag className="h-3 w-3" />
                      {tag}
                    </Badge>
                  ))}
                  {memory.autoTags.map((tag: string) => (
                    <Badge key={tag} variant="secondary" className="flex items-center gap-1 italic">
                      <Sparkles className="h-3 w-3" />
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
            <CardFooter className="bg-muted/30 border-t py-4">
              <MemoryActions id={memory.id} currentScope={memory.memoryScope as MemoryScope} />
            </CardFooter>
          </Card>
        </TabsContent>

        <TabsContent value="metadata" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Metadata & Provenance</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-semibold mb-2">General Information</h4>
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <dt className="text-muted-foreground">Scope</dt>
                    <dd className="font-medium capitalize">{memory.memoryScope}</dd>
                    
                    <dt className="text-muted-foreground">Created At</dt>
                    <dd className="font-medium flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5" />
                      {new Date(memory.createdAt).toLocaleString()}
                    </dd>

                    <dt className="text-muted-foreground">Usefulness Score</dt>
                    <dd className="font-medium">{memory.usefulnessScore}</dd>
                    
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>
                      <Badge variant={memory.outdated ? "destructive" : "outline"} className="h-5 px-1.5 text-[10px]">
                        {memory.outdated ? "Outdated" : "Current"}
                      </Badge>
                    </dd>
                  </dl>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-semibold mb-2">Source</h4>
                  <dl className="grid grid-cols-1 gap-2 text-sm">
                    <dt className="text-muted-foreground">Author Agent</dt>
                    <dd className="space-y-1">
                      <div className="font-medium">{formatMemoryAuthor(memory)}</div>
                      <div className="font-mono text-xs bg-muted p-1.5 rounded border">{memory.authorAgentId}</div>
                    </dd>
                    
                    {memory.groupId && (
                      <>
                        <dt className="text-muted-foreground mt-2">Group</dt>
                        <dd className="font-medium text-sm">{groupName ?? memory.groupId}</dd>
                      </>
                    )}
                    
                    {memory.userId && (
                      <>
                        <dt className="text-muted-foreground mt-2">User ID</dt>
                        <dd className="font-mono text-xs bg-muted p-1.5 rounded border">{memory.userId}</dd>
                      </>
                    )}
                  </dl>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="versions" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Version History</CardTitle>
              <CardDescription>All historical versions of this memory entry.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {versions.length === 0 ? (
                <p className="text-center py-8 text-muted-foreground">No historical versions found.</p>
              ) : (
                versions.map((v, i) => (
                  <div key={v.id} className="relative pl-6 pb-6 last:pb-0">
                    {i !== versions.length - 1 && (
                      <div className="absolute left-[7px] top-6 bottom-0 w-[2px] bg-muted" />
                    )}
                    <div className="absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full border-2 border-primary bg-background" />
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">Version {v.version}</span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(v.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
                        {v.content}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
