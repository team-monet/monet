"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, LogIn, RefreshCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SESSION_EXPIRED_ERROR_MESSAGE } from "@/lib/session-errors";

export default function MemoriesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const isSessionExpired =
    error.message === SESSION_EXPIRED_ERROR_MESSAGE ||
    error.cause === SESSION_EXPIRED_ERROR_MESSAGE;

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center p-8">
      <div className="w-full max-w-xl space-y-6">
        <div className="space-y-2 text-center">
          <div className="mx-auto inline-flex rounded-full bg-destructive/10 p-4">
            <AlertTriangle className="h-8 w-8 text-destructive" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            {isSessionExpired ? "Session expired" : "Unable to load memories"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isSessionExpired
              ? "Your sign-in session ended while loading memories. Log in again to continue."
              : "A request failed while loading this memories view. Retry the request or sign in again if the problem persists."}
          </p>
        </div>

        <Alert variant="destructive">
          <AlertTitle>
            {isSessionExpired ? "Authentication required" : "Request failed"}
          </AlertTitle>
          <AlertDescription>
            {isSessionExpired
              ? SESSION_EXPIRED_ERROR_MESSAGE
              : error.digest
                ? `Reference: ${error.digest}`
                : "The page could not finish rendering. Try the request again."}
          </AlertDescription>
        </Alert>

        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          {isSessionExpired ? (
            <Button asChild size="lg">
              <Link href="/login">
                <LogIn className="mr-2 h-4 w-4" />
                Log In Again
              </Link>
            </Button>
          ) : (
            <Button onClick={() => reset()} size="lg">
              <RefreshCcw className="mr-2 h-4 w-4" />
              Try Again
            </Button>
          )}

          <Button asChild size="lg" variant="outline">
            <Link href="/memories">Return to Memories</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
