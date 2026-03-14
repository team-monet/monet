import { redirect } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  getBootstrapStatus,
  getPlatformSetupState,
} from "@/lib/bootstrap";
import { getOidcExampleIssuer } from "@/lib/oidc";
import {
  exchangeBootstrapTokenAction,
  savePlatformSetupAction,
} from "./actions";

type SetupPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SetupPage({ searchParams }: SetupPageProps) {
  const status = await getBootstrapStatus();
  if (status.initialized) {
    redirect("/login");
  }

  const params = searchParams ? await searchParams : {};
  const errorParam = params.error;
  const error =
    typeof errorParam === "string" ? decodeURIComponent(errorParam) : "";
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
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Bootstrap failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {!setupState.hasSetupSession ? (
            <form action={exchangeBootstrapTokenAction} className="space-y-4">
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

              <SubmitButton label="Start setup" pendingLabel="Starting..." className="w-full" />
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
            <form action={savePlatformSetupAction} className="space-y-4">
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

              <SubmitButton label="Save platform setup" pendingLabel="Saving..." className="w-full" />
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
