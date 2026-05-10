import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import { getTenantSettingsAction } from "./actions";
import { SettingsForm } from "./settings-form";

export default async function AdminSettingsPage() {
  let tenantAgentInstructions: string | null = null;
  let error = "";

  try {
    const settings = await getTenantSettingsAction();
    tenantAgentInstructions = settings.tenantAgentInstructions;
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : "An unexpected error occurred";
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Agent Instructions</h1>
        <p className="text-muted-foreground mt-1">
          Custom instructions included in the MCP handshake for all agents
          connecting to your tenant. These are sent alongside Monet&apos;s
          governance instructions when an agent initializes a session.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error loading settings</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : (
        <SettingsForm initialTenantAgentInstructions={tenantAgentInstructions} />
      )}
    </div>
  );
}
