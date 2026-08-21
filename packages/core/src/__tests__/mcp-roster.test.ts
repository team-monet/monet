/**
 * Tool-roster drift gate — pins the EXACT set of tools the MCP server registers.
 *
 * Tool descriptions are the canonical user-facing contract; with-monet's install surface explicitly
 * defers to them. This test makes roster or load-bearing description drift loud.
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
  it("registers exactly the 21 documented tools (sorted)", async () => {
    const core = new MonetCore(":memory:");
    const { client, cleanup } = await makeMcpPair(core);
    try {
      const { tools } = await client.listTools();
      const registered = tools.map((t) => t.name).sort();
      expect(
        registered,
        "tool roster changed — review the canonical tool descriptions and this enumeration together.",
      ).toEqual([
        "agent_context",
        // The fourth fact enters the record ONLY through these two, and they are deliberately two:
        // the ask is the agent's event, the answer is the user's. One combined call would make the
        // agent the author of a fact it does not own and would erase the difference between
        // `unanswered` (asked, waiting) and `not asked` (an agent defect).
        "conformance_answer",
        "conformance_ask",
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
        "Session-start orientation. Call first. Returns resolved `circle`; `resolvedFrom` marks an alias. `stageIndex` names moments whose rules require stage_lookup. Skeleton delivery has three states: no mirror fields means loaded standing files are current; `mirrorStale` + `instruction` requires user-confirmed reconciliation; `skeleton` contains members not covered by a standing file. `open` counts workstreams and inbox items still open — mention them to the user; resume only when asked.",
      );
      expect(byName.get("memory_checkpoint")?.description).toBe(
        "Track work and capture finds as they happen — nothing is owed at session end. When a work directive lands, open the plan: work-level items that may outlive the session (fine-grained decomposition stays in the host's own todo). When something surfaces that is not this work, `inbox` it — one line, keep moving. Before reporting completion, settle: close what resolved, and dispose the inbox with the user — do it now, `filed` with a `ref`, `dropped`, or leave open to keep. This MERGES: `open` adds, `close` resolves by id, anything unnamed stays untouched. Address a workstream by `title` (mints if new) or `id` (exact); with neither, the one this session already touched, or the only active one — several active means refusal with the list. The receipt is only what this call did: `opened`/`closed` item ids, `status` only when this call changed it.",
      );
      expect(byName.get("memory_workstreams")?.description).toBe(
        "Two reads, two moments. Resume — on continuation intent only, never a fresh directive: omit `id` to list active/paused workstreams and confirm which to resume; then pass its `id` for detail — OPEN items only, questions first, each carrying the id `close` takes. Settle — `id: \"inbox\"` before reporting completion: every find awaiting disposition, this session's and every kept one. `closedCount` says how many resolved items exist without delivering them; `includeClosed` returns them with `state`, `closedAt`, and `ref` for the filed. Advance `detailOffset` by items actually returned; `detailOmitted` is the true remainder.",
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
