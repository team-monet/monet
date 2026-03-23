"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { LogOut } from "lucide-react";
import { Suspense } from "react";

function SignOutForm() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm shadow-lg">
        <CardHeader className="space-y-1 text-center pb-2">
          <div className="mb-4 flex justify-center">
            <div className="rounded-full bg-destructive/10 p-3">
              <LogOut className="h-6 w-6 text-destructive" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">
            Sign Out
          </CardTitle>
          <CardDescription>
            Are you sure you want to sign out?
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center text-sm text-muted-foreground pb-6">
          You will be redirected to the login page.
        </CardContent>
        <CardFooter className="flex flex-col gap-3">
          <Button
            variant="destructive"
            className="w-full py-6 text-base font-semibold"
            onClick={() => signOut({ callbackUrl: "/login" })}
          >
            Sign Out
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={() => window.history.back()}
          >
            Go Back
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
