"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { LogOut } from "lucide-react";
import { Suspense } from "react";

function SignOutForm() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-1 text-center">
          <div className="mb-2 flex justify-center">
            <div className="rounded-full bg-destructive/10 p-3">
              <LogOut className="h-6 w-6 text-destructive" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">
            Sign Out
          </CardTitle>
          <CardDescription>
            Are you sure you want to sign out of your account?
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center text-sm text-muted-foreground">
          You will be redirected to the login page after signing out.
        </CardContent>
        <CardFooter className="flex gap-3">
          <Button
            variant="outline"
            className="w-full"
            onClick={() => window.history.back()}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="w-full"
            onClick={() => signOut({ callbackUrl: "/login" })}
          >
            Sign Out
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export default function SignOutPage() {
  return (
    <Suspense fallback={null}>
      <SignOutForm />
    </Suspense>
  );
}
