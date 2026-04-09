import { headers } from "next/headers";

function firstHeaderValue(value: string | null) {
  return value?.split(",")[0]?.trim() || "";
}

async function resolveRequestDerivedApiBaseUrl() {
  const headerStore = await headers();
  const forwardedProtocol = firstHeaderValue(headerStore.get("x-forwarded-proto"));
  const forwardedHost = firstHeaderValue(headerStore.get("x-forwarded-host"));
  const requestHost = forwardedHost || firstHeaderValue(headerStore.get("host"));

  if (!requestHost) {
    return null;
  }

  const apiPort = process.env.API_PORT;
  let fallbackProtocol = "http";
  if (process.env.NEXTAUTH_URL) {
    try {
      fallbackProtocol = new URL(process.env.NEXTAUTH_URL).protocol.replace(/:$/, "");
    } catch {
      fallbackProtocol = "http";
    }
  }
  const protocol = forwardedProtocol || fallbackProtocol;

  try {
    const requestUrl = new URL(`${protocol}://${requestHost}`);
    if (apiPort) {
      requestUrl.port = apiPort;
    }
    return requestUrl.origin;
  } catch {
    return null;
  }
}

export async function resolvePublicMcpUrl(tenantSlug: string) {
  const baseUrl =
    process.env.MCP_PUBLIC_URL ||
    process.env.PUBLIC_API_URL ||
    process.env.API_BASE_URL ||
    (await resolveRequestDerivedApiBaseUrl()) ||
    `http://localhost:${process.env.API_PORT || "3001"}`;

  try {
    return new URL(`/mcp/${tenantSlug}`, baseUrl).toString();
  } catch {
    return `${baseUrl.replace(/\/$/, "")}/mcp/${tenantSlug}`;
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
