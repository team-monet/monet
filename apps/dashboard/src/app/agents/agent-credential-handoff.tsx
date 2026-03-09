"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

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
          <CopyButton value={apiKey} label="Copy key" />
        </div>
        <div className="overflow-hidden rounded-md border bg-muted px-3 py-2">
          <code className="block truncate font-mono text-xs">{apiKey}</code>
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="agent-mcp-url">MCP URL</Label>
          <CopyButton value={mcpUrl} label="Copy URL" />
        </div>
        <div className="overflow-hidden rounded-md border bg-muted px-3 py-2">
          <code className="block truncate font-mono text-xs">{mcpUrl}</code>
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label>MCP Config</Label>
          <CopyButton value={mcpConfig} label="Copy config" />
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
