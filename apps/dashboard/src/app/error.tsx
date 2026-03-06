"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, RefreshCcw, Home } from "lucide-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center p-8 text-center">
      <div className="max-w-md w-full space-y-6">
        <div className="mx-auto bg-destructive/10 p-6 rounded-full inline-flex items-center justify-center">
          <AlertTriangle className="h-12 w-12 text-destructive" />
        </div>
        
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Something went wrong</h1>
          <p className="text-muted-foreground">
            An unexpected error occurred while processing your request.
          </p>
        </div>

        <Alert variant="destructive" className="text-left">
          <AlertTitle>Error Details</AlertTitle>
          <AlertDescription className="font-mono text-xs mt-2 break-all opacity-80">
            {error.digest
              ? `Reference: ${error.digest}`
              : "A request failed. Retry or contact support if this keeps happening."}
          </AlertDescription>
        </Alert>

        <div className="flex flex-col sm:flex-row gap-4 justify-center pt-4">
          <Button onClick={() => reset()} variant="default" size="lg">
            <RefreshCcw className="mr-2 h-4 w-4" />
            Try again
          </Button>
          <Button variant="outline" size="lg" asChild>
            <Link href="/">
              <Home className="mr-2 h-4 w-4" />
              Return Home
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
