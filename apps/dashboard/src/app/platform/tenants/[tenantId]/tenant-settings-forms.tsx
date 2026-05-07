"use client";

import { useState, useTransition } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  saveTenantAdminNominationAction,
  saveTenantOidcConfigAction,
} from "../../actions";
import { initialPlatformActionState } from "../../actions-shared";

type TenantOidcFormProps = {
  tenantId: string;
  tenantIssuerExample: string;
  oidcConfig: {
    issuer: string;
    clientId: string;
  } | null;
};

export function TenantOidcForm({
  tenantId,
  tenantIssuerExample,
  oidcConfig,
}: TenantOidcFormProps) {
  const [oidcState, setOidcState] = useState(initialPlatformActionState);
  const [pending, startOidcTransition] = useTransition();
  const oidcAction = (formData: FormData) => {
    startOidcTransition(async () => {
      try {
        setOidcState(await saveTenantOidcConfigAction(formData));
      } catch (error) {
        setOidcState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };

  return (
    <form action={oidcAction} className="space-y-4">
      {oidcState.status !== "idle" ? (
        <Alert variant={oidcState.status === "error" ? "destructive" : "default"}>
          <AlertTitle>
            {oidcState.status === "error" ? "Could not save tenant OIDC" : "OIDC saved"}
          </AlertTitle>
          <AlertDescription>{oidcState.message}</AlertDescription>
        </Alert>
      ) : null}

      <input type="hidden" name="tenantId" value={tenantId} />

      <div className="space-y-2">
        <Label htmlFor="issuer">OIDC issuer</Label>
        <Input
          id="issuer"
          name="issuer"
          type="url"
          defaultValue={oidcConfig?.issuer ?? ""}
          placeholder={tenantIssuerExample}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="clientId">Client ID</Label>
        <Input
          id="clientId"
          name="clientId"
          type="text"
          defaultValue={oidcConfig?.clientId ?? ""}
          placeholder="monet-acme"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="clientSecret">
          Client secret
          {oidcConfig ? " (leave blank to keep existing secret)" : ""}
        </Label>
        <Input
          id="clientSecret"
          name="clientSecret"
          type="password"
          placeholder={oidcConfig ? "Keep existing secret" : "Paste the client secret"}
        />
      </div>

      <SubmitButton label="Save tenant OIDC" pendingLabel="Saving..." pending={pending} />
    </form>
  );
}

type TenantAdminNominationFormProps = {
  tenantId: string;
};

export function TenantAdminNominationForm({ tenantId }: TenantAdminNominationFormProps) {
  const [nominationState, setNominationState] = useState(initialPlatformActionState);
  const [, startNominationTransition] = useTransition();
  const nominationAction = (formData: FormData) => {
    startNominationTransition(async () => {
      try {
        setNominationState(await saveTenantAdminNominationAction(formData));
      } catch (error) {
        setNominationState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    });
  };

  return (
    <form action={nominationAction} className="space-y-4">
      {nominationState.status !== "idle" ? (
        <Alert variant={nominationState.status === "error" ? "destructive" : "default"}>
          <AlertTitle>
            {nominationState.status === "error"
              ? "Could not save tenant admin nomination"
              : "Tenant admin nominated"}
          </AlertTitle>
          <AlertDescription>{nominationState.message}</AlertDescription>
        </Alert>
      ) : null}

      <input type="hidden" name="tenantId" value={tenantId} />

      <div className="space-y-2">
        <Label htmlFor="adminEmail">Tenant admin email</Label>
        <Input
          id="adminEmail"
          name="email"
          type="email"
          placeholder="admin@acme.example"
          required
        />
      </div>

      <SubmitButton label="Save tenant admin nomination" pendingLabel="Saving..." />
    </form>
  );
}
