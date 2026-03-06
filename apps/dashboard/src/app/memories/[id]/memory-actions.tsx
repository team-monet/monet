"use client";

import { useState } from "react";
import { markMemoryOutdatedAction, deleteMemoryAction, promoteMemoryScopeAction } from "../actions";
import { useRouter } from "next/navigation";
import { MemoryScope } from "@monet/types";
import { Button } from "@/components/ui/button";
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogFooter, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger 
} from "@/components/ui/dialog";
import { Loader2, Trash2, ArrowUpCircle, AlertCircle } from "lucide-react";

interface MemoryActionsProps {
  id: string;
  currentScope: MemoryScope;
}

export function MemoryActions({ id, currentScope }: MemoryActionsProps) {
  const [loading, setLoading] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const router = useRouter();

  const handleMarkOutdated = async () => {
    setLoading(true);
    try {
      await markMemoryOutdatedAction(id);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    setLoading(true);
    try {
      await deleteMemoryAction(id);
      setDeleteOpen(false);
      router.push("/memories");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "An unexpected error occurred");
      setLoading(false);
    }
  };

  const handlePromote = async () => {
    let nextScope: MemoryScope = "user";
    if (currentScope === "user") nextScope = "group";
    else if (currentScope === "group") return;

    setLoading(true);
    try {
      await promoteMemoryScopeAction(id, nextScope);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button 
        variant="outline" 
        size="sm" 
        onClick={handleMarkOutdated} 
        disabled={loading}
      >
        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <AlertCircle className="mr-2 h-4 w-4" />}
        Mark Outdated
      </Button>

      {currentScope !== "group" && (
        <Button 
          variant="outline" 
          size="sm" 
          onClick={handlePromote} 
          disabled={loading}
          className="text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50"
        >
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowUpCircle className="mr-2 h-4 w-4" />}
          Promote to {currentScope === "private" ? "User" : "Group"}
        </Button>
      )}

      <div className="ml-auto">
        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogTrigger asChild>
            <Button variant="destructive" size="sm" disabled={loading}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete Memory
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Are you absolutely sure?</DialogTitle>
              <DialogDescription>
                This action cannot be undone. This will permanently delete the memory
                and all its version history from our servers.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={loading}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDelete} disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Delete Permanently
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
