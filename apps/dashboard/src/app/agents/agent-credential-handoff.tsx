"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function fallbackCopyWithExecCommand(text: string) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("aria-hidden", "true");
    textArea.readOnly = false;
    textArea.contentEditable = "true";
    textArea.style.position = "fixed";
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.width = "1px";
    textArea.style.height = "1px";
    textArea.style.padding = "0";
    textArea.style.border = "0";
    textArea.style.outline = "0";
    textArea.style.boxShadow = "none";
    textArea.style.background = "transparent";
    textArea.style.opacity = "0.01";
    textArea.style.pointerEvents = "none";
    textArea.style.zIndex = "-1";

    const selection = document.getSelection();
    const ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
      : [];
    const activeElement = document.activeElement as HTMLElement | null;

    document.body.appendChild(textArea);
    textArea.focus({ preventScroll: true });
    textArea.select();
    textArea.setSelectionRange(0, textArea.value.length);

    let successful = false;
    try {
      successful = document.execCommand("copy");
    } finally {
      document.body.removeChild(textArea);
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) {
          selection.addRange(range);
        }
      }
      try {
        activeElement?.focus({ preventScroll: true });
      } catch {
        // Ignore focus restoration issues.
      }
    }

    return successful;
  }

  async function handleCopy() {
    setError(null);

    let clipboardCopied = false;
    let fallbackCopied = false;
    let clipboardError: unknown;
    let fallbackError: unknown;

    const clipboardAttempt =
      typeof window !== "undefined" && window.isSecureContext && navigator.clipboard?.writeText
        ? navigator.clipboard.writeText(value)
        : null;

    if (clipboardAttempt) {
      try {
        await clipboardAttempt;
        clipboardCopied = true;
      } catch (err) {
        clipboardError = err;

        try {
          // Defer fallback until clipboard write settles.
          fallbackCopied = fallbackCopyWithExecCommand(value);
        } catch (fallbackErr) {
          fallbackError = fallbackErr;
        }
      }
    } else {
      try {
        // Keep fallback in the original click gesture when no async clipboard API exists.
        fallbackCopied = fallbackCopyWithExecCommand(value);
      } catch (fallbackErr) {
        fallbackError = fallbackErr;
      }
    }

    if (clipboardCopied || fallbackCopied) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      return;
    }

    try {
      // Last-resort fallback for browsers that block both clipboard APIs.
      window.prompt(`Copy ${label}:`, value);
    } catch {
      // noop
    }

    if (clipboardError) {
      console.error(`Failed to copy ${label}:`, clipboardError);
    } else if (fallbackError) {
      console.error(`Failed to copy ${label} with execCommand fallback:`, fallbackError);
    } else {
      console.error(`Failed to copy ${label}: no clipboard strategy succeeded.`);
    }
    setError("Copy unavailable here. Select the value and copy manually.");
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleCopy}
        className="h-8 min-w-[90px] gap-1.5 px-3 transition-all duration-200"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        <span className="text-xs font-medium">{copied ? "Copied" : label}</span>
      </Button>
      {error && <p className="text-right text-xs text-destructive">{error}</p>}
    </div>
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
          <code className="block break-all font-mono text-xs">{apiKey}</code>
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="agent-mcp-url">MCP URL</Label>
          <CopyButton value={mcpUrl} label="Copy URL" />
        </div>
        <div className="overflow-hidden rounded-md border bg-muted px-3 py-2">
          <code className="block break-all font-mono text-xs">{mcpUrl}</code>
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
