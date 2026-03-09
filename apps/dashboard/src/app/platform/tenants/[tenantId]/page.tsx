import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth";
import { getPlatformTenant } from "@/lib/platform-tenants";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  saveTenantAdminNominationAction,
  saveTenantOidcConfigAction,
} from "../../actions";

type PageProps = {
  params: Promise<{ tenantId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getSingleParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PlatformTenantDetailPage({
  params,
  searchParams,
}: PageProps) {
  await requirePlatformAdmin();

  const { tenantId } = await params;
  const tenantState = await getPlatformTenant(tenantId);

  if (!tenantState) {
    notFound();
  }

  const query = searchParams ? await searchParams : {};
  const created = getSingleParam(query.created) === "1";
  const oidcSaved = getSingleParam(query.oidcSaved) === "1";
  const nominationSaved = getSingleParam(query.nominationSaved) === "1";
  const configError = getSingleParam(query.configError);
  const nominationError = getSingleParam(query.nominationError);
  const { tenant, oidcConfig, adminNominations } = tenantState;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">{tenant.name}</h1>
            <Badge variant={oidcConfig ? "default" : "secondary"}>
              {oidcConfig ? "OIDC configured" : "OIDC pending"}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            Tenant slug
            {" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              {tenant.slug}
            </code>
            {" "}
            signs in via
            {" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              /login?tenant={tenant.slug}
            </code>
            .
          </p>
        </div>

        <Button asChild variant="outline">
          <Link href="/platform">Back to tenants</Link>
        </Button>
      </div>

      {created ? (
        <Alert>
          <AlertTitle>Tenant created</AlertTitle>
          <AlertDescription>
            The tenant schema and initial admin agent were provisioned. Configure
            OIDC next so the organization can sign in.
          </AlertDescription>
        </Alert>
      ) : null}

      {oidcSaved ? (
        <Alert>
          <AlertTitle>OIDC saved</AlertTitle>
          <AlertDescription>
            Tenant sign-in now uses the configured OIDC provider.
          </AlertDescription>
        </Alert>
      ) : null}

      {configError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not save tenant OIDC</AlertTitle>
          <AlertDescription>{configError}</AlertDescription>
        </Alert>
      ) : null}

      {nominationSaved ? (
        <Alert>
          <AlertTitle>Tenant admin nominated</AlertTitle>
          <AlertDescription>
            The nominated user will become a tenant admin on their first
            verified OIDC login.
          </AlertDescription>
        </Alert>
      ) : null}

      {nominationError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not save tenant admin nomination</AlertTitle>
          <AlertDescription>{nominationError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="shadow-sm">
          <CardHeader className="space-y-2">
            <CardTitle>Tenant OIDC</CardTitle>
            <CardDescription>
              Configure the tenant&apos;s OIDC issuer and confidential client.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={saveTenantOidcConfigAction} className="space-y-4">
              <input type="hidden" name="tenantId" value={tenant.id} />

              <div className="space-y-2">
                <Label htmlFor="issuer">OIDC issuer</Label>
                <Input
                  id="issuer"
                  name="issuer"
                  type="url"
                  defaultValue={oidcConfig?.issuer ?? ""}
                  placeholder="http://keycloak.localhost:3400/realms/acme"
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

              <SubmitButton label="Save tenant OIDC" pendingLabel="Saving..." />
            </form>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="space-y-2">
            <CardTitle>Tenant Details</CardTitle>
            <CardDescription>
              Stable identifiers used across platform and login flows.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="space-y-1">
              <div className="text-muted-foreground">Tenant ID</div>
              <code className="block rounded bg-muted px-2 py-1 text-xs">
                {tenant.id}
              </code>
            </div>

            <div className="space-y-1">
              <div className="text-muted-foreground">Slug</div>
              <code className="block rounded bg-muted px-2 py-1 text-xs">
                {tenant.slug}
              </code>
            </div>

            <div className="space-y-1">
              <div className="text-muted-foreground">Isolation mode</div>
              <div>{tenant.isolationMode}</div>
            </div>

            <div className="space-y-1">
              <div className="text-muted-foreground">Created</div>
              <div>{new Date(tenant.createdAt).toLocaleString()}</div>
            </div>

            <div className="space-y-1">
              <div className="text-muted-foreground">Login path</div>
              <code className="block rounded bg-muted px-2 py-1 text-xs">
                /login?tenant={tenant.slug}
              </code>
            </div>

            <div className="space-y-1">
              <div className="text-muted-foreground">OIDC status</div>
              <div>{oidcConfig ? "Configured" : "Pending configuration"}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="shadow-sm">
          <CardHeader className="space-y-2">
            <CardTitle>Tenant Admin Nomination</CardTitle>
            <CardDescription>
              Nominate the first tenant admin by verified email. The first
              matching OIDC login with
              {" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">email_verified=true</code>
              {" "}
              will bind that user as
              {" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">tenant_admin</code>
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <form action={saveTenantAdminNominationAction} className="space-y-4">
              <input type="hidden" name="tenantId" value={tenant.id} />

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

            <div className="space-y-3">
              <div className="text-sm font-medium">Current nominations</div>
              {adminNominations.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No tenant admin has been nominated yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {adminNominations.map((nomination) => (
                    <div
                      key={nomination.id}
                      className="rounded-lg border border-border bg-muted/30 p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium">{nomination.email}</div>
                        <Badge variant={nomination.claimedAt ? "default" : "secondary"}>
                          {nomination.claimedAt ? "Claimed" : "Pending"}
                        </Badge>
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        Nominated {new Date(nomination.createdAt).toLocaleString()}
                        {nomination.claimedAt
                          ? `, claimed ${new Date(nomination.claimedAt).toLocaleString()}${nomination.claimedByExternalId ? ` by ${nomination.claimedByExternalId}` : ""}`
                          : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="space-y-2">
            <CardTitle>Binding Rules</CardTitle>
            <CardDescription>
              The login-time checks used for first tenant admin elevation.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>Tenant login must come through the configured OIDC provider.</p>
            <p>The profile must include an email that exactly matches the nomination.</p>
            <p>The IdP must assert that the email is verified.</p>
            <p>Once claimed, the nomination stays bound to that user.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
