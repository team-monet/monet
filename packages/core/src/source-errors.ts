/** Remove credentials, secret-shaped values, query secrets, and machine-local paths from source errors. */
export function sanitizeSourceError(value: unknown): string {
  const input = value instanceof Error ? value.message : String(value);
  return input
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://[redacted]@")
    .replace(/([?&](?:access_token|auth|api[_-]?key|password|secret|token)=)[^\s&#]*/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi, "Bearer [redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[redacted]")
    .replace(/\b((?:api[_-]?key|password|passwd|secret|token|credential)s?\s*(?:=|:|is)\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(["'])\/(?!\/)[^"'\r\n]*\1/g, "$1[local-path]$1")
    .replace(/(["'])(?:[A-Za-z]:\\|\\\\)[^"'\r\n]*\1/g, "$1[local-path]$1")
    // Unquoted paths with spaces have no reliable lexical terminator. Source errors favor
    // confidentiality over detail, so redact the remainder of that line atomically.
    .replace(/(^|[\s(=:])\/(?!\/).*$/gm, "$1[local-path]")
    .replace(/(^|[\s(=:])(?:[A-Za-z]:\\|\\\\).*$/gm, "$1[local-path]");
}
