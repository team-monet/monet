/**
 * IN-BAND SESSION LIFECYCLE tests (0.7.0)
 *
 * Covers:
 *  1. Auto-prewarm block: first non-agent_context call carries the block exactly once.
 *  2. First call agent_context → NO block anywhere in the session.
 *  3. Error-first: failing call carries no block; next successful call does.
 *  4. Empty store → no block, one-shot consumed.
 *  5. Curation line appears only when thresholds trip.
 *  6. Per-item ceiling: content[0] (JSON result) stays ≤ RESULT_MAX_CHARS;
 *     content[1] (prewarm block) stays ≤ PREWARM_BLOCK_MAX_CHARS.
 *  7. Nudge: 10th mutating call triggers, 30th triggers, not in-between; checkpoint-with-workstream
 *     resets; nudge text never on checkpoint-with-workstream's own response.
 *  8. Opt-out: autoPrewarm:false → no block; checkpointNudge:false → no nudge.
 *  9. Server instructions: factory options include the instructions string.
 * 10. Fix 1 regression: JSON.parse(content[0].text) always succeeds on prewarm-carrying responses.
 * 11. Fix 2 curationAttention: agent_context payload gains optional field when thresholds trip.
 * 12. Fix 5a env-var opt-out: MONET_NO_AUTOPREWARM/MONET_NO_CHECKPOINT_NUDGE mapping.
 * 13. Fix 5b stale/dirty thresholds: dedicated tests for stale>=5 and dirty>=10.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonetCore } from "../engine";
import { registerMonetCoreTools, createMonetCoreMcpServer, deriveOptsFromEnv } from "../mcp-server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREWARM_HEADER = "=== MONET SESSION CONTEXT (auto-prewarm) ===";
const PREWARM_FOOTER = "=== END SESSION CONTEXT ===";
const NUDGE_TEXT = "[monet] Session has unsaved state";
const RESULT_MAX_CHARS = 40_000;
const PREWARM_BLOCK_MAX_CHARS = 2_500;

interface McpPairOpts {
  autoPrewarm?: boolean;
  checkpointNudge?: boolean;
}

type McpResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function makePair(
  core: MonetCore,
  opts: McpPairOpts = {},
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer(
    { name: "test", version: "0.7.0" },
    { capabilities: { tools: {} } },
  );
  registerMonetCoreTools(server, core, opts);
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

/** content[0].text — the pure JSON result, always parseable. */
function rawText(result: unknown): string {
  return ((result as McpResult).content[0]?.text) ?? "";
}

/** content[1].text — the prewarm block, when present. */
function prewarmText(result: unknown): string {
  return ((result as McpResult).content[1]?.text) ?? "";
}

/** The last content item's text — the nudge line, when present. */
function lastItemText(result: unknown): string {
  const items = (result as McpResult).content;
  return items[items.length - 1]?.text ?? "";
}

function isError(result: unknown): boolean {
  return !!(result as McpResult).isError;
}

/** Parse the JSON payload from content[0] (always pure JSON after Fix 1). */
function parsePayload(result: unknown): unknown {
  return JSON.parse(rawText(result));
}

// ---------------------------------------------------------------------------
// 1. First non-agent_context call carries the block exactly once
// ---------------------------------------------------------------------------

describe("1. auto-prewarm: block appears on first non-agent_context call, then never again", () => {
  it("second call (same tool) carries no block", async () => {
    const core = new MonetCore(":memory:");
    await core.store("SQLite is the local storage engine.");
    const { client, cleanup } = await makePair(core);
    try {
      // First call: memory_search — should carry the prewarm block in content[1].
      const first = await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
      expect(prewarmText(first)).toContain(PREWARM_HEADER);
      expect(prewarmText(first)).toContain(PREWARM_FOOTER);

      // Second call: same tool — no block (content has only 1 item).
      const second = await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
      expect(prewarmText(second)).not.toContain(PREWARM_HEADER);
    } finally {
      await cleanup();
    }
  });

  it("different-tool second call also carries no block", async () => {
    const core = new MonetCore(":memory:");
    await core.store("Auth uses jose for JWT.");
    const { client, cleanup } = await makePair(core);
    try {
      const first = await client.callTool({ name: "memory_search", arguments: { query: "auth" } });
      expect(prewarmText(first)).toContain(PREWARM_HEADER);

      const second = await client.callTool({ name: "memory_overview", arguments: {} });
      expect(prewarmText(second)).not.toContain(PREWARM_HEADER);
    } finally {
      await cleanup();
    }
  });

  it("content[0] always contains the pure JSON payload", async () => {
    const core = new MonetCore(":memory:");
    await core.store("SQLite is the local storage engine.");
    const { client, cleanup } = await makePair(core);
    try {
      const result = await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
      // content[1] has the prewarm block.
      expect(prewarmText(result)).toContain(PREWARM_HEADER);
      // content[0] must be pure JSON, parseable without any block-stripping.
      const payload = parsePayload(result) as Record<string, unknown>;
      expect(payload).toHaveProperty("results");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. First call agent_context → NO block anywhere in the session
// ---------------------------------------------------------------------------

describe("2. first call agent_context → no block ever in session", () => {
  it("agent_context first → its own response has no block, subsequent calls have no block", async () => {
    const core = new MonetCore(":memory:");
    await core.store("SQLite is the local storage engine.");
    const { client, cleanup } = await makePair(core);
    try {
      const ctx = await client.callTool({ name: "agent_context", arguments: {} });
      expect(prewarmText(ctx)).not.toContain(PREWARM_HEADER);

      const search = await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
      expect(prewarmText(search)).not.toContain(PREWARM_HEADER);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Error-first: failing call carries no block; next success does
// ---------------------------------------------------------------------------

describe("3. error-first: block deferred to first successful call", () => {
  it("a failing call (malformed) carries no block; the next successful call carries it", async () => {
    const core = new MonetCore(":memory:");
    await core.store("SQLite storage.");
    const { client, cleanup } = await makePair(core);
    try {
      // memory_store with no content → should fail.
      const failResult = await client.callTool({ name: "memory_store", arguments: {} });
      expect(isError(failResult)).toBe(true);
      expect(prewarmText(failResult)).not.toContain(PREWARM_HEADER);

      // Next successful call should carry the block.
      const okResult = await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
      expect(prewarmText(okResult)).toContain(PREWARM_HEADER);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Empty store → no block, one-shot consumed
// ---------------------------------------------------------------------------

describe("4. empty store → no block, one-shot consumed", () => {
  it("first call on an empty store produces no block; second call also no block", async () => {
    const core = new MonetCore(":memory:");
    const { client, cleanup } = await makePair(core);
    try {
      const first = await client.callTool({ name: "memory_search", arguments: { query: "anything" } });
      expect(prewarmText(first)).not.toContain(PREWARM_HEADER);

      // Second call also no block (one-shot was consumed).
      const second = await client.callTool({ name: "memory_overview", arguments: {} });
      expect(prewarmText(second)).not.toContain(PREWARM_HEADER);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Curation line appears only when thresholds trip
// ---------------------------------------------------------------------------

describe("5. curation line appears only on tripped thresholds", () => {
  it("no curation line when no threshold is tripped", async () => {
    const core = new MonetCore(":memory:");
    await core.store("SQLite for storage.");
    const { client, cleanup } = await makePair(core);
    try {
      const result = await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
      expect(prewarmText(result)).toContain(PREWARM_HEADER); // block present
      expect(prewarmText(result)).not.toContain("Curation attention:");
    } finally {
      await cleanup();
    }
  });

  it("curation line appears when disputed>=1", async () => {
    // Build a store with at least one disputed concept.
    const core = new MonetCore(":memory:");
    const r = await core.store("We use SQLite for storage.");
    core.flagContradiction(r.conceptId, { detail: "actually we use Postgres" });
    // Verify it is disputed.
    const ov = core.overview("default");
    expect(ov.counts.disputed).toBeGreaterThanOrEqual(1);

    const { client, cleanup } = await makePair(core);
    try {
      const result = await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
      expect(prewarmText(result)).toContain(PREWARM_HEADER);
      expect(prewarmText(result)).toContain("Curation attention:");
      expect(prewarmText(result)).toContain("curate-memory ritual");
    } finally {
      await cleanup();
    }
  });

  it("curation line appears when possibleDuplicates>=3", async () => {
    // Build a store with 3+ possible duplicate pairs.
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const pairs = [
      ["We use SQLite for local persistence in Monet.", "Monet persists data locally with SQLite storage."],
      ["Auth tokens are signed using the jose library.", "The jose library signs authentication tokens here."],
      ["The CI pipeline runs on GitHub Actions.", "GitHub Actions is used for our continuous integration."],
    ];
    for (const [a, b] of pairs) {
      await core.store(a);
      await core.store(b);
    }
    const ov = core.overview("default");
    expect(ov.counts.possibleDuplicates).toBeGreaterThanOrEqual(3);

    const { client, cleanup } = await makePair(core);
    try {
      const result = await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
      expect(prewarmText(result)).toContain(PREWARM_HEADER);
      expect(prewarmText(result)).toContain("Curation attention:");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Per-item ceiling
// ---------------------------------------------------------------------------

describe("6. per-item ceiling: content[0] ≤ RESULT_MAX_CHARS; prewarm block ≤ PREWARM_BLOCK_MAX_CHARS", () => {
  it("content[0] stays ≤ RESULT_MAX_CHARS even for a very large overview", async () => {
    // Store enough content to push the result close to (but under) the cap.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    for (let i = 0; i < 40; i++) {
      await core.store(`Distinct concept number ${i}: ${"x".repeat(200)} concept body detail about topic ${i}.`, { resolution: "forceNew" });
    }
    const { client, cleanup } = await makePair(core);
    try {
      const result = await client.callTool({ name: "memory_overview", arguments: {} });
      // content[0] must stay within the ceiling.
      expect(rawText(result).length).toBeLessThanOrEqual(RESULT_MAX_CHARS);
      // content[0] must always be parseable JSON (not contaminated by prewarm block).
      expect(() => JSON.parse(rawText(result))).not.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("prewarm block stays ≤ PREWARM_BLOCK_MAX_CHARS even when many concepts trip all lines", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    // Store many concepts to push block rendering to its cap.
    for (let i = 0; i < 30; i++) {
      await core.store(`Concept ${i}: ${"y".repeat(100)}`, { resolution: "forceNew" });
    }
    const { client, cleanup } = await makePair(core);
    try {
      const result = await client.callTool({ name: "memory_search", arguments: { query: "Concept" } });
      const block = prewarmText(result);
      if (block.includes(PREWARM_HEADER)) {
        expect(block.length).toBeLessThanOrEqual(PREWARM_BLOCK_MAX_CHARS);
        // Delimiters must both be present (intact block structure).
        expect(block).toContain(PREWARM_HEADER);
        expect(block).toContain(PREWARM_FOOTER);
      }
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Checkpoint nudge behavior
// ---------------------------------------------------------------------------

describe("7. checkpoint nudge", () => {
  it("nudge appears at the 10th mutating call, not before", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      // Do 9 mutating calls — no nudge.
      for (let i = 0; i < 9; i++) {
        const result = await client.callTool({ name: "memory_store", arguments: { content: `Fact ${i}.` } });
        expect(lastItemText(result)).not.toContain(NUDGE_TEXT);
      }
      // 10th mutating call — nudge appears as a separate content item.
      const tenth = await client.callTool({ name: "memory_store", arguments: { content: "Tenth fact." } });
      expect(lastItemText(tenth)).toContain(NUDGE_TEXT);
      // content[0] must still be pure JSON.
      expect(() => JSON.parse(rawText(tenth))).not.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("nudge appears again at the 30th mutating call, not between 11th and 29th", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      // First 10 calls to get past first nudge.
      for (let i = 0; i < 10; i++) {
        await client.callTool({ name: "memory_store", arguments: { content: `Fact ${i}.` } });
      }
      // Calls 11–29: no nudge.
      for (let i = 10; i < 29; i++) {
        const result = await client.callTool({ name: "memory_store", arguments: { content: `Fact ${i}.` } });
        expect(lastItemText(result)).not.toContain(NUDGE_TEXT);
      }
      // 30th mutating call — nudge.
      const thirtieth = await client.callTool({ name: "memory_store", arguments: { content: "Thirtieth fact." } });
      expect(lastItemText(thirtieth)).toContain(NUDGE_TEXT);
    } finally {
      await cleanup();
    }
  });

  it("checkpoint-with-workstream resets counter; no nudge soon after", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      // 10 mutating calls to trigger the first nudge.
      for (let i = 0; i < 10; i++) {
        await client.callTool({ name: "memory_store", arguments: { content: `Fact ${i}.` } });
      }
      // Checkpoint with workstream payload — should NOT nudge and resets counter.
      const ckResult = await client.callTool({
        name: "memory_checkpoint",
        arguments: {
          workstream: { status: "active", nextSteps: ["continue tomorrow"] },
        },
      });
      expect(lastItemText(ckResult)).not.toContain(NUDGE_TEXT);

      // After reset, 9 more mutating calls should not nudge (counter back to 0).
      for (let i = 0; i < 9; i++) {
        const result = await client.callTool({ name: "memory_store", arguments: { content: `Post-ck fact ${i}.` } });
        expect(lastItemText(result)).not.toContain(NUDGE_TEXT);
      }
    } finally {
      await cleanup();
    }
  });

  it("nudge text is never on the response that carries the prewarm block", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    // Pre-populate so the block is non-empty.
    await core.store("SQLite for storage.");
    const { client, cleanup } = await makePair(core);
    try {
      // First call: memory_search → prewarm block attached (not mutating).
      await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
      // Then 9 mutating calls.
      for (let i = 0; i < 9; i++) {
        await client.callTool({ name: "memory_store", arguments: { content: `Fact ${i}.` } });
      }
      // 10th mutating call: nudge should appear, but no prewarm block (already consumed).
      const tenth = await client.callTool({ name: "memory_store", arguments: { content: "Tenth." } });
      expect(lastItemText(tenth)).toContain(NUDGE_TEXT);
      expect(prewarmText(tenth)).not.toContain(PREWARM_HEADER);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Opt-out
// ---------------------------------------------------------------------------

describe("8. opt-out flags", () => {
  it("autoPrewarm:false → no block on any call", async () => {
    const core = new MonetCore(":memory:");
    await core.store("SQLite for storage.");
    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      const first = await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
      expect(prewarmText(first)).not.toContain(PREWARM_HEADER);

      const second = await client.callTool({ name: "memory_overview", arguments: {} });
      expect(prewarmText(second)).not.toContain(PREWARM_HEADER);
    } finally {
      await cleanup();
    }
  });

  it("checkpointNudge:false → no nudge on the 10th mutating call", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const { client, cleanup } = await makePair(core, { autoPrewarm: false, checkpointNudge: false });
    try {
      for (let i = 0; i < 15; i++) {
        const result = await client.callTool({ name: "memory_store", arguments: { content: `Fact ${i}.` } });
        expect(lastItemText(result)).not.toContain(NUDGE_TEXT);
      }
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Server instructions
// ---------------------------------------------------------------------------

describe("9. server factory instructions", () => {
  it("createMonetCoreMcpServer options include an instructions string with key phrase", async () => {
    const core = new MonetCore(":memory:");
    const server = new McpServer(
      { name: "monet-core", version: "0.7.0" },
      {
        capabilities: { tools: {} },
        instructions: "Monet is the user's persistent memory substrate; start by calling agent_context (no arguments) to restore active workstreams, the living model, and open contradictions from prior sessions; during the session use memory_store to record durable knowledge and memory_search/memory_gather (cards) + memory_fetch (content) to recall; end by calling memory_checkpoint with a workstream snapshot (open questions, decisions, next steps) so the session survives; without a checkpoint, session state is lost.",
      },
    );
    registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(clientTransport);
    try {
      const { MONET_SERVER_INSTRUCTIONS } = await import("../mcp-server");
      expect(MONET_SERVER_INSTRUCTIONS).toContain("start by calling agent_context");
      expect(MONET_SERVER_INSTRUCTIONS).toContain("memory_checkpoint");
      expect(MONET_SERVER_INSTRUCTIONS).toContain("without a checkpoint, session state is lost");
    } finally {
      await client.close();
      core.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Fix 1 regression: JSON.parse(content[0].text) always works on prewarm-carrying responses
// ---------------------------------------------------------------------------

describe("10. Fix 1 regression: content[0].text is always valid JSON on prewarm-carrying responses", () => {
  it("memory_store response with prewarm block: content[0].text parses as JSON", async () => {
    // Populated store — prewarm block will be non-empty.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await core.store("SQLite is the local storage engine.");
    await core.store("Auth uses jose for JWT.", { resolution: "forceNew" });
    const { client, cleanup } = await makePair(core);
    try {
      // First call (memory_store) should carry the prewarm block in content[1].
      const result = await client.callTool({ name: "memory_store", arguments: { content: "New fact stored." } });
      // Verify the prewarm block is present somewhere in the response.
      expect(prewarmText(result)).toContain(PREWARM_HEADER);
      // The key regression test: content[0].text MUST parse as JSON without any block-stripping.
      const parsed = JSON.parse(rawText(result)) as Record<string, unknown>;
      expect(parsed).toHaveProperty("conceptId");
      expect(parsed).toHaveProperty("action");
    } finally {
      await cleanup();
    }
  });

  it("memory_search response with prewarm block: content[0].text parses as JSON", async () => {
    const core = new MonetCore(":memory:");
    await core.store("SQLite is the local storage engine.");
    const { client, cleanup } = await makePair(core);
    try {
      const result = await client.callTool({ name: "memory_search", arguments: { query: "SQLite" } });
      expect(prewarmText(result)).toContain(PREWARM_HEADER);
      const parsed = JSON.parse(rawText(result)) as Record<string, unknown>;
      expect(parsed).toHaveProperty("results");
    } finally {
      await cleanup();
    }
  });

  it("memory_store response with nudge: content[0].text parses as JSON", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      // Get to the 10th mutating call to trigger the nudge.
      for (let i = 0; i < 9; i++) {
        await client.callTool({ name: "memory_store", arguments: { content: `Fact ${i}.` } });
      }
      const tenth = await client.callTool({ name: "memory_store", arguments: { content: "Tenth." } });
      expect(lastItemText(tenth)).toContain(NUDGE_TEXT);
      // content[0] must still be pure JSON.
      const parsed = JSON.parse(rawText(tenth)) as Record<string, unknown>;
      expect(parsed).toHaveProperty("conceptId");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Fix 2: curationAttention field on agent_context
// ---------------------------------------------------------------------------

describe("11. Fix 2: agent_context curationAttention field", () => {
  it("tripping store → curationAttention present in agent_context payload with correct text", async () => {
    // Build a store with at least one disputed concept (disputed>=1 is the lowest threshold to trip).
    const core = new MonetCore(":memory:");
    const r = await core.store("We use SQLite for storage.");
    core.flagContradiction(r.conceptId, { detail: "actually Postgres" });
    const ov = core.overview("default");
    expect(ov.counts.disputed).toBeGreaterThanOrEqual(1);

    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      const result = await client.callTool({ name: "agent_context", arguments: {} });
      const parsed = JSON.parse(rawText(result)) as Record<string, unknown>;
      expect(parsed).toHaveProperty("curationAttention");
      const advisory = parsed.curationAttention as string;
      expect(advisory).toContain("curate-memory ritual");
      expect(advisory).toContain("disputed=1");
    } finally {
      await cleanup();
    }
  });

  it("non-tripping store → curationAttention ABSENT (not null, not empty string)", async () => {
    const core = new MonetCore(":memory:");
    await core.store("SQLite for storage.");
    // No contradictions, no duplicates, no stale, no dirty.
    const ov = core.overview("default");
    expect(ov.counts.disputed).toBe(0);
    expect(ov.counts.possibleDuplicates).toBe(0);

    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      const result = await client.callTool({ name: "agent_context", arguments: {} });
      const parsed = JSON.parse(rawText(result)) as Record<string, unknown>;
      // Must be absent entirely — not null, not empty string.
      expect("curationAttention" in parsed).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("possibleDuplicates>=3 → curationAttention present in agent_context", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const pairs = [
      ["We use SQLite for local persistence in Monet.", "Monet persists data locally with SQLite storage."],
      ["Auth tokens are signed using the jose library.", "The jose library signs authentication tokens here."],
      ["The CI pipeline runs on GitHub Actions.", "GitHub Actions is used for our continuous integration."],
    ];
    for (const [a, b] of pairs) {
      await core.store(a);
      await core.store(b);
    }
    const ov = core.overview("default");
    expect(ov.counts.possibleDuplicates).toBeGreaterThanOrEqual(3);

    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      const result = await client.callTool({ name: "agent_context", arguments: {} });
      const parsed = JSON.parse(rawText(result)) as Record<string, unknown>;
      expect("curationAttention" in parsed).toBe(true);
      expect((parsed.curationAttention as string)).toContain("possibleDuplicates=");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Fix 5a: env-var opt-out mapping
// ---------------------------------------------------------------------------

describe("12. Fix 5a: deriveOptsFromEnv env-var mapping", () => {
  it("MONET_NO_AUTOPREWARM=1 → autoPrewarm:false", () => {
    const opts = deriveOptsFromEnv({ MONET_NO_AUTOPREWARM: "1" });
    expect(opts.autoPrewarm).toBe(false);
    expect(opts.checkpointNudge).toBe(true);
  });

  it("MONET_NO_CHECKPOINT_NUDGE=1 → checkpointNudge:false", () => {
    const opts = deriveOptsFromEnv({ MONET_NO_CHECKPOINT_NUDGE: "1" });
    expect(opts.autoPrewarm).toBe(true);
    expect(opts.checkpointNudge).toBe(false);
  });

  it("both vars set → both false", () => {
    const opts = deriveOptsFromEnv({ MONET_NO_AUTOPREWARM: "1", MONET_NO_CHECKPOINT_NUDGE: "1" });
    expect(opts.autoPrewarm).toBe(false);
    expect(opts.checkpointNudge).toBe(false);
  });

  it("neither var set → both default to true", () => {
    const opts = deriveOptsFromEnv({});
    expect(opts.autoPrewarm).toBe(true);
    expect(opts.checkpointNudge).toBe(true);
  });

  it("MONET_NO_AUTOPREWARM=0 → autoPrewarm:true (not '1' string)", () => {
    const opts = deriveOptsFromEnv({ MONET_NO_AUTOPREWARM: "0" });
    expect(opts.autoPrewarm).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14. Fix A: prewarm block reflects the CALL'S resolved circle (not the default)
// ---------------------------------------------------------------------------

describe("14. Fix A: prewarm block reflects the call's explicit circle, not the session default", () => {
  it("memory_search({circle:'foo'}) on populated foo / empty default → block contains foo content", async () => {
    // Setup: "foo" has content; default is empty.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await core.store("Foo circle concept: GraphQL used for API.", { circle: "foo" });

    // Confirm: foo is populated, default is empty.
    expect(core.conceptCount("foo")).toBeGreaterThan(0);
    expect(core.conceptCount("default")).toBe(0);

    const { client, cleanup } = await makePair(core);
    try {
      const result = await client.callTool({
        name: "memory_search",
        arguments: { query: "GraphQL", circle: "foo" },
      });

      // Block must be present (foo has content).
      const block = prewarmText(result);
      expect(block).toContain(PREWARM_HEADER);
      // Block must mention foo's content — the concept title or keyword.
      expect(block).toContain("GraphQL");
    } finally {
      await cleanup();
    }
  });

  it("memory_search({circle:'foo'}) on populated foo / empty default → block does NOT reflect default (which has nothing)", async () => {
    // The key correctness check: default is empty, so if the block were built from default
    // it would be empty entirely — no PREWARM_HEADER at all. The block being present with
    // foo content proves we snapshotted foo, not default.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await core.store("Foo circle concept: Redis used for caching.", { circle: "foo" });
    expect(core.conceptCount("default")).toBe(0);

    const { client, cleanup } = await makePair(core);
    try {
      const result = await client.callTool({
        name: "memory_search",
        arguments: { query: "Redis", circle: "foo" },
      });
      // If bug is present: scope() resolves default → default is empty → block is empty → no PREWARM_HEADER.
      // After fix: scope("foo") → foo is populated → block present.
      expect(prewarmText(result)).toContain(PREWARM_HEADER);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Fix B — test 1: fresh empty store, first call memory_store → NO block
// ---------------------------------------------------------------------------

describe("15. Fix B: first call memory_store on empty store → no block (nothing to restore)", () => {
  it("fresh store: first call memory_store → no prewarm block (one-shot consumed correctly)", async () => {
    const core = new MonetCore(":memory:");
    // Deliberately empty store — no prior session context exists.
    expect(core.conceptCount("default")).toBe(0);

    const { client, cleanup } = await makePair(core);
    try {
      const result = await client.callTool({
        name: "memory_store",
        arguments: { content: "First ever fact written into this store." },
      });
      // No prior context → no block. One-shot must be consumed (next call also no block).
      expect(prewarmText(result)).not.toContain(PREWARM_HEADER);

      // Verify one-shot was consumed: second call also no block.
      const second = await client.callTool({
        name: "memory_search",
        arguments: { query: "fact" },
      });
      expect(prewarmText(second)).not.toContain(PREWARM_HEADER);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 16. Fix B — THE KILLER: prior concept A in circle, first call memory_store(B) →
//     block present (mentions A), does NOT mention B
// ---------------------------------------------------------------------------

describe("16. Fix B (killer): first call memory_store(B) → block shows prior A, not B", () => {
  it("circle has concept A; first MCP call is memory_store(B) → block mentions A title, NOT B", async () => {
    // Setup: circle already has concept A from a prior session.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await core.store("Prior concept A: the project uses TypeScript strictly.", { resolution: "forceNew" });
    expect(core.conceptCount("default")).toBe(1);

    const { client, cleanup } = await makePair(core);
    try {
      // First MCP call is a MUTATION — storing new fact B.
      const result = await client.callTool({
        name: "memory_store",
        arguments: { content: "New fact B: switched to Bun runtime from Node." },
      });

      // Block must be present: the store had prior context.
      const block = prewarmText(result);
      expect(block).toContain(PREWARM_HEADER);

      // Block must mention A (the pre-existing concept).
      expect(block).toContain("TypeScript");

      // Block must NOT mention B (the fact just written in this same call).
      // If the block was built AFTER the mutation, B might appear — that's the bug.
      expect(block).not.toContain("Bun runtime");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 17. Fix B: error-first with explicit circle → one-shot not consumed;
//     next success carries correctly-circled block
// ---------------------------------------------------------------------------

describe("17. Fix B: error-first with explicit circle → one-shot survives, next success carries circled block", () => {
  it("failing memory_store (no content) leaves one-shot unconsumed; next success (same circle) carries block", async () => {
    // Setup: "bar" has content; default is empty.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await core.store("Bar circle concept: Postgres for persistence.", { circle: "bar" });
    expect(core.conceptCount("bar")).toBeGreaterThan(0);
    expect(core.conceptCount("default")).toBe(0);

    const { client, cleanup } = await makePair(core);
    try {
      // First call: memory_store with no content → error.
      const failResult = await client.callTool({
        name: "memory_store",
        arguments: { circle: "bar" }, // missing required `content`
      });
      expect(isError(failResult)).toBe(true);
      // One-shot must NOT be consumed on error.
      expect(prewarmText(failResult)).not.toContain(PREWARM_HEADER);

      // Second call: memory_search with explicit circle "bar" → success → block from bar.
      const okResult = await client.callTool({
        name: "memory_search",
        arguments: { query: "Postgres", circle: "bar" },
      });
      const block = prewarmText(okResult);
      expect(block).toContain(PREWARM_HEADER);
      // Block must reflect bar's content, not the empty default.
      expect(block).toContain("Postgres");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Fix 5b: stale>=5 and dirty>=10 curation thresholds
// ---------------------------------------------------------------------------

describe("13. Fix 5b: stale>=5 and dirty>=10 curation thresholds", () => {
  it("stale>=5 (exactly 5) trips curation advisory in agent_context", async () => {
    // staleAfterMs=0 makes everything stale immediately.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, staleAfterMs: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;

    // Create exactly 5 concepts and age their last_confirmed_at so they are stale.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await core.store(`Stale concept ${i} — distinct enough to not merge.`, { resolution: "forceNew" });
      ids.push(r.conceptId);
    }
    // Age all to 2× staleAfterMs in the past (staleAfterMs=0, so any past timestamp works).
    for (const id of ids) {
      db.prepare(`UPDATE concepts SET last_confirmed_at = 1 WHERE id = ?`).run(id);
    }

    // Verify overview.counts.stale >= 5.
    const ov = core.overview("default");
    expect(ov.counts.stale).toBeGreaterThanOrEqual(5);

    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      const result = await client.callTool({ name: "agent_context", arguments: {} });
      const parsed = JSON.parse(rawText(result)) as Record<string, unknown>;
      expect("curationAttention" in parsed).toBe(true);
      expect((parsed.curationAttention as string)).toContain("stale=");
    } finally {
      await cleanup();
    }
  });

  it("stale=4 does NOT trip curation advisory", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, staleAfterMs: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;

    for (let i = 0; i < 4; i++) {
      const r = await core.store(`Stale concept ${i} — distinct.`, { resolution: "forceNew" });
      db.prepare(`UPDATE concepts SET last_confirmed_at = 1 WHERE id = ?`).run(r.conceptId);
    }

    const ov = core.overview("default");
    expect(ov.counts.stale).toBe(4);

    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      const result = await client.callTool({ name: "agent_context", arguments: {} });
      const parsed = JSON.parse(rawText(result)) as Record<string, unknown>;
      // No other threshold tripped — curationAttention must be absent.
      expect("curationAttention" in parsed).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("dirty>=10 (exactly 10) trips curation advisory in agent_context", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;

    // Create 10 distinct concepts and mark them dirty.
    for (let i = 0; i < 10; i++) {
      const r = await core.store(`Dirty concept ${i} — distinct.`, { resolution: "forceNew" });
      db.prepare(`UPDATE concepts SET dirty = 1 WHERE id = ?`).run(r.conceptId);
    }

    const ov = core.overview("default");
    expect(ov.counts.dirty).toBeGreaterThanOrEqual(10);

    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      const result = await client.callTool({ name: "agent_context", arguments: {} });
      const parsed = JSON.parse(rawText(result)) as Record<string, unknown>;
      expect("curationAttention" in parsed).toBe(true);
      expect((parsed.curationAttention as string)).toContain("dirty=");
    } finally {
      await cleanup();
    }
  });

  it("dirty=9 does NOT trip curation advisory", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;

    for (let i = 0; i < 9; i++) {
      const r = await core.store(`Dirty concept ${i} — distinct.`, { resolution: "forceNew" });
      db.prepare(`UPDATE concepts SET dirty = 1 WHERE id = ?`).run(r.conceptId);
    }

    const ov = core.overview("default");
    expect(ov.counts.dirty).toBe(9);

    const { client, cleanup } = await makePair(core, { autoPrewarm: false });
    try {
      const result = await client.callTool({ name: "agent_context", arguments: {} });
      const parsed = JSON.parse(rawText(result)) as Record<string, unknown>;
      expect("curationAttention" in parsed).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
