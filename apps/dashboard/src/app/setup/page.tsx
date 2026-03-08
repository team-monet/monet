import { redirect } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getBootstrapStatus, getSetupSessionToken } from "@/lib/bootstrap";
import { exchangeBootstrapTokenAction } from "./actions";

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
  const setupSessionToken = await getSetupSessionToken();

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-lg shadow-lg">
        <CardHeader className="space-y-2">
          <CardTitle className="text-2xl font-bold tracking-tight">
            Platform Setup
          </CardTitle>
          <CardDescription>
            Monet is not initialized yet. Retrieve the bootstrap token from the
            API startup logs, then exchange it here to begin setup.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Bootstrap failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {setupSessionToken ? (
            <Alert>
              <AlertTitle>Bootstrap session ready</AlertTitle>
              <AlertDescription>
                The one-time bootstrap token has been exchanged successfully.
                Platform OIDC and first admin setup land next on top of this
                session.
              </AlertDescription>
            </Alert>
          ) : (
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

              <Button type="submit" className="w-full">
                Start setup
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
