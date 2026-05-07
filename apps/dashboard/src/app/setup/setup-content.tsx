"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  exchangeBootstrapTokenAction,
  savePlatformSetupAction,
} from "./actions";
import { INITIAL_SETUP_ACTION_STATE } from "./actions-shared";

type SetupContentProps = {
  setupState: {
    hasSetupSession: boolean;
    platformAuthConfigured: boolean;
  };
  platformIssuerExample: string;
};

export function SetupContent({ setupState, platformIssuerExample }: SetupContentProps) {
  const router = useRouter();
  const [exchangeState, setExchangeState] = useState(INITIAL_SETUP_ACTION_STATE);
  const [saveState, setSaveState] = useState(INITIAL_SETUP_ACTION_STATE);
  const [exchangePending, startExchangeTransition] = useTransition();
  const [savePending, startSaveTransition] = useTransition();

  const exchangeAction = (formData: FormData) => {
    startExchangeTransition(async () => {
      try {
        setExchangeState(await exchangeBootstrapTokenAction(formData));
      } catch (error) {
        setExchangeState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };

  const saveAction = (formData: FormData) => {
    startSaveTransition(async () => {
      try {
        setSaveState(await savePlatformSetupAction(formData));
      } catch (error) {
        setSaveState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };

  useEffect(() => {
    if (exchangeState.status === "success" || saveState.status === "success") {
      router.refresh();
    }
  }, [exchangeState.status, saveState.status, router]);

  const actionState =
    saveState.status !== "idle"
      ? saveState
      : exchangeState.status !== "idle"
        ? exchangeState
        : INITIAL_SETUP_ACTION_STATE;

  return (
    <>
      {actionState.status === "error" ? (
        <Alert variant="destructive">
          <AlertTitle>Setup failed</AlertTitle>
          <AlertDescription>{actionState.message}</AlertDescription>
        </Alert>
      ) : null}

      {actionState.status === "success" ? (
        <Alert>
          <AlertTitle>Success</AlertTitle>
          <AlertDescription>{actionState.message}</AlertDescription>
        </Alert>
      ) : null}

      {!setupState.hasSetupSession ? (
        <form action={exchangeAction} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bootstrap-token">Bootstrap token</Label>
            <Input
              id="bootstrap-token"
              name="token"
              type="password"
              placeholder="Paste the one-time token from API logs"
              autoComplete="off"
              required
            />
          </div>

          <SubmitButton
            label="Start setup"
            pendingLabel="Starting..."
            pending={exchangePending}
            className="w-full"
          />
        </form>
      ) : setupState.platformAuthConfigured ? (
        <div className="space-y-4">
          <Alert>
            <AlertTitle>Platform OIDC configured</AlertTitle>
            <AlertDescription>
              Continue with platform sign-in to bind the first platform admin.
            </AlertDescription>
          </Alert>

          <Button asChild className="w-full">
            <a href="/platform/login">Continue to platform login</a>
          </Button>
        </div>
      ) : (
        <form action={saveAction} className="space-y-4">
          <Alert>
            <AlertTitle>Bootstrap session ready</AlertTitle>
            <AlertDescription>
              Configure the platform OIDC provider and seed the first
              platform-admin email.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label htmlFor="platform-issuer">OIDC issuer</Label>
            <Input
              id="platform-issuer"
              name="issuer"
              type="url"
              placeholder={platformIssuerExample}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="platform-client-id">Client ID</Label>
            <Input
              id="platform-client-id"
              name="clientId"
              type="text"
              placeholder="monet-platform"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="platform-client-secret">Client secret</Label>
            <Input
              id="platform-client-secret"
              name="clientSecret"
              type="password"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="platform-admin-email">Platform admin email</Label>
            <Input
              id="platform-admin-email"
              name="adminEmail"
              type="email"
              placeholder="admin@example.com"
              required
            />
          </div>

          <SubmitButton
            label="Save platform setup"
            pendingLabel="Saving..."
            pending={savePending}
            className="w-full"
          />
        </form>
      )}
    </>
  );
}
