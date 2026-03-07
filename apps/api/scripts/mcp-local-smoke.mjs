#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseToolText(result) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function main() {
  const apiKey = requiredEnv("MCP_API_KEY");
  const mcpUrl =
    process.env.MCP_URL ??
    `http://127.0.0.1:${process.env.API_PORT ?? "3001"}/mcp`;
  const createTestMemory = process.env.MCP_SMOKE_WRITE === "true";

  const client = new Client({ name: "local-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  });

  await client.connect(transport);
  const tools = await client.listTools();
  console.log(
    `Connected to MCP (${mcpUrl}). tools=${tools.tools.length} [${tools.tools.map((tool) => tool.name).join(", ")}]`,
  );

  if (createTestMemory) {
    const result = await client.callTool({
      name: "memory_store",
      arguments: {
        content: `MCP smoke memory ${new Date().toISOString()}`,
        memoryType: "fact",
        memoryScope: "group",
        tags: ["mcp-smoke", "local-dev"],
      },
    });
    const parsed = parseToolText(result);
    console.log(`memory_store id=${parsed?.id ?? "unknown"}`);
  }

  await client.close();
}

void main().catch((error) => {
  console.error("MCP smoke failed", error);
  process.exit(1);
});
