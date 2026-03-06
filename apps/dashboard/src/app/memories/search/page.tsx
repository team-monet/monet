"use client";

import { useState } from "react";
import { searchMemoriesAction } from "../actions";
import Link from "next/link";
import { MemoryEntryTier1, MemoryType } from "@monet/types";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Search, Loader2, Calendar, Bot, ArrowRight, AlertTriangle, Tag, Sparkles } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";

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

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemoryEntryTier1[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError("");
    setResults([]);
    setNextCursor(null);
    try {
      const response = await searchMemoriesAction(query);
      setResults(response.items);
      setNextCursor(response.nextCursor);
    } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      setError(err.message || "Failed to search memories");
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!nextCursor || loading) return;

    setLoading(true);
    try {
      const response = await searchMemoriesAction(query, 20, nextCursor);
      setResults((prev) => [...prev, ...response.items]);
      setNextCursor(response.nextCursor);
    } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      setError(err.message || "Failed to load more memories");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-8 p-4 max-w-5xl mx-auto w-full">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Semantic Search</h1>
        <p className="text-muted-foreground">
          Find memories by their meaning, even if you don't remember the exact
          keywords.
        </p>
      </div>

      <Card className="shadow-md">
        <CardContent className="pt-6">
          <form onSubmit={handleSearch} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="How does the user prefer to be addressed?"
                className="pl-10 h-12 text-lg"
                autoFocus
                disabled={loading}
              />
            </div>
            <Button type="submit" size="lg" disabled={loading} className="h-12 px-8">
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : "Search"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Search Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6">
        {results.length === 0 && !loading && query && (
          <div className="flex flex-col items-center justify-center py-20 border rounded-lg bg-muted/20 border-dashed">
            <Search className="h-12 w-12 text-muted-foreground mb-4 opacity-20" />
            <p className="text-muted-foreground font-medium">No memories found matching your search.</p>
          </div>
        )}

        {results.map((m) => (
          <Card key={m.id} className="group hover:shadow-md transition-shadow">
            <CardHeader className="pb-3">
              <div className="flex justify-between items-start">
                <div className="flex gap-2 flex-wrap">
                  <Badge variant={getMemoryTypeVariant(m.memoryType)} className="uppercase text-[10px]">
                    {m.memoryType}
                  </Badge>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${getScopeColor(m.memoryScope)}`}>
                    {m.memoryScope}
                  </span>
                  {m.outdated && (
                    <Badge variant="destructive" className="h-5 px-1.5 text-[10px] uppercase">
                      Outdated
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-1.5" suppressHydrationWarning>
                  <Calendar className="h-3.5 w-3.5" />
                  {new Date(m.createdAt).toLocaleDateString()}
                </div>
              </div>
              <CardTitle className="text-lg leading-tight mt-2 line-clamp-2">{m.summary}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5 mb-4">
                {m.tags.map(tag => (
                  <Badge key={tag} variant="outline" className="text-[10px] h-5 px-1.5 font-normal flex items-center gap-1">
                    <Tag className="h-2.5 w-2.5" />
                    {tag}
                  </Badge>
                ))}
                {m.autoTags.map(tag => (
                  <Badge key={tag} variant="secondary" className="text-[10px] h-5 px-1.5 font-normal italic flex items-center gap-1">
                    <Sparkles className="h-2.5 w-2.5" />
                    {tag}
                  </Badge>
                ))}
              </div>
              <Separator className="my-4" />
              <div className="flex justify-between items-end">
                <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Bot className="h-3 w-3" />
                    <span className="truncate max-w-[200px]">{m.authorAgentId}</span>
                  </div>
                  <div>Score: {m.usefulnessScore}</div>
                </div>
                <Button variant="link" size="sm" asChild className="p-0 h-auto font-semibold">
                  <Link href={`/memories/${m.id}`}>
                    View Details
                    <ArrowRight className="ml-1 h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}

        {nextCursor && !loading && (
          <div className="flex justify-center pt-4">
            <Button variant="outline" onClick={loadMore}>
              Load More Results
            </Button>
          </div>
        )}

        {loading && results.length > 0 && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground opacity-20" />
          </div>
        )}
      </div>
    </div>
  );
}
