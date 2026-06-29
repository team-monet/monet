/**
 * Regression test for the First Block section-header framing in buildPrewarmBlock.
 *
 * The rendered prewarm block header for an ACTIVE First Block entry must read as the
 * imperative "Governing workflows and preferences — MUST follow …" line. It must NOT
 * silently revert to the prior "First block (always-first, user-curated):" wording.
 *
 * The block is exercised via the public MCP path that the rest of the suite uses:
 * register the tools with autoPrewarm:true, make a non-agent_context tool call as the
 * first call (memory_first_block action="list"), and read content[1] — the auto-prewarm
 * block string that wrapSuccess appends.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

type McpContent = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe("prewarm First Block section header framing (regression)", () => {
  it("renders the imperative 'Governing workflows and preferences — MUST follow' header for an active pin", async () => {
    const core = new MonetCore(":memory:");
    const id = (await core.store("Governing workflow concept pinned for header regression.", { circle: "default" })).conceptId;
    core.promoteToFirstBlock(id, "Always-follow workflow summary.", "default");

    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: true, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);

    // First non-agent_context call appends the auto-prewarm block as content[1].
    const result = (await client.callTool({
      name: "memory_first_block",
      arguments: { action: "list" },
    })) as McpContent;
    const blockText = result.content.slice(1).map((c) => c.text).join("");

    // The block must be present (an active pin exists).
    expect(blockText.length).toBeGreaterThan(0);

    // Lock the exact imperative header wording.
    expect(blockText).toContain("Governing workflows and preferences — MUST follow unless a system/developer instruction or an explicit user instruction overrides:");
    // Guard against silent revert to the prior header.
    expect(blockText).not.toContain("First block (always-first, user-curated):");

    core.close();
  });
});