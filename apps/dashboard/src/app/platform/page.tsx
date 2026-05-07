import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth";
import { listPlatformTenants } from "@/lib/platform-tenants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CreateTenantForm } from "./create-tenant-form";

type PlatformUser = {
  name?: string | null;
  email?: string | null;
};

export default async function PlatformPage() {
  const session = await requirePlatformAdmin();
  const user = session.user as PlatformUser;
  const tenants = await listPlatformTenants();

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-4">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Platform Tenants</h1>
        <p className="text-muted-foreground">
          Signed in as {user.name || user.email || "platform admin"}. Create
          tenants, assign stable slugs, and configure their OIDC providers.
        </p>
      </div>
      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <CreateTenantForm />

        <Card className="shadow-sm">
          <CardHeader className="space-y-2">
            <CardTitle>Tenants</CardTitle>
            <CardDescription>
              Configure tenant OIDC after creation and share the tenant slug
              with the organization for sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Auth</TableHead>
                  <TableHead>Login</TableHead>
                  <TableHead className="w-[140px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                      No tenants have been created yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  tenants.map((tenant) => (
                    <TableRow key={tenant.id}>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="font-medium">{tenant.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {new Date(tenant.createdAt).toLocaleString()}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1 py-0.5 text-xs">
                          {tenant.slug}
                        </code>
                      </TableCell>
                      <TableCell>
                        <Badge variant={tenant.oidcConfigured ? "default" : "secondary"}>
                          {tenant.oidcConfigured ? "OIDC configured" : "OIDC pending"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1 py-0.5 text-xs">
                          /login?tenant={tenant.slug}
                        </code>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/platform/tenants/${tenant.id}`}>
                            Manage
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
