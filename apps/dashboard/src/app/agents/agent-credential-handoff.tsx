"use client";

import { type ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";

export function AgentCredentialHandoff({
  apiKey,
  mcpUrl,
  mcpConfig,
  title = "API key issued",
  description = "This key is shown once. Store it now before closing this dialog.",
  footer,
}: {
  apiKey: string;
  mcpUrl: string;
  mcpConfig: string;
  title?: string;
  description?: string;
  footer?: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-4">
      <Alert>
        <KeyRound className="h-4 w-4" />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </Alert>

      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="agent-api-key">API Key</Label>
        </div>
        <div className="overflow-hidden rounded-md border bg-muted px-3 py-2">
          <code className="block break-all font-mono text-xs">{apiKey}</code>
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="agent-mcp-url">MCP URL</Label>
        </div>
        <div className="overflow-hidden rounded-md border bg-muted px-3 py-2">
          <code className="block break-all font-mono text-xs">{mcpUrl}</code>
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label>MCP Config</Label>
        </div>
        <pre className="max-h-64 overflow-auto break-all rounded-md border bg-muted p-3 text-xs">
          <code className="whitespace-pre-wrap">{mcpConfig}</code>
        </pre>
        <p className="text-xs text-muted-foreground">
          Paste this into your MCP client config, such as Claude Code `~/.claude.json` or Cursor MCP settings.
          Update the URL if your public MCP endpoint differs from the detected host.
        </p>
      </div>

      {footer}
    </div>
  );
}
