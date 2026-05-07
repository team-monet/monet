"use client";

import { useState, useTransition } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  createPlatformTenantAction,
} from "./actions";
import { initialPlatformActionState } from "./actions-shared";

export function CreateTenantForm() {
  const [state, setState] = useState(initialPlatformActionState);
  const [pending, startTransition] = useTransition();
  const formAction = (formData: FormData) => {
    startTransition(async () => {
      try {
        setState(await createPlatformTenantAction(formData));
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="space-y-2">
        <CardTitle>Create Tenant</CardTitle>
        <CardDescription>
          Tenant slugs are used at login, for example
          {" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            /login?tenant=acme
          </code>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {state.status !== "idle" ? (
            <Alert variant={state.status === "error" ? "destructive" : "default"}>
              <AlertTitle>
                {state.status === "error" ? "Could not create tenant" : "Tenant created"}
              </AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="tenant-name">Display name</Label>
            <Input
              id="tenant-name"
              name="name"
              placeholder="Acme Corporation"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tenant-slug">Slug</Label>
            <Input
              id="tenant-slug"
              name="slug"
              placeholder="acme"
              required
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers, and hyphens only.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tenant-isolation-mode">Isolation mode</Label>
            <select
              id="tenant-isolation-mode"
              name="isolationMode"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs"
              defaultValue="logical"
            >
              <option value="logical">Logical</option>
              <option value="physical">Physical</option>
            </select>
          </div>

          <SubmitButton label="Create tenant" pendingLabel="Creating..." className="w-full" pending={pending} />
        </form>
      </CardContent>
    </Card>
  );
}
