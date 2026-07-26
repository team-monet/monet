/**
 * Tool-roster drift gate — pins the EXACT set of tools the MCP server registers.
 *
 * The canonical user-facing tool contract lives in with-monet's bootstrap/install.md
 * (a separate repo); roster changes (add/remove/rename) have shipped with doc lag
 * before. This test makes any drift loud: when it fails, update the contract doc and
 * the enumeration below in the same change.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";

/** Boot an in-process MCP server+client pair sharing a MonetCore. */
async function makeMcpPair(core: MonetCore): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "monet-core-test", version: "0.6.0" }, { capabilities: { tools: {} } });
  registerMonetCoreTools(server, core);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
      core.close();
    },
  };
}

describe("tool roster — drift gate", () => {
  it("registers exactly the 20 documented tools (sorted)", async () => {
    const core = new MonetCore(":memory:");
    const { client, cleanup } = await makeMcpPair(core);
    try {
      const { tools } = await client.listTools();
      const registered = tools.map((t) => t.name).sort();
      expect(
        registered,
        "tool roster changed — update with-monet bootstrap/install.md (the canonical tool contract) and this enumeration together.",
      ).toEqual([
        "agent_context",
        "memory_checkpoint",
        "memory_circle_manage",
        "memory_declare",
        "memory_detach",
        "memory_fetch",
        "memory_first_block",
        "memory_flag_contradiction",
        "memory_gather",
        "memory_list",
        "memory_overview",
        "memory_reassign_circle",
        "memory_resolve",
        "memory_search",
        "memory_store",
        "memory_synthesize",
        "source_list",
        "source_path",
        "source_status",
        "source_sync",
      ]);
    } finally {
      await cleanup();
    }
  });
});
