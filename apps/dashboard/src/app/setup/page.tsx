import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getBootstrapStatus,
  getPlatformSetupState,
} from "@/lib/bootstrap";
import { getOidcExampleIssuer } from "@/lib/oidc";
import { SetupContent } from "./setup-content";

export default async function SetupPage() {
  const status = await getBootstrapStatus();
  if (status.initialized) {
    redirect("/login");
  }

  const setupState = await getPlatformSetupState();
  const platformIssuerExample = getOidcExampleIssuer("monet");

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-lg shadow-lg">
        <CardHeader className="space-y-2">
          <CardTitle className="text-2xl font-bold tracking-tight">
            Platform Setup
          </CardTitle>
          <CardDescription>
            Monet is not initialized yet. Retrieve the bootstrap token from the
            API startup logs, then exchange it here to begin setup. For local
            environments, use the generated Keycloak values from
            {" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">.local-dev/keycloak.json</code>
            {" "}
            or
            {" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">.runtime/keycloak.json</code>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SetupContent
            setupState={setupState}
            platformIssuerExample={platformIssuerExample}
          />
        </CardContent>
      </Card>
    </div>
  );
}
