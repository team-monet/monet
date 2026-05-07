"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markMemoryOutdatedAction, deleteMemoryAction, promoteMemoryScopeAction } from "../actions";
import { initialMemoryMutationActionState } from "../actions-shared";
import { MemoryScope } from "@monet/types";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteState, setDeleteState] = useState(initialMemoryMutationActionState);
  const [outdatedState, setOutdatedState] = useState(initialMemoryMutationActionState);
  const [promoteState, setPromoteState] = useState(initialMemoryMutationActionState);
  const [deletePending, startDeleteTransition] = useTransition();
  const [outdatedPending, startOutdatedTransition] = useTransition();
  const [promotePending, startPromoteTransition] = useTransition();

  const deleteFormAction = (formData: FormData) => {
    startDeleteTransition(async () => {
      try {
        setDeleteState(await deleteMemoryAction(formData));
      } catch (error) {
        setDeleteState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };

  const outdatedFormAction = (formData: FormData) => {
    startOutdatedTransition(async () => {
      try {
        setOutdatedState(await markMemoryOutdatedAction(formData));
      } catch (error) {
        setOutdatedState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };

  const promoteFormAction = (formData: FormData) => {
    startPromoteTransition(async () => {
      try {
        setPromoteState(await promoteMemoryScopeAction(formData));
      } catch (error) {
        setPromoteState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };

  const nextScope: MemoryScope | null = currentScope === "private"
    ? "user"
    : currentScope === "user"
      ? "group"
      : null;

  useEffect(() => {
    if (outdatedState.status === "success" || promoteState.status === "success") {
      router.refresh();
    }
  }, [outdatedState.status, promoteState.status, router]);

  useEffect(() => {
    if (deleteState.status === "success") {
      router.push("/memories?deleted=1");
    }
  }, [deleteState.status, router]);

  return (
    <div className="space-y-3 w-full">
      {(deleteState.status === "error" || outdatedState.status === "error" || promoteState.status === "error") && (
        <Alert variant="destructive">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription>
            {deleteState.status === "error"
              ? deleteState.message
              : outdatedState.status === "error"
                ? outdatedState.message
                : promoteState.message}
          </AlertDescription>
        </Alert>
      )}

      {(outdatedState.status === "success" || promoteState.status === "success") && (
        <Alert>
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>
            {outdatedState.status === "success" ? outdatedState.message : promoteState.message}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <form action={outdatedFormAction}>
          <input type="hidden" name="id" value={id} />
          <Button
            variant="outline"
            size="sm"
            type="submit"
            disabled={outdatedPending || promotePending || deletePending}
          >
            {outdatedPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <AlertCircle className="mr-2 h-4 w-4" />}
            Mark Outdated
          </Button>
        </form>

        {nextScope && (
          <form action={promoteFormAction}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="scope" value={nextScope} />
            <Button
              variant="outline"
              size="sm"
              type="submit"
              disabled={outdatedPending || promotePending || deletePending}
              className="text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50"
            >
              {promotePending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowUpCircle className="mr-2 h-4 w-4" />}
              Promote to {currentScope === "private" ? "User" : "Group"}
            </Button>
          </form>
        )}

        <div className="ml-auto">
          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogTrigger asChild>
              <Button variant="destructive" size="sm" disabled={outdatedPending || promotePending || deletePending}>
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
              <form action={deleteFormAction}>
                <input type="hidden" name="id" value={id} />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setDeleteOpen(false)} disabled={deletePending}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="destructive" disabled={deletePending}>
                    {deletePending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Delete Permanently
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
