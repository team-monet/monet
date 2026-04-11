import http from "k6/http";
import { check, sleep } from "k6";
import { authHeaders, buildTenantMcpUrl } from "./utils.js";

const MCP_INIT_PAYLOAD = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "k6",
      version: "1.0.0",
    },
  },
});

export function runMcpSessionChurnScenario(data) {
  const headers = authHeaders(data.seed);
  const mcpUrl = buildTenantMcpUrl(data.baseUrl, data.seed);
  const connectRes = http.post(mcpUrl, MCP_INIT_PAYLOAD, {
    headers,
    timeout: data.requestTimeout,
  });

  const sessionId = connectRes.headers["Mcp-Session-Id"] || connectRes.headers["mcp-session-id"];
  if (sessionId) {
    const disconnectRes = http.del(mcpUrl, null, {
      headers: {
        ...headers,
        "Mcp-Session-Id": sessionId,
      },
      timeout: data.requestTimeout,
    });

    check(disconnectRes, {
      "mcp disconnect avoids 5xx": (r) => r.status < 500,
    });
  }

  check(connectRes, {
    "mcp connect avoids 5xx": (r) => r.status < 500,
  });

  sleep(0.1);
  return connectRes.timings.duration;
}
