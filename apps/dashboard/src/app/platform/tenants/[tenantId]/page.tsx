import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth";
import { getOidcExampleIssuer } from "@/lib/oidc";
import { getPlatformTenant } from "@/lib/platform-tenants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TenantAdminNominationForm, TenantOidcForm } from "./tenant-settings-forms";

type PageProps = {
  params: Promise<{ tenantId: string }>;
};

export default async function PlatformTenantDetailPage({
  params,
}: PageProps) {
  await requirePlatformAdmin();

  const { tenantId } = await params;
  const tenantState = await getPlatformTenant(tenantId);

  if (!tenantState) {
    notFound();
  }

  const { tenant, oidcConfig, adminNominations } = tenantState;
  const tenantIssuerExample = getOidcExampleIssuer(tenant.slug);

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
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="shadow-sm">
          <CardHeader className="space-y-2">
            <CardTitle>Tenant OIDC</CardTitle>
            <CardDescription>
              Configure the tenant&apos;s OIDC issuer and confidential client.
              For local environments, use the generated values from
              {" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">.local-dev/keycloak.json</code>
              {" "}
              or
              {" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">.runtime/keycloak.json</code>
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TenantOidcForm
              tenantId={tenant.id}
              tenantIssuerExample={tenantIssuerExample}
              oidcConfig={oidcConfig
                ? {
                    issuer: oidcConfig.issuer,
                    clientId: oidcConfig.clientId,
                  }
                : null}
            />
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
            <TenantAdminNominationForm tenantId={tenant.id} />

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
                          ? `, claimed ${new Date(nomination.claimedAt).toLocaleString()}${nomination.claimedByLabel ? ` by ${nomination.claimedByLabel}` : ""}`
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
