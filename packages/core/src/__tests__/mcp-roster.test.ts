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
  it("registers exactly the 23 documented tools (sorted)", async () => {
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
        "memory_flag_contradiction",
        "memory_list",
        "memory_overview",
        "memory_ratify",
        "memory_reassign_circle",
        "memory_resolve",
        "memory_restore",
        "memory_retire",
        "memory_search",
        "memory_store",
        "memory_synthesize",
        "memory_workstreams",
        "source_list",
        "source_path",
        "source_status",
        "source_sync",
        "stage_lookup",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("describes agent_context as orientation and memory_workstreams as continuation-only", async () => {
    const core = new MonetCore(":memory:");
    const { client, cleanup } = await makeMcpPair(core);
    try {
      const byName = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      expect(byName.get("agent_context")?.description).toBe(
        "Session-start orientation. Call first. Returns resolved `circle`; `resolvedFrom` marks an alias. `stageIndex` names moments whose rules require stage_lookup. Skeleton delivery has three states: no mirror fields means loaded standing files are current; `mirrorStale` + `instruction` requires user-confirmed reconciliation; `skeleton` contains members not covered by a standing file.",
      );
      expect(byName.get("memory_workstreams")?.description).toBe(
        "Call only on continuation intent, never for a fresh directive. Omit id to list compact active/paused workstreams, then confirm which to resume unless the user named one unambiguously. Pass its id for detail: OPEN items only, questions before steps, each with the id memory_checkpoint's `close` takes. `closedItems` says how many resolved ones exist without delivering them; pass includeClosed to see them with their state and closing session. Advance detailOffset by entries actually returned; detailOmitted is the true remainder.",
      );
      expect(byName.get("memory_overview")?.description).toBe(
        "Read-only curation workbench for one circle: compact counts, livingModel cards, bounded queues for possibleDuplicates, extractionCandidates, openContradictions and gate exceptions, plus the ratified skeleton. Opt into dirty or stale worklists; truncation fields report omissions. It never returns bodies: memory_fetch an id, use memory_resolve for contradictions or pair flags, and memory_detach with destConceptId to consolidate a duplicate. Pass entity to list one hub's memories.",
      );
      const contextSchema = byName.get("agent_context")?.inputSchema as { properties?: Record<string, unknown> };
      expect(contextSchema.properties).not.toHaveProperty("includeStale");
    } finally {
      await cleanup();
    }
  });
});
