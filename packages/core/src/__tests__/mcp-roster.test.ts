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
  it("registers exactly the 22 documented tools (sorted)", async () => {
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
        "memory_gather",
        "memory_list",
        "memory_overview",
        "memory_ratify",
        "memory_reassign_circle",
        "memory_resolve",
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
        "Session-start orientation only. Call FIRST with no arguments. Returns the resolved `circle`; `resolvedFrom` appears when the requested circle was an alias. `stageIndex` (when present) names stages you can recognize; call stage_lookup(stage) for that moment's rules. Skeleton delivery has three states: absence means the standing files you already loaded are current; `mirrorStale` + `instruction` appears only when a standing file diverged and needs user-confirmed reconciliation; `skeleton` appears only for members not covered by a standing file.",
      );
      expect(byName.get("memory_workstreams")?.description).toBe(
        "Pull active/paused workstreams ONLY when the user expresses continuation intent. For “let's continue”, call with no id to get the compact list, then confirm with the user which thread to resume. For “continue <X>”, list first; if exactly one confident match exists, call again with that id for full detail, otherwise confirm. Full detail pages entries in this fixed order: openQuestions, decisions, discardedAlternatives, confirmedContext, importantEntities, nextSteps; entries retain stored order within each slot. Start detailOffset at 0, then add the number of entries actually returned across all slots; detailOmitted is the true number remaining. A session opened with a fresh directive never calls this tool.",
      );
      expect(byName.get("memory_overview")?.description).toBe(
        "Curation workbench for one circle: compact counts plus bounded actionable queues for possibleDuplicates, extractionCandidates, openContradictions, gate exceptions, and the ratified skeleton. The livingModel shows the top 5 current concepts by default. Pass includeDirty:true for the highest-evidence pending-synthesis cards; pass includeStale:true for the stalest re-confirmation cards. Both lists are capped and carry honest omission signals. Read-only; never returns memory bodies. Fetch an id to inspect evidence, resolve contradictions/pair flags with memory_resolve, and consolidate a true duplicate with memory_detach(destConceptId). Pass entity to list memories tied to one hub.",
      );
      const contextSchema = byName.get("agent_context")?.inputSchema as { properties?: Record<string, unknown> };
      expect(contextSchema.properties).not.toHaveProperty("includeStale");
    } finally {
      await cleanup();
    }
  });
});
