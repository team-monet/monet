"use client";

import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function PlatformLoginForm() {
  const handleSignIn = async () => {
    await signIn("platform-oauth", {
      callbackUrl: "/platform",
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-2">
          <CardTitle className="text-2xl font-bold tracking-tight">
            Platform Login
          </CardTitle>
          <CardDescription>
            Continue with the configured platform OIDC provider to bind the
            first platform admin.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={handleSignIn} className="w-full">
            Continue with OIDC
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
