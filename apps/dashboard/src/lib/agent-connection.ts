export function resolvePublicMcpUrl() {
  const baseUrl =
    process.env.MCP_BASE_URL ||
    process.env.PUBLIC_API_URL ||
    process.env.API_BASE_URL ||
    process.env.INTERNAL_API_URL ||
    process.env.NEXTAUTH_URL ||
    "http://localhost:3001";

  try {
    return new URL("/mcp", baseUrl).toString();
  } catch {
    return `${baseUrl.replace(/\/$/, "")}/mcp`;
  }
}

export function buildMcpConfig(apiKey: string, mcpUrl: string) {
  return JSON.stringify(
    {
      mcpServers: {
        monet: {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
      },
    },
    null,
    2,
  );
}
