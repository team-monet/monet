"use client";

import { useState, useEffect, Suspense, useCallback } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { validateTenantAction } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";

function LoginFormInner() {
  const searchParams = useSearchParams();
  const [tenant, setTenant] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isAutoLoggingIn, setIsAutoLoggingIn] = useState(false);
  const isOrgNotFoundError = error === "Organization not found";

  const performLogin = useCallback(async (tenantSlug: string) => {
    const trimmedTenantSlug = tenantSlug.trim();
    setLoading(true);
    setError("");

    try {
      const validation = await validateTenantAction(trimmedTenantSlug);
      if ("error" in validation) {
        setError(validation.error);
        setLoading(false);
        setIsAutoLoggingIn(false);
        return;
      }

      document.cookie = `tenant-slug=${validation.cookieTenantSlug}; path=/; max-age=3600; SameSite=Lax`;

      if (validation.provider === "dev-bypass") {
        await signIn("dev-bypass", {
          orgSlug: validation.orgSlug ?? validation.cookieTenantSlug,
          callbackUrl: "/",
        });
        return;
      }

      await signIn("tenant-oauth", { callbackUrl: "/" });
    } catch {
      setError("Failed to initiate sign in. Please try again.");
      setLoading(false);
      setIsAutoLoggingIn(false);
    }
  }, []);

  useEffect(() => {
    const t = searchParams.get("tenant");
    if (t && !isAutoLoggingIn && !error) {
      setTenant(t);
      setIsAutoLoggingIn(true);
      performLogin(t);
    }
  }, [searchParams, performLogin, isAutoLoggingIn, error]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenant) {
      setError("Please enter your organization");
      return;
    }
    performLogin(tenant);
  };

  if (isAutoLoggingIn && !error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
        <Card className="w-full max-w-md shadow-lg">
          <CardContent className="space-y-4 pt-6 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <div className="space-y-1">
              <p className="text-lg font-medium">Signing in to {tenant}...</p>
              <p className="text-sm text-muted-foreground">
                Please wait while we redirect you to your SSO provider.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-1 text-center">
          <div className="mb-2 flex justify-center">
            <div className="rounded-full bg-primary p-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-6 w-6 text-primary-foreground"
              >
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight text-primary">
            Monet
          </CardTitle>
          <CardDescription>
            Enter your organization slug to sign in to your dashboard
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleLogin}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tenant-slug">Organization</Label>
              <Input
                id="tenant-slug"
                name="tenant"
                type="text"
                required
                placeholder="e.g. acme-corp"
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                disabled={loading}
              />
              <p className="text-[11px] text-muted-foreground">
                Hint: Use{" "}
                <code className="rounded bg-muted px-1 font-mono text-xs font-bold">
                  test-org
                </code>{" "}
                for development.
              </p>
            </div>

            {error ? (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>
                  {isOrgNotFoundError ? "Organization not found" : "Sign in failed"}
                </AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Redirecting...
                </>
              ) : (
                "Continue to Sign In"
              )}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

export default function LoginForm() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-muted/40">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      }
    >
      <LoginFormInner />
    </Suspense>
  );
}
