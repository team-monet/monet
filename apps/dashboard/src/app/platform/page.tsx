import { requirePlatformAdmin } from "@/lib/auth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type PlatformUser = {
  name?: string | null;
  email?: string | null;
};

export default async function PlatformPage() {
  const session = await requirePlatformAdmin();
  const user = session.user as PlatformUser;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center p-4">
      <Card className="w-full shadow-lg">
        <CardHeader className="space-y-2">
          <CardTitle className="text-2xl font-bold tracking-tight">
            Platform Admin Ready
          </CardTitle>
          <CardDescription>
            Platform OIDC is configured and the first platform admin has been
            bound successfully.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTitle>Signed in as {user.email || user.name || "platform admin"}</AlertTitle>
            <AlertDescription>
              Tenant creation and tenant OIDC management land next in #44.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
