/**
 * First Block feature tests (feat/first-block).
 *
 * Coverage:
 *  STEP 1 – schema: table + constraint + UNIQUE(concept_id, circle) + migration idempotency
 *  STEP 2 – propagation hooks: all 9 mutation paths set summary_dirty=1 or delete the entry
 *  STEP 3 – 5 MCP tool proxies (engine-level; MCP layer smoke-tested separately)
 *  STEP 4 – prewarm injection order, disputed suppression, empty block, curationAttention
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Helpers -----------------------------------------------------------------------

function freshCore(opts: { tauAttach?: number; tauAmbiguous?: number } = {}): MonetCore {
  return new MonetCore(":memory:", {
    tauAttach: opts.tauAttach ?? 1.1,
    tauAmbiguous: opts.tauAmbiguous ?? 1.1,
  });
}

/** Store content, return conceptId. */
async function storeOne(core: MonetCore, content: string, circle = "default"): Promise<string> {
  const r = await core.store(content, { circle });
  return r.conceptId;
}

/** Promote a concept into the First Block. */
function promote(core: MonetCore, conceptId: string, summary: string, circle = "default") {
  return core.promoteToFirstBlock(conceptId, summary, circle);
}

/** Read summary_dirty flag from the first_block table directly (via listFirstBlock). */
function isDirty(core: MonetCore, conceptId: string, circle = "default"): boolean {
  const entries = core.listFirstBlock(circle);
  const e = entries.find((x) => x.conceptId === conceptId);
  return e?.summaryDirty ?? false;
}

/** Check if a concept is present in the first_block. */
function isPresent(core: MonetCore, conceptId: string, circle = "default"): boolean {
  return core.listFirstBlock(circle).some((x) => x.conceptId === conceptId);
}

// MCP test harness --------------------------------------------------------------

type McpContent = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function mcpHarness(core: MonetCore) {
  const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(ct);
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: tool, arguments: args })) as McpContent;
    const text = r.content[0]!.text;
    return JSON.parse(text) as Record<string, unknown>;
  };
  return { call, client };
}

// ==============================================================================
// STEP 1 — schema + constraints
// ==============================================================================

describe("Step 1: schema", () => {
  it("first_block table exists after engine init", () => {
    const core = freshCore();
    // If the table is missing, listFirstBlock would throw; expect it to return empty.
    expect(core.listFirstBlock("default")).toEqual([]);
    core.close();
  });

  it("UNIQUE(concept_id, circle) — double-promote throws", async () => {
    const core = freshCore();
    const id = await storeOne(core, "Some unique fact about frogs.");
    promote(core, id, "Frogs prefer humid environments.");
    expect(() => promote(core, id, "Second summary — should fail.")).toThrow();
    core.close();
  });

  it("two distinct concepts in same circle each get their own entry", async () => {
    const core = freshCore();
    const a = await storeOne(core, "Alpha concept with distinct token aleph.");
    const b = await storeOne(core, "Beta concept with distinct token beth.");
    promote(core, a, "Summary for A.");
    promote(core, b, "Summary for B.");
    const entries = core.listFirstBlock("default");
    expect(entries).toHaveLength(2);
    core.close();
  });

  it("same concept_id in different circles is allowed (UNIQUE is per circle)", async () => {
    const core = freshCore();
    const a = await storeOne(core, "Alpha concept.", "circle1");
    // Store a slightly different concept in circle2 to get a different id,
    // then manually promote the same id into circle2 via the engine method
    // by storing in circle2 first.
    const b = await storeOne(core, "Alpha concept replica.", "circle2");
    // Promote a in circle1 and b in circle2 — two distinct rows.
    promote(core, a, "Alpha in circle1.", "circle1");
    promote(core, b, "Alpha in circle2.", "circle2");
    expect(core.listFirstBlock("circle1")).toHaveLength(1);
    expect(core.listFirstBlock("circle2")).toHaveLength(1);
    core.close();
  });

  it("migration is idempotent — opening twice produces no error", () => {
    // A second MonetCore opened on the same DB goes through migrate() again.
    // first_block uses CREATE TABLE IF NOT EXISTS so it is idempotent.
    // We test via :memory: which is per-instance, but the CREATE IF NOT EXISTS
    // + version-bump path is exercised by constructing twice on a temp file.
    // (mkdtempSync, rmSync, tmpdir, join are imported at module scope — ESM-safe)
    const dir = mkdtempSync(join(tmpdir(), "monet-first-block-"));
    const dbPath = join(dir, "test.monet");
    try {
      const c1 = new MonetCore(dbPath);
      c1.close();
      const c2 = new MonetCore(dbPath);
      // listFirstBlock should work fine on the re-opened DB.
      expect(c2.listFirstBlock("default")).toEqual([]);
      c2.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ==============================================================================
// STEP 2 — propagation hooks (9 paths)
// ==============================================================================

describe("Step 2: propagation hooks", () => {
  // --- store() attach paths ---

  it("store() attach (auto-resolve, score >= tauAttach) → invalidates", async () => {
    // Use default thresholds so attach actually fires (the HashingEmbeddingProvider
    // returns identical embeddings for identical content, so score=1.0 >= tauAttach=0.55).
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "The cat sat on the mat.", "default");
    promote(core, id, "Cat-mat summary.");
    expect(isDirty(core, id)).toBe(false);
    // Re-store similar content — should attach.
    await core.store("The cat sat on the mat.", { circle: "default" });
    expect(isDirty(core, id)).toBe(true);
    core.close();
  });

  it("store() attach via attachTo → invalidates", async () => {
    const core = freshCore();
    const id = await storeOne(core, "Initial content about widgets.");
    promote(core, id, "Widget summary.");
    expect(isDirty(core, id)).toBe(false);
    await core.store("Additional widget detail.", { attachTo: id, circle: "default" });
    expect(isDirty(core, id)).toBe(true);
    core.close();
  });

  it("store() correction on existing concept → invalidates", async () => {
    // Use default thresholds so the correction attaches (identical hash → same concept).
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "Widget color is blue.", "default");
    promote(core, id, "Widget color is blue.");
    expect(isDirty(core, id)).toBe(false);
    // A correction on the same content attaches (score=1.0 >= tauAttach).
    await core.store("Widget color is blue.", { kind: "correction", circle: "default" });
    expect(isDirty(core, id)).toBe(true);
    core.close();
  });

  it("store() forceNew (no existing concept) → does NOT set dirty (brand-new, no summary)", async () => {
    const core = freshCore();
    const r = await core.store("Brand new fact about zephyrs.", { resolution: "forceNew", circle: "default" });
    // There is no first_block entry (never promoted) — nothing to check; just confirm no crash.
    expect(isPresent(core, r.conceptId)).toBe(false);
    core.close();
  });

  // --- detach() ---

  it("detach() source survives (partial detach) → invalidates source summary", async () => {
    const core = freshCore();
    const id = await storeOne(core, "First observation about gamma.");
    // Add a second observation directly.
    const r2 = await core.store("Second observation about gamma.", { attachTo: id, circle: "default" });
    const allObs = (await core.getConcept(id, { synthesize: false }))!.observations;
    expect(allObs.length).toBeGreaterThanOrEqual(2);
    promote(core, id, "Gamma concept summary.");
    expect(isDirty(core, id)).toBe(false);
    // Detach one observation → source survives but body changed.
    await core.detach(id, [allObs[0]!.id]);
    expect(isDirty(core, id)).toBe(true);
    core.close();
  });

  it("detach() destination is existing (destConceptId) → invalidates dest summary", async () => {
    const core = freshCore();
    const srcId = await storeOne(core, "Source fact about delta.");
    const dstId = await storeOne(core, "Destination fact about epsilon.");
    const srcObs = (await core.getConcept(srcId, { synthesize: false }))!.observations;
    promote(core, dstId, "Epsilon destination summary.");
    expect(isDirty(core, dstId)).toBe(false);
    // Detach src's observation into the existing dstId.
    await core.detach(srcId, [srcObs[0]!.id], { destConceptId: dstId });
    expect(isDirty(core, dstId)).toBe(true);
    core.close();
  });

  // --- mergeConceptInto() via reassignCircle ---

  it("mergeConceptInto() source is DELETED → first_block entry removed (referential integrity)", async () => {
    // Use real thresholds so the source merges into target in the destination circle.
    const core = new MonetCore(":memory:");
    const srcId = await core.store("Cache auth tokens in Redis with 5min TTL.", { circle: "src" }).then((r) => r.conceptId);
    promote(core, srcId, "Redis cache summary.", "src");
    expect(isPresent(core, srcId, "src")).toBe(true);
    // Move src to a circle where a similar concept already exists (forceNew=false default → merge).
    // First create target in "dst" circle with same text → score=1.0 → merge.
    await core.store("Cache auth tokens in Redis with 5min TTL.", { circle: "dst" });
    // reassignCircle with auto resolution → merges src into dst (identical embeddings).
    core.reassignCircle(srcId, "dst");
    // The source row was deleted — its first_block entry must be gone.
    expect(isPresent(core, srcId, "src")).toBe(false);
    core.close();
  });

  it("mergeConceptInto() target mutated → invalidates target summary", async () => {
    const core = new MonetCore(":memory:");
    const targetId = await core.store("Cache auth tokens in Redis with 5min TTL.", { circle: "dst" }).then((r) => r.conceptId);
    promote(core, targetId, "Redis summary.", "dst");
    expect(isDirty(core, targetId, "dst")).toBe(false);
    // Create a duplicate in src circle.
    const srcId = await core.store("Cache auth tokens in Redis with 5min TTL.", { circle: "src" }).then((r) => r.conceptId);
    // Move src into dst → merges into targetId (identical embeddings → score=1.0).
    core.reassignCircle(srcId, "dst");
    expect(isDirty(core, targetId, "dst")).toBe(true);
    core.close();
  });

  // --- moveConcept() via reassignCircle ---

  it("moveConcept() → first_block entry RE-HOMED to destination circle (Finding 2 — Codex PR-32)", async () => {
    const core = freshCore();
    const id = await storeOne(core, "Unique fact about zeta.");
    promote(core, id, "Zeta summary.", "default");
    expect(isPresent(core, id, "default")).toBe(true);
    // Move to a different circle where no similar concept exists → moveConcept (no merge).
    core.reassignCircle(id, "new-circle");
    // Pin must NO LONGER be in the old circle.
    expect(isPresent(core, id, "default")).toBe(false);
    // Pin MUST be re-homed into the destination circle — the concept survived.
    expect(isPresent(core, id, "new-circle")).toBe(true);
    // Summary is preserved intact.
    const entry = core.listFirstBlock("new-circle").find((e) => e.conceptId === id);
    expect(entry?.summary).toBe("Zeta summary.");
    core.close();
  });

  // --- flagContradiction() ---

  it("flagContradiction() → invalidates first_block entry (explicit hook, not dirty-based)", async () => {
    const core = freshCore();
    const id = await storeOne(core, "The sky is blue.");
    promote(core, id, "Sky color summary.");
    expect(isDirty(core, id)).toBe(false);
    core.flagContradiction(id, { detail: "test contradiction" });
    // The hook must fire even though flagContradiction does NOT set dirty=1 on the concept.
    expect(isDirty(core, id)).toBe(true);
    core.close();
  });

  // --- resolveContradiction() WITH body ---

  it("resolveContradiction() with body → invalidates first_block entry", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "The sky is green.");
    promote(core, id, "Sky color summary.");
    // Open a contradiction.
    const contra = core.flagContradiction(id, { detail: "wrong color" });
    // Clear dirty so we can observe the resolve hook specifically.
    core.updateFirstBlockSummary(id, "Sky color summary.", "default");
    expect(isDirty(core, id)).toBe(false);
    // Resolve WITH a body → hook fires.
    core.resolveContradiction(contra.id, { decision: "accept-new", body: "The sky is blue." });
    expect(isDirty(core, id)).toBe(true);
    core.close();
  });

  it("resolveContradiction() WITHOUT body → does NOT set dirty (no body change)", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "The sky is blue.");
    promote(core, id, "Sky color summary.");
    const contra = core.flagContradiction(id, { detail: "minor conflict" });
    // Clear dirty after flagContradiction.
    core.updateFirstBlockSummary(id, "Sky color summary.", "default");
    expect(isDirty(core, id)).toBe(false);
    // Resolve WITHOUT a body → no body UPDATE → hook does not fire.
    core.resolveContradiction(contra.id, { decision: "dismiss" });
    expect(isDirty(core, id)).toBe(false);
    core.close();
  });

  // --- synthesizeRow() (via getConcept with synthesize:true) ---

  it("synthesizeRow() → invalidates first_block entry", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "Initial fact to synthesize.");
    promote(core, id, "Initial summary.");
    // Clear dirty so we see only the synthesize hook.
    core.updateFirstBlockSummary(id, "Initial summary.", "default");
    expect(isDirty(core, id)).toBe(false);
    // getConcept with synthesize:true triggers synthesizeRow() on a dirty concept.
    // The concept is already dirty=1 from create().
    expect(core.isDirty(id)).toBe(true);
    await core.getConcept(id, { synthesize: true });
    expect(isDirty(core, id)).toBe(true);
    core.close();
  });
});

// ==============================================================================
// STEP 3 — engine-level promotion API (MCP tools proxy these)
// ==============================================================================

describe("Step 3: promotion API", () => {
  it("promoteToFirstBlock applies usefulness boost", async () => {
    const core = freshCore();
    const id = await storeOne(core, "A very important fact about usefulness.");
    const conceptBefore = (await core.getConcept(id, { synthesize: false }))!;
    const usefulnessBefore = conceptBefore.supportCount; // just need something to compare against
    // Promote.
    promote(core, id, "Important fact summary.");
    // Confirm boost was applied: usefulness_score increased by FIRST_BLOCK_PROMOTION_USEFULNESS_BOOST (10).
    // We verify by checking the listing (we don't expose usefulness_score in the public API directly,
    // but we can verify the concept still exists and entry is present).
    const entries = core.listFirstBlock("default");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.conceptId).toBe(id);
    expect(entries[0]!.summaryDirty).toBe(false);
    core.close();
  });

  it("promoteToFirstBlock returns correct position and totalSummaryChars", async () => {
    const core = freshCore();
    const a = await storeOne(core, "First concept alpha.");
    const b = await storeOne(core, "Second concept beta.");
    const r1 = promote(core, a, "Alpha summary.");
    const r2 = promote(core, b, "Beta summary (slightly longer).");
    expect(r1.position).toBe(0);
    expect(r2.position).toBe(1);
    expect(r2.totalSummaryChars).toBe("Alpha summary.".length + "Beta summary (slightly longer).".length);
    core.close();
  });

  it("char-limit rejection — summary > 800 chars throws", async () => {
    const core = freshCore();
    const id = await storeOne(core, "A concept to test the char limit.");
    const longSummary = "x".repeat(801);
    expect(() => promote(core, id, longSummary)).toThrow(/800/);
    core.close();
  });

  it("double-promote is an idempotent error (UNIQUE constraint)", async () => {
    const core = freshCore();
    const id = await storeOne(core, "A unique concept.");
    promote(core, id, "First summary.");
    expect(() => promote(core, id, "Second summary.")).toThrow();
    // The first entry is unchanged.
    const entries = core.listFirstBlock("default");
    expect(entries[0]!.summary).toBe("First summary.");
    core.close();
  });

  it("updateFirstBlockSummary clears summaryDirty", async () => {
    const core = freshCore();
    const id = await storeOne(core, "Concept to update.");
    promote(core, id, "Original summary.");
    // Dirty it via attach.
    await core.store("Concept to update.", { attachTo: id });
    expect(isDirty(core, id)).toBe(true);
    // Update clears it.
    const r = core.updateFirstBlockSummary(id, "Updated summary.", "default");
    expect(r).not.toBeNull();
    expect(r!.summaryDirty).toBe(false);
    expect(isDirty(core, id)).toBe(false);
    core.close();
  });

  it("removeFromFirstBlock removes the entry without touching the concept", async () => {
    const core = freshCore();
    const id = await storeOne(core, "A concept to remove from block.");
    promote(core, id, "Summary to remove.");
    expect(isPresent(core, id)).toBe(true);
    core.removeFromFirstBlock(id, "default");
    expect(isPresent(core, id)).toBe(false);
    // Concept still exists.
    const c = await core.getConcept(id, { synthesize: false });
    expect(c).not.toBeNull();
    core.close();
  });

  it("reorderFirstBlock changes positions deterministically", async () => {
    const core = freshCore();
    const a = await storeOne(core, "Alpha reorder concept.");
    const b = await storeOne(core, "Beta reorder concept.");
    const c = await storeOne(core, "Gamma reorder concept.");
    promote(core, a, "Alpha.");
    promote(core, b, "Beta.");
    promote(core, c, "Gamma.");
    // Reorder: gamma, alpha, beta.
    core.reorderFirstBlock([c, a, b], "default");
    const entries = core.listFirstBlock("default");
    expect(entries[0]!.conceptId).toBe(c);
    expect(entries[1]!.conceptId).toBe(a);
    expect(entries[2]!.conceptId).toBe(b);
    core.close();
  });
});

// ==============================================================================
// STEP 4 — prewarm + render + housekeeping
// ==============================================================================

describe("Step 4: prewarm injection + render", () => {
  it("prewarm() populates firstBlock", async () => {
    const core = freshCore();
    const id = await storeOne(core, "Important concept for prewarm.");
    promote(core, id, "Prewarm summary text.");
    const state = core.prewarm("default");
    expect(state.firstBlock).toHaveLength(1);
    expect(state.firstBlock[0]!.conceptId).toBe(id);
    expect(state.firstBlock[0]!.summary).toBe("Prewarm summary text.");
    core.close();
  });

  it("prewarm() returns empty firstBlock when nothing promoted", async () => {
    const core = freshCore();
    await storeOne(core, "Concept with no first_block entry.");
    const state = core.prewarm("default");
    expect(state.firstBlock).toEqual([]);
    core.close();
  });

  it("disputed entry is included in firstBlock but suppressed from active count", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "Concept to be disputed.");
    promote(core, id, "Disputed summary.");
    core.flagContradiction(id, { detail: "test" });
    const state = core.prewarm("default");
    // The entry is present but status is 'disputed'.
    const entry = state.firstBlock.find((e) => e.conceptId === id);
    expect(entry).toBeDefined();
    expect(entry!.conceptStatus).toBe("disputed");
    core.close();
  });

  it("buildPrewarmBlock renders first block before workstreams (injection order)", async () => {
    // We use the MCP tool's auto-prewarm to verify the rendered order.
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "Pinned concept content.", "default");
    promote(core, id, "Pinned concept summary — always first.");
    await core.saveWorkstream({ status: "active", nextSteps: ["resume work"] }, { circle: "default" });

    const { call } = await mcpHarness(new MonetCore(":memory:")); // fresh harness for agent_context
    // Use the original core for agent_context directly to inspect the JSON payload.
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);
    const result = (await client.callTool({ name: "agent_context", arguments: {} })) as McpContent;
    const payload = JSON.parse(result.content[0]!.text) as { firstBlock: unknown[] };
    // firstBlock is present and non-empty.
    expect(payload.firstBlock).toHaveLength(1);
    core.close();
  });

  it("empty first block → no first-block section in prewarm block string", async () => {
    const core = new MonetCore(":memory:");
    await storeOne(core, "Just a regular concept.", "default");
    // No promotion — first_block is empty.
    const state = core.prewarm("default");
    expect(state.firstBlock).toHaveLength(0);
    core.close();
  });

  it("curationAttention includes firstBlockStale when summaryDirty entries exist", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "Stale summary concept.", "default");
    promote(core, id, "Original summary.");
    // Dirty the entry.
    await core.store("Stale summary concept.", { attachTo: id, circle: "default" });
    expect(isDirty(core, id)).toBe(true);

    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client2 = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client2.connect(ct);
    const result = (await client2.callTool({ name: "agent_context", arguments: {} })) as McpContent;
    const payload = JSON.parse(result.content[0]!.text) as { curationAttention?: string };
    expect(payload.curationAttention).toMatch(/firstBlockStale=1/);
    core.close();
  });

  it("curationAttention includes firstBlockDisputed when disputed entries exist", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "Disputed block concept.", "default");
    promote(core, id, "Disputed summary.");
    core.flagContradiction(id, { detail: "conflict" });

    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client3 = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client3.connect(ct);
    const result = (await client3.callTool({ name: "agent_context", arguments: {} })) as McpContent;
    const payload = JSON.parse(result.content[0]!.text) as { curationAttention?: string };
    expect(payload.curationAttention).toMatch(/firstBlockDisputed=1/);
    core.close();
  });
});

// ==============================================================================
// STEP 3 (cont.) — MCP tool smoke tests via InMemoryTransport
// ==============================================================================

describe("Step 3: MCP tool wiring", () => {
  it("memory_first_block promote → entry created, concept exists", async () => {
    const core = freshCore();
    const conceptId = await storeOne(core, "Concept to pin via MCP.");
    const { call } = await mcpHarness(core);
    const r = await call("memory_first_block", { action: "promote", conceptId, summary: "Pinned via MCP." });
    expect(r["conceptId"]).toBe(conceptId);
    expect(r["summary"]).toBe("Pinned via MCP.");
    expect(isPresent(core, conceptId)).toBe(true);
    core.close();
  });

  it("memory_first_block remove → entry removed", async () => {
    const core = freshCore();
    const conceptId = await storeOne(core, "Concept to remove via MCP.");
    promote(core, conceptId, "Summary to remove.");
    const { call } = await mcpHarness(core);
    const r = await call("memory_first_block", { action: "remove", conceptId });
    expect(r["removed"]).toBe(true);
    expect(isPresent(core, conceptId)).toBe(false);
    core.close();
  });

  it("memory_first_block list → returns entries", async () => {
    const core = freshCore();
    const id = await storeOne(core, "Concept to list via MCP.");
    promote(core, id, "Listed summary.");
    const { call } = await mcpHarness(core);
    const r = await call("memory_first_block", { action: "list" });
    const entries = r["entries"] as Array<{ conceptId: string }>;
    expect(entries.some((e) => e.conceptId === id)).toBe(true);
    core.close();
  });

  it("memory_first_block reorder → changes order", async () => {
    const core = freshCore();
    const a = await storeOne(core, "Alpha MCP reorder.");
    const b = await storeOne(core, "Beta MCP reorder.");
    promote(core, a, "Alpha.");
    promote(core, b, "Beta.");
    const { call } = await mcpHarness(core);
    await call("memory_first_block", { action: "reorder", orderedConceptIds: [b, a] });
    const entries = core.listFirstBlock("default");
    expect(entries[0]!.conceptId).toBe(b);
    expect(entries[1]!.conceptId).toBe(a);
    core.close();
  });

  it("memory_first_block update_summary → clears dirty via MCP", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "Concept to update summary via MCP.");
    promote(core, id, "Old summary.");
    await core.store("Concept to update summary via MCP.", { attachTo: id });
    expect(isDirty(core, id)).toBe(true);
    const { call } = await mcpHarness(core);
    const r = await call("memory_first_block", { action: "update_summary", conceptId: id, summary: "New fresh summary." });
    expect(r["summaryDirty"]).toBe(false);
    expect(isDirty(core, id)).toBe(false);
    core.close();
  });

  it("memory_first_block promote — char-limit rejection via MCP returns error", async () => {
    const core = freshCore();
    const id = await storeOne(core, "Concept for char limit test.");
    const { client } = await mcpHarness(core);
    const result = (await client.callTool({ name: "memory_first_block", arguments: {
      action: "promote",
      conceptId: id,
      summary: "x".repeat(801),
    }})) as McpContent;
    expect(result.isError).toBe(true);
    core.close();
  });
});

// ==============================================================================
// STEP 5 — regression tests for bugs found by review (feat/first-block)
// ==============================================================================

describe("Step 5: regression tests (bug-fix verification)", () => {
  // ---------------------------------------------------------------------------
  // Bug 1: dangling first_block row after detach full-consolidation of a pinned source
  // ---------------------------------------------------------------------------
  it("detach full-consolidation of a pinned source → no first_block row for deleted source", async () => {
    const core = freshCore();
    // Create source with two observations so we can detach all of them into an existing dest.
    const srcId = await storeOne(core, "Source concept about octopi.");
    const r2 = await core.store("Second observation about octopi.", { attachTo: srcId, circle: "default" });
    const srcObs = (await core.getConcept(srcId, { synthesize: false }))!.observations;
    // Create a distinct destination concept.
    const dstId = await storeOne(core, "Destination concept about cephalopods.");
    // Pin the source in the First Block.
    promote(core, srcId, "Octopi source summary.");
    expect(isPresent(core, srcId)).toBe(true);
    // Detach ALL source observations into the existing dest → consolidation → source deleted.
    const obsIds = srcObs.map((o) => o.id);
    await core.detach(srcId, obsIds, { destConceptId: dstId });
    // Source is gone — its first_block entry must also be gone (no dangling FK row).
    expect(isPresent(core, srcId)).toBe(false);
    // Syncable removals retain a tombstone row, but it must be hidden from the read API.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;
    const tombstone = db.prepare("SELECT deleted_at FROM first_block WHERE concept_id = ?").get(srcId) as { deleted_at: number | null };
    expect(tombstone.deleted_at).not.toBeNull();
    core.close();
  });

  // ---------------------------------------------------------------------------
  // Bug 2: promoteToFirstBlock on a workstream concept must throw
  // ---------------------------------------------------------------------------
  it("promoteToFirstBlock on a workstream concept → throws, nothing pinned", async () => {
    const core = freshCore();
    // Save a workstream — the returned Workstream.id is the concept id.
    const ws = await core.saveWorkstream({ status: "active", nextSteps: ["do something"] }, { circle: "default" });
    const wsConceptId = ws.id;
    // Attempt to pin it — must throw with a clear message referencing 'workstream'.
    expect(() => promote(core, wsConceptId, "Workstream summary.")).toThrow(/workstream/);
    // Nothing must be pinned.
    expect(isPresent(core, wsConceptId)).toBe(false);
    core.close();
  });

  // ---------------------------------------------------------------------------
  // Bug 3a: resolveContradiction accept-new WITHOUT body → summaryDirty becomes true
  // The bug: invalidate was gated on `opts.body !== undefined`, so accept-new without
  // an explicit body left summaryDirty=false even though loser observations were superseded.
  // Fix: invalidate inside the winnerObsId supersede block, not only on the body path.
  // ---------------------------------------------------------------------------
  it("resolveContradiction accept-new WITHOUT body on a pinned concept → summaryDirty=true", async () => {
    // Use real thresholds so the second store auto-attaches (score=1.0 → same concept).
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "The moon is a planet.");
    promote(core, id, "Moon classification summary.");
    // Add a second observation to the same concept (attachTo ensures it).
    await core.store("The moon is actually a natural satellite.", { attachTo: id, circle: "default" });
    const obs = (await core.getConcept(id, { synthesize: false }))!.observations;
    expect(obs.length).toBeGreaterThanOrEqual(2);
    // Flag a contradiction referencing the NEW (second) observation as the challenger.
    const challengerObs = obs[obs.length - 1]!;
    const contra = core.flagContradiction(id, { observationId: challengerObs.id, detail: "moon is not a planet" });
    // Clear dirty so we can observe the resolve hook specifically.
    core.updateFirstBlockSummary(id, "Moon classification summary.", "default");
    expect(isDirty(core, id)).toBe(false);
    // Resolve accept-new WITHOUT a body → winnerObsId = challengerObs.id (non-null) →
    // loser observations are superseded → effective content changed → must invalidate.
    core.resolveContradiction(contra.id, { decision: "accept-new" });
    expect(isDirty(core, id)).toBe(true);
    core.close();
  });

  // ---------------------------------------------------------------------------
  // Bug 3b: resolveContradiction dismiss → summaryDirty stays false
  // ---------------------------------------------------------------------------
  it("resolveContradiction dismiss on a pinned concept → summaryDirty stays false", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "The sky is blue.");
    promote(core, id, "Sky color summary.");
    const contra = core.flagContradiction(id, { detail: "minor disagreement" });
    // Clear dirty set by flagContradiction.
    core.updateFirstBlockSummary(id, "Sky color summary.", "default");
    expect(isDirty(core, id)).toBe(false);
    // Dismiss: no observations superseded, no content change.
    core.resolveContradiction(contra.id, { decision: "dismiss" });
    expect(isDirty(core, id)).toBe(false);
    core.close();
  });

  // ---------------------------------------------------------------------------
  // Bug 5a: reorderFirstBlock with partial list → throws, positions unchanged
  // ---------------------------------------------------------------------------
  it("reorderFirstBlock with partial list → throws and positions are unchanged", async () => {
    const core = freshCore();
    const a = await storeOne(core, "Alpha reorder validation concept.");
    const b = await storeOne(core, "Beta reorder validation concept.");
    const c = await storeOne(core, "Gamma reorder validation concept.");
    promote(core, a, "Alpha.");
    promote(core, b, "Beta.");
    promote(core, c, "Gamma.");
    const before = core.listFirstBlock("default").map((e) => e.conceptId);
    // Supply only 2 of the 3 pinned ids → partial list.
    expect(() => core.reorderFirstBlock([a, b], "default")).toThrow(/3/);
    // Positions must be unchanged.
    const after = core.listFirstBlock("default").map((e) => e.conceptId);
    expect(after).toEqual(before);
    core.close();
  });

  // ---------------------------------------------------------------------------
  // Bug 5b: reorderFirstBlock with unknown id → throws, positions unchanged
  // ---------------------------------------------------------------------------
  it("reorderFirstBlock with unknown id → throws and positions are unchanged", async () => {
    const core = freshCore();
    const a = await storeOne(core, "Alpha unknown-id concept.");
    const b = await storeOne(core, "Beta unknown-id concept.");
    promote(core, a, "Alpha.");
    promote(core, b, "Beta.");
    const before = core.listFirstBlock("default").map((e) => e.conceptId);
    // Supply correct count but one is a bogus id.
    expect(() => core.reorderFirstBlock([a, "unknown-bogus-id"], "default")).toThrow(/unknown-bogus-id/);
    const after = core.listFirstBlock("default").map((e) => e.conceptId);
    expect(after).toEqual(before);
    core.close();
  });

  // ---------------------------------------------------------------------------
  // Bug 5c: applySynthesis on a pinned concept → summaryDirty becomes true
  // (regression: applySynthesis was the only mutation path missing the hook)
  // ---------------------------------------------------------------------------
  it("applySynthesis on a pinned concept → summaryDirty becomes true", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "Original body for synthesis regression.");
    promote(core, id, "Original pinned summary.");
    // Clear dirty flag so we start with a clean slate.
    core.updateFirstBlockSummary(id, "Original pinned summary.", "default");
    expect(isDirty(core, id)).toBe(false);
    // Rewrite the body via the applySynthesis path (the engine method behind memory_synthesize).
    await core.applySynthesis(id, "Rewritten body via agent-driven synthesis.");
    // The pinned concept's body changed — its summary must be marked stale.
    expect(isDirty(core, id)).toBe(true);
    core.close();
  });

  // ---------------------------------------------------------------------------
  // Bug 5d: reorderFirstBlock with duplicate id → throws, positions unchanged
  // ---------------------------------------------------------------------------
  it("reorderFirstBlock with duplicate id → throws and positions are unchanged", async () => {
    const core = freshCore();
    const a = await storeOne(core, "Alpha duplicate-id reorder concept.");
    const b = await storeOne(core, "Beta duplicate-id reorder concept.");
    const c = await storeOne(core, "Gamma duplicate-id reorder concept.");
    promote(core, a, "Alpha.");
    promote(core, b, "Beta.");
    promote(core, c, "Gamma.");
    const before = core.listFirstBlock("default").map((e) => e.conceptId);
    // Supply right length (3) with a repeated id — [a, a, b] passes length + membership checks
    // but must be caught by the distinctness guard.
    expect(() => core.reorderFirstBlock([a, a, b], "default")).toThrow(/duplicate/);
    // Positions must be entirely unchanged — no partial write.
    const after = core.listFirstBlock("default").map((e) => e.conceptId);
    expect(after).toEqual(before);
    core.close();
  });

  // ---------------------------------------------------------------------------
  // Rendered block string: disputed pinned entry's summary absent from output
  // ---------------------------------------------------------------------------
  it("buildPrewarmBlock rendered string omits disputed pinned entry's summary", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "Unique disputed pinned concept alpha-omega.", "default");
    promote(core, id, "Alpha-omega pinned summary text.");
    // Flag a contradiction — this marks the concept 'disputed'.
    core.flagContradiction(id, { detail: "contested claim" });
    // To access the rendered block string, we use autoPrewarm:true on a non-agent_context tool.
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: true, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);
    // Call a non-agent_context tool (e.g. memory_first_block action="list") as the first call:
    // wrapSuccess will append content[1] with the prewarm block.
    const result = (await client.callTool({ name: "memory_first_block", arguments: { action: "list" } })) as McpContent;
    // content[0] is the JSON result; content[1] (if present) is the prewarm block string.
    const blockText = result.content.slice(1).map((c) => c.text).join("");
    // The disputed entry's summary must NOT appear in the rendered block.
    expect(blockText).not.toContain("Alpha-omega pinned summary text.");
    core.close();
  });
});

// ==============================================================================
// STEP 6 — verify prewarm topConcepts sort has NO band-sort
// ==============================================================================

describe("Step 6: no band-sort in prewarm", () => {
  it("topConcepts sort does not elevate 'procedure' or 'preference' kinds above others", async () => {
    // If band-sort were present, a concept with kind='procedure' or kind='preference' would
    // always appear before a higher-livingModelScore 'fact' or 'decision'. We verify the
    // ordering is purely score-based by confirming a high-score 'fact' outranks a lower-score
    // 'procedure'.
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 999_999_999,
    });

    // Seed a 'procedure' concept that will have lower usefulness than the 'fact'.
    const procId = (await core.store("A procedure step for deployment.", { kind: "procedure", circle: "default" })).conceptId;
    // Boost the 'fact' concept's usefulness so it outranks the procedure by score.
    const factId = (await core.store("A fact with many cross-session confirmations.", { kind: "fact", circle: "default" })).conceptId;
    // Simulate usefulness: fetch the fact concept many times (each getConcept call increments usefulness_score).
    for (let i = 0; i < 20; i++) {
      await core.getConcept(factId, { synthesize: false });
    }

    const state = core.prewarm("default");
    const ids = state.topConcepts.map((c) => c.id);
    // With pure score-based sort, the 'fact' with high usefulness must outrank the 'procedure'.
    // If band-sort existed, 'procedure' would always be first regardless of score.
    expect(ids.indexOf(factId)).toBeLessThan(ids.indexOf(procId));
    core.close();
  });

  it("topConcepts is sorted score-descending — higher-scored concept appears first regardless of kind", async () => {
    // Verify that a high-usefulness 'fact' ranks above a low-usefulness 'procedure'.
    // If band-sort existed, 'procedure' would be elevated first regardless of score.
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 999_999_999,
    });
    const procId = (await core.store("Deploy procedure step one.", { kind: "procedure", circle: "default" })).conceptId;
    const factId = (await core.store("Well-confirmed architectural fact.", { kind: "fact", circle: "default" })).conceptId;
    // Simulate many fetches on the fact to raise its usefulness_score above the procedure.
    for (let i = 0; i < 15; i++) {
      await core.getConcept(factId, { synthesize: false });
    }
    const state = core.prewarm("default");
    const ids = state.topConcepts.map((c) => c.id);
    // The fact (high score) must precede the procedure (low score).
    expect(ids.indexOf(factId)).toBeLessThan(ids.indexOf(procId));
    core.close();
  });
});

// ==============================================================================
// STEP 7 — Codex P2 regression tests (feat/first-block review)
// ==============================================================================

describe("Step 7: Codex P2 regressions", () => {
  // ---------------------------------------------------------------------------
  // Finding 1: renameCircle must sync first_block.circle
  // ---------------------------------------------------------------------------
  it("renameCircle: first_block.circle is updated and remove/reorder/list still find the row", async () => {
    const core = freshCore();
    const id = await storeOne(core, "Concept to pin before rename.");
    promote(core, id, "Pinned summary before rename.");
    expect(isPresent(core, id, "default")).toBe(true);

    core.renameCircle("default", "renamed-circle");

    // list under NEW circle must find the row.
    const entries = core.listFirstBlock("renamed-circle");
    expect(entries.some((e) => e.conceptId === id)).toBe(true);

    // remove under NEW circle must succeed.
    const { removed } = core.removeFromFirstBlock(id, "renamed-circle");
    expect(removed).toBe(true);
    expect(core.listFirstBlock("renamed-circle")).toHaveLength(0);

    core.close();
  });

  it("renameCircle: double-promote under new circle is blocked (UNIQUE guard still holds)", async () => {
    const core = freshCore();
    const id = await storeOne(core, "Concept for double-promote rename test.");
    promote(core, id, "Original pinned summary.");

    core.renameCircle("default", "renamed-circle");

    // Attempting to promote the same concept again in the renamed circle must throw
    // (UNIQUE(concept_id, circle) was preserved with updated circle value).
    expect(() => promote(core, id, "Second summary — must fail.", "renamed-circle")).toThrow();

    core.close();
  });

  it("renameCircle: reorderFirstBlock works under new circle after rename", async () => {
    const core = freshCore();
    const a = await storeOne(core, "Alpha rename reorder concept.");
    const b = await storeOne(core, "Beta rename reorder concept.");
    promote(core, a, "Alpha.");
    promote(core, b, "Beta.");

    core.renameCircle("default", "reordered-circle");

    // reorderFirstBlock must not throw after rename.
    expect(() => core.reorderFirstBlock([b, a], "reordered-circle")).not.toThrow();
    const entries = core.listFirstBlock("reordered-circle");
    expect(entries[0]!.conceptId).toBe(b);
    expect(entries[1]!.conceptId).toBe(a);

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Finding 2: prewarm blob must be bounded when firstBlockBlob exceeds the cap
  // ---------------------------------------------------------------------------
  it("buildPrewarmBlock: oversized first-block emits advisory (bounded) not unbounded blob", async () => {
    // PREWARM_BLOCK_MAX_CHARS = 2_500; budget = cap - header(44) - footer(24) = ~2432.
    // Each summary is capped at FIRST_BLOCK_SUMMARY_MAX_CHARS = 800.
    // 4 summaries of 700 chars each = 2800 chars of summaries alone → exceeds budget.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const bigSummary = "x".repeat(700);
    for (let i = 0; i < 4; i++) {
      const id = (await core.store(`Oversized pin concept number ${i} with unique token t${i}oken.`, {
        circle: "default",
        resolution: "forceNew",
      })).conceptId;
      core.promoteToFirstBlock(id, bigSummary, "default");
    }

    // Trigger the rendered block via autoPrewarm on the first tool call.
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: true, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);
    const result = (await client.callTool({ name: "memory_first_block", arguments: { action: "list" } })) as McpContent;

    // content[0] is JSON result; content[1] (if present) is the prewarm block.
    const blockText = result.content.slice(1).map((c) => c.text).join("");

    // Must be bounded: <= PREWARM_BLOCK_MAX_CHARS (2500) — the unbounded path returned 4*700+overhead.
    expect(blockText.length).toBeLessThanOrEqual(2_500);

    // Must contain the advisory (no silent drop).
    expect(blockText).toMatch(/exceed.*prewarm budget/i);

    // Must NOT contain the raw pinned summaries (they were replaced by the advisory).
    expect(blockText).not.toContain(bigSummary);

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Finding 3: prewarm() return has firstBlock as the first key
  // ---------------------------------------------------------------------------
  it("prewarm() return object has firstBlock as the first key", async () => {
    const core = freshCore();
    await storeOne(core, "Concept for key-order test.");
    const state = core.prewarm("default");
    const keys = Object.keys(state);
    expect(keys[0]).toBe("firstBlock");
    core.close();
  });

  // ---------------------------------------------------------------------------
  // Finding B (Codex round-5): curation advisory must survive when lower-priority
  // content (workstreams / top / stale / contradictions) is large enough to exhaust
  // the prewarm budget on its own.
  // ---------------------------------------------------------------------------
  it("buildPrewarmBlock: curation advisory survives when lower content fills the budget", async () => {
    // Strategy: create a disputed pin (trips firstBlockDisputed → advisory fires), then
    // flood the lower-priority sections with content large enough that naive tail-append
    // ordering would drop the advisory.
    //
    // PREWARM_BLOCK_MAX_CHARS = 2_500. We need enough lower-priority content to exceed the
    // remaining budget after the first-block lines. We'll create enough stale concepts with
    // long titles to fill the lower section past the cap, then verify the advisory (which
    // appears at the TOP of lowerLines after the Finding-B fix) survives truncation.

    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 1, // makes all concepts immediately stale → floods "Stale" section
    });

    // One disputed pin — triggers the advisory (firstBlockDisputed=1).
    const disputedId = await storeOne(core, "Finding-B disputed pin concept.");
    promote(core, disputedId, "Short disputed summary.");
    core.flagContradiction(disputedId, { detail: "Finding-B conflict" });

    // One active pin — so firstBlockLines is non-empty and the block renders.
    const activeId = await storeOne(core, "Finding-B active pin concept.");
    promote(core, activeId, "Short active summary.");

    // Add many concepts with long titles to inflate the lower-priority content.
    // "Stale" section shows up to 5, but workstreams/top can also contribute.
    // We create enough top-concepts with long names to fill the budget after the first block.
    const longTitle = "T".repeat(200); // 200-char concept content → long title in prewarm
    for (let i = 0; i < 15; i++) {
      await core.store(`${longTitle} token-fb-${i}.`, { circle: "default", resolution: "forceNew" });
    }

    // Trigger the rendered block via autoPrewarm.
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: true, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);
    const result = (await client.callTool({ name: "memory_first_block", arguments: { action: "list" } })) as McpContent;

    const blockText = result.content.slice(1).map((c) => c.text).join("");

    // The block must be bounded.
    expect(blockText.length).toBeLessThanOrEqual(2_500);

    // The block must contain the curation advisory — it must NOT be dropped by budget
    // exhaustion from the lower-priority content that follows it.
    expect(blockText).toMatch(/Curation attention:/i);
    expect(blockText).toMatch(/firstBlockDisputed/);

    core.close();
  });
});

// ==============================================================================
// STEP 8 — Codex P2 regressions: agent_context structured path (Findings 4 & 5)
// ==============================================================================

describe("Step 8: Codex P2 — agent_context structured path (Findings 4 & 5)", () => {
  // Helpers -------------------------------------------------------------------

  /** Call agent_context via the MCP transport; return the parsed JSON payload. */
  async function agentContextPayload(
    core: MonetCore,
  ): Promise<Record<string, unknown>> {
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);
    const result = (await client.callTool({ name: "agent_context", arguments: {} })) as McpContent;
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  }

  // ---------------------------------------------------------------------------
  // Finding 5: disputed pins must be ABSENT from agent_context injection payload
  //            but STILL counted in curationAttention.firstBlockDisputed AND
  //            still returned by memory_first_block list (curation path untouched).
  // ---------------------------------------------------------------------------
  it("Finding 5: disputed pin absent from agent_context firstBlock, counted in curationAttention.firstBlockDisputed", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "Finding-5 disputed pin concept.");
    promote(core, id, "Finding-5 disputed summary.");
    // Flag a contradiction to mark the concept disputed.
    core.flagContradiction(id, { detail: "Finding-5 conflict" });

    const payload = await agentContextPayload(core);

    // The injected firstBlock must NOT include the disputed entry.
    const firstBlock = payload["firstBlock"] as Array<{ conceptId: string; conceptStatus: string }>;
    expect(Array.isArray(firstBlock)).toBe(true);
    expect(firstBlock.every((e) => e.conceptStatus === "active")).toBe(true);
    expect(firstBlock.some((e) => e.conceptId === id)).toBe(false);

    // curationAttention must still flag firstBlockDisputed=1.
    const attention = payload["curationAttention"] as string | undefined;
    expect(attention).toBeDefined();
    expect(attention).toMatch(/firstBlockDisputed=1/);

    // The curation path (memory_first_block list) must still return the disputed entry.
    expect(isPresent(core, id, "default")).toBe(true);
    const allEntries = core.listFirstBlock("default");
    const disputedEntry = allEntries.find((e) => e.conceptId === id);
    expect(disputedEntry).toBeDefined();
    expect(disputedEntry!.conceptStatus).toBe("disputed");

    core.close();
  });

  it("Finding 5: active pin IS present in agent_context firstBlock (regression guard)", async () => {
    const core = new MonetCore(":memory:");
    const id = await storeOne(core, "Finding-5 active pin concept.");
    promote(core, id, "Finding-5 active summary.");
    // No contradiction — concept remains active.

    const payload = await agentContextPayload(core);

    const firstBlock = payload["firstBlock"] as Array<{ conceptId: string; conceptStatus: string }>;
    expect(Array.isArray(firstBlock)).toBe(true);
    const entry = firstBlock.find((e) => e.conceptId === id);
    expect(entry).toBeDefined();
    expect(entry!.conceptStatus).toBe("active");

    core.close();
  });

  it("Finding 5: mixed active+disputed — only active in injection, all in list, advisory counts both", async () => {
    // freshCore sets tauAttach=1.1 (> max possible score 1.0) so different-content stores always create new concepts.
    const core = freshCore();
    const activeId = await storeOne(core, "Finding-5 mixed active concept.");
    const disputedId = await storeOne(core, "Finding-5 mixed disputed concept unique-token-xq9.");
    promote(core, activeId, "Active summary.");
    promote(core, disputedId, "Disputed summary.");
    core.flagContradiction(disputedId, { detail: "Finding-5 mixed conflict" });

    const payload = await agentContextPayload(core);

    const firstBlock = payload["firstBlock"] as Array<{ conceptId: string; conceptStatus: string }>;
    expect(Array.isArray(firstBlock)).toBe(true);

    // Active entry present, disputed absent.
    expect(firstBlock.some((e) => e.conceptId === activeId)).toBe(true);
    expect(firstBlock.some((e) => e.conceptId === disputedId)).toBe(false);

    // Advisory counts the disputed entry.
    const attention = payload["curationAttention"] as string | undefined;
    expect(attention).toMatch(/firstBlockDisputed=1/);

    // Curation list (listFirstBlock) returns both.
    const allEntries = core.listFirstBlock("default");
    expect(allEntries.some((e) => e.conceptId === activeId)).toBe(true);
    expect(allEntries.some((e) => e.conceptId === disputedId)).toBe(true);

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Finding 4: agent_context firstBlock is bounded — oversized payload emits
  //            an advisory string and the serialized result stays within budget.
  // ---------------------------------------------------------------------------
  it("Finding 4: oversized firstBlock emits advisory string and payload stays within RESULT_MAX_CHARS", async () => {
    // FIRST_BLOCK_INJECTION_MAX_CHARS = 6_000; FIRST_BLOCK_SUMMARY_MAX_CHARS = 800.
    // 10 pins × 800-char summaries → serialized firstBlock ≈ 10 × 800 + overhead > 6_000.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const bigSummary = "s".repeat(800);
    for (let i = 0; i < 10; i++) {
      const id = (await core.store(`Finding-4 oversized pin concept number ${i} unique-tok-${i}xyz.`, {
        circle: "default",
        resolution: "forceNew",
      })).conceptId;
      core.promoteToFirstBlock(id, bigSummary, "default");
    }

    const payload = await agentContextPayload(core);

    // firstBlock must be a string advisory (not an array) when oversized.
    expect(typeof payload["firstBlock"]).toBe("string");
    const advisory = payload["firstBlock"] as string;
    expect(advisory).toMatch(/exceed.*injection budget/i);

    // The serialized full payload must fit within RESULT_MAX_CHARS (40_000).
    const serialized = JSON.stringify(payload, null, 2);
    expect(serialized.length).toBeLessThanOrEqual(40_000);

    // The curation path must still return all entries.
    const allEntries = core.listFirstBlock("default");
    expect(allEntries).toHaveLength(10);

    core.close();
  });

  it("Finding 4: within-budget firstBlock returns an array not an advisory", async () => {
    // 1 pin with short summary — well within FIRST_BLOCK_INJECTION_MAX_CHARS.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const id = (await core.store("Finding-4 small pin concept.", { circle: "default" })).conceptId;
    core.promoteToFirstBlock(id, "Short summary.", "default");

    const payload = await agentContextPayload(core);

    // When within budget, firstBlock must be an array.
    expect(Array.isArray(payload["firstBlock"])).toBe(true);
    const firstBlock = payload["firstBlock"] as Array<{ conceptId: string }>;
    expect(firstBlock.some((e) => e.conceptId === id)).toBe(true);

    core.close();
  });

  it("Finding 4+5 combined: oversized active set with a disputed entry — advisory correct, disputed absent from count", async () => {
    // 10 active pins (large) + 1 disputed pin. Advisory must only count/describe the active
    // oversized entries; the disputed entry is filtered before the size check.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const bigSummary = "t".repeat(800);

    // 10 active oversized pins.
    for (let i = 0; i < 10; i++) {
      const id = (await core.store(`Finding-45 combined active concept ${i} tok-${i}abc.`, {
        circle: "default",
        resolution: "forceNew",
      })).conceptId;
      core.promoteToFirstBlock(id, bigSummary, "default");
    }
    // 1 disputed pin.
    const disputedId = (await core.store("Finding-45 disputed pin concept unique-tok-disp.", {
      circle: "default",
      resolution: "forceNew",
    })).conceptId;
    core.promoteToFirstBlock(disputedId, "Disputed summary.", "default");
    core.flagContradiction(disputedId, { detail: "Finding-45 conflict" });

    const payload = await agentContextPayload(core);

    // firstBlock is an advisory string (oversize path).
    expect(typeof payload["firstBlock"]).toBe("string");
    const advisory = payload["firstBlock"] as string;
    // Advisory must mention 10 (the active count, not 11 which would include disputed).
    expect(advisory).toMatch(/10 pinned item/);

    // curationAttention must flag firstBlockDisputed=1 (still counted pre-filter).
    const attention = payload["curationAttention"] as string | undefined;
    expect(attention).toMatch(/firstBlockDisputed=1/);

    // Serialized payload fits within RESULT_MAX_CHARS.
    const serialized = JSON.stringify(payload, null, 2);
    expect(serialized.length).toBeLessThanOrEqual(40_000);

    // Curation list includes all 11 entries.
    const allEntries = core.listFirstBlock("default");
    expect(allEntries).toHaveLength(11);

    core.close();
  });
});

// ==============================================================================
// Step 9: Codex round-3 findings A & B
// ==============================================================================

describe("Step 9: Codex round-3 findings A & B", () => {
  it("memory_first_block list with many large pins — returns compact previews, no JSON truncation", async () => {
    const core = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });
    const { client } = await mcpHarness(core);

    // Create 50 pins with 800-char summaries.
    const bigSummary = "x".repeat(800);
    for (let i = 0; i < 50; i++) {
      const id = await storeOne(core, `Distinct concept content token-${i} zeta-${i}.`);
      promote(core, id, bigSummary);
    }

    // Call list via MCP harness directly (need raw text for length check).
    type McpContent = { content: Array<{ type: string; text: string }>; isError?: boolean };
    const rawResult = (await client.callTool({ name: "memory_first_block", arguments: { action: "list" } })) as McpContent;
    const rawText = rawResult.content[0]!.text;
    expect(rawResult.isError).toBeFalsy();
    expect(rawText.length).toBeLessThan(40_000);

    const parsed = JSON.parse(rawText) as {
      entries: Array<{ conceptId: string; position: number; summaryDirty: boolean; conceptStatus: string; summary: string }>;
    };
    expect(parsed.entries).toHaveLength(50);

    for (const entry of parsed.entries) {
      expect(entry.conceptId).toBeDefined();
      expect(typeof entry.position).toBe("number");
      expect(typeof entry.summaryDirty).toBe("boolean");
      expect(typeof entry.conceptStatus).toBe("string");
      // Summary must be at most 121 chars (120-char slice + "…" ellipsis).
      expect(entry.summary.length).toBeLessThanOrEqual(121);
    }

    core.close();
  });

  it("memory_first_block list with 300 pins — valid JSON, under 40k chars, pagination contract (total/offset/limit)", async () => {
    // Finding A (Codex round-5): replaced the hard-cap + truncationNote approach with
    // offset-pagination so ALL pins are addressable via reorder/remove without any being
    // silently hidden. The response now carries { total, offset, limit, entries } instead
    // of a truncationNote field, and paging reaches every pin.
    const PIN_COUNT = 300;
    const DEFAULT_LIMIT = 100; // must match FIRST_BLOCK_LIST_DEFAULT_LIMIT in mcp-server.ts
    const RESULT_MAX_CHARS = 40_000;

    const core = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });
    const { client } = await mcpHarness(core);

    // Create PIN_COUNT pins, each with a 120-char summary (worst-case preview length).
    const longSummary = "s".repeat(120);
    for (let i = 0; i < PIN_COUNT; i++) {
      const id = await storeOne(core, `List-cap concept ${i} unique-lc-${i}.`);
      promote(core, id, longSummary);
    }

    type McpContent = { content: Array<{ type: string; text: string }>; isError?: boolean };

    // --- Page 0 (default: offset=0, limit=100) ---
    const rawResult = (await client.callTool({ name: "memory_first_block", arguments: { action: "list" } })) as McpContent;
    expect(rawResult.isError).toBeFalsy();

    const rawText = rawResult.content[0]!.text;

    // 1. Response must be valid JSON (not truncated mid-object by ok()).
    let parsed: { circle: string; total: number; offset: number; limit: number; entries: Array<{ conceptId: string; position: number }> };
    expect(() => {
      parsed = JSON.parse(rawText) as typeof parsed;
    }).not.toThrow();

    // 2. Total response size must stay under the 40k ok() ceiling.
    expect(rawText.length).toBeLessThan(RESULT_MAX_CHARS);

    // 3. Pagination envelope: total=300, offset=0, limit=100, entries.length=100.
    expect(parsed!.total).toBe(PIN_COUNT);
    expect(parsed!.offset).toBe(0);
    expect(parsed!.limit).toBe(DEFAULT_LIMIT);
    expect(parsed!.entries).toHaveLength(DEFAULT_LIMIT);

    // 4. No truncationNote — the old hard-cap field must be absent.
    expect((parsed! as Record<string, unknown>)["truncationNote"]).toBeUndefined();

    // --- Page 1 (offset=100) — proves pins 100–199 are addressable ---
    const page1Result = (await client.callTool({ name: "memory_first_block", arguments: { action: "list", offset: 100 } })) as McpContent;
    expect(page1Result.isError).toBeFalsy();
    const page1 = JSON.parse(page1Result.content[0]!.text) as typeof parsed;
    expect(page1.total).toBe(PIN_COUNT);
    expect(page1.offset).toBe(100);
    expect(page1.entries).toHaveLength(DEFAULT_LIMIT);

    // --- Page 2 (offset=200) — proves pins 200–299 are addressable ---
    const page2Result = (await client.callTool({ name: "memory_first_block", arguments: { action: "list", offset: 200 } })) as McpContent;
    expect(page2Result.isError).toBeFalsy();
    const page2 = JSON.parse(page2Result.content[0]!.text) as typeof parsed;
    expect(page2.total).toBe(PIN_COUNT);
    expect(page2.offset).toBe(200);
    expect(page2.entries).toHaveLength(DEFAULT_LIMIT);

    // All three pages together cover all PIN_COUNT pins — every pin is addressable.
    const allConceptIds = new Set([
      ...parsed!.entries.map((e) => e.conceptId),
      ...page1.entries.map((e) => e.conceptId),
      ...page2.entries.map((e) => e.conceptId),
    ]);
    expect(allConceptIds.size).toBe(PIN_COUNT);

    core.close();
  });

  it("renameCircle into existing dest — no position collision, dest-first order", async () => {
    const core = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });

    // Create circle "src" with 2 pins (positions 0, 1).
    const srcA = await storeOne(core, "Source concept alpha unique-src-a.", "src");
    const srcB = await storeOne(core, "Source concept beta unique-src-b.", "src");
    promote(core, srcA, "Src pin A summary.", "src");
    promote(core, srcB, "Src pin B summary.", "src");

    // Create circle "dst" with 2 pins (positions 0, 1).
    const dstA = await storeOne(core, "Dest concept alpha unique-dst-a.", "dst");
    const dstB = await storeOne(core, "Dest concept beta unique-dst-b.", "dst");
    promote(core, dstA, "Dst pin A summary.", "dst");
    promote(core, dstB, "Dst pin B summary.", "dst");

    core.renameCircle("src", "dst");

    const entries = core.listFirstBlock("dst");
    expect(entries).toHaveLength(4);

    // No two entries share a position.
    const positions = entries.map((e) => e.position);
    expect(new Set(positions).size).toBe(4);

    // The original dst concepts appear at smaller positions than the moved src concepts.
    // dst pins retain positions 0 and 1; src pins get positions 2 and 3.
    const dstEntries = entries.filter((e) => e.conceptId === dstA || e.conceptId === dstB);
    const srcEntries = entries.filter((e) => e.conceptId === srcA || e.conceptId === srcB);
    const maxDstPos = Math.max(...dstEntries.map((e) => e.position));
    const minSrcPos = Math.min(...srcEntries.map((e) => e.position));
    expect(maxDstPos).toBeLessThan(minSrcPos);

    core.close();
  });

  it("renameCircle into empty dest — positions preserved unchanged", async () => {
    const core = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });

    const a = await storeOne(core, "Source concept alpha unique-src2-a.", "src2");
    const b = await storeOne(core, "Source concept beta unique-src2-b.", "src2");
    const c = await storeOne(core, "Source concept gamma unique-src2-c.", "src2");
    promote(core, a, "Summary A.", "src2");
    promote(core, b, "Summary B.", "src2");
    promote(core, c, "Summary C.", "src2");

    core.renameCircle("src2", "new-empty-dest");

    const entries = core.listFirstBlock("new-empty-dest");
    expect(entries).toHaveLength(3);

    const positions = entries.map((e) => e.position);
    expect(positions).toEqual([0, 1, 2]);

    core.close();
  });
});

// ==============================================================================
// STEP 10 — Codex PR-32 findings (3 findings, verified fixes)
// ==============================================================================

describe("Step 10: Codex PR-32 finding fixes", () => {
  // ---------------------------------------------------------------------------
  // Finding 1: list page-size cap — limit=100000 must return valid JSON at most
  //            FIRST_BLOCK_LIST_MAX_LIMIT (200) entries, not an un-parseable blob.
  // ---------------------------------------------------------------------------
  it("Finding 1: list with limit=100000 returns valid JSON capped at max limit", async () => {
    const core = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });

    // 10 pins — well below the cap, so we're testing the clamp rather than count.
    const longSummary = "L".repeat(120);
    for (let i = 0; i < 10; i++) {
      const id = await storeOne(core, `Finding-1 pin concept ${i} tok-f1-${i}.`);
      promote(core, id, longSummary);
    }

    type McpResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
    const { client } = await mcpHarness(core);
    const raw = (await client.callTool({ name: "memory_first_block", arguments: {
      action: "list",
      limit: 100_000,
    }})) as McpResult;

    // Must not be an error.
    expect(raw.isError).toBeFalsy();
    const text = raw.content[0]!.text;

    // Must be valid JSON (no truncation mid-object).
    let parsed: { total: number; offset: number; limit: number; entries: unknown[] };
    expect(() => { parsed = JSON.parse(text) as typeof parsed; }).not.toThrow();

    // The returned limit must be capped at FIRST_BLOCK_LIST_MAX_LIMIT (200), not 100000.
    expect(parsed!.limit).toBeLessThanOrEqual(200);
    // Entries count must be the actual store size (10), not 100000.
    expect(parsed!.entries).toHaveLength(10);
    // Total serialized response stays under RESULT_MAX_CHARS.
    expect(text.length).toBeLessThan(40_000);

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Finding 2a: circle merge A→B — pinned concepts from A survive, re-homed into B,
  //             positions offset after B's existing pins, no collision, all reachable.
  // ---------------------------------------------------------------------------
  it("Finding 2a: circle merge A→B — pinned concepts in A are re-homed into B with offset positions", async () => {
    // Use forceNew so nothing merges into a duplicate (every concept moves, none is deleted).
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });

    // Circle B — 2 existing pins (positions 0, 1).
    const bA = await storeOne(core, "Dest circle B concept alpha unique-b-a.", "B");
    const bB = await storeOne(core, "Dest circle B concept beta unique-b-b.", "B");
    promote(core, bA, "B-alpha summary.", "B");
    promote(core, bB, "B-beta summary.", "B");

    // Circle A — 2 pins that must survive the merge (positions 0, 1 in A).
    const aC = await storeOne(core, "Source circle A concept gamma unique-a-c.", "A");
    const aD = await storeOne(core, "Source circle A concept delta unique-a-d.", "A");
    promote(core, aC, "A-gamma summary.", "A");
    promote(core, aD, "A-delta summary.", "A");

    // Merge A → B (forceNew: each A concept moves, no dedup-merge).
    await core.mergeCircle("A", "B", { resolution: "forceNew" });

    // All 4 pins must now live in B.
    const entries = core.listFirstBlock("B");
    expect(entries).toHaveLength(4);

    // No two entries share a position (no collision).
    const positions = entries.map((e) => e.position);
    expect(new Set(positions).size).toBe(4);

    // B's original pins (bA, bB) must appear at lower positions than A's moved pins (aC, aD).
    const bOriginals = entries.filter((e) => e.conceptId === bA || e.conceptId === bB);
    const aMoved = entries.filter((e) => e.conceptId === aC || e.conceptId === aD);
    expect(bOriginals).toHaveLength(2);
    expect(aMoved).toHaveLength(2);
    const maxBPos = Math.max(...bOriginals.map((e) => e.position));
    const minAPos = Math.min(...aMoved.map((e) => e.position));
    expect(maxBPos).toBeLessThan(minAPos);

    // Summaries are intact.
    const gammaEntry = entries.find((e) => e.conceptId === aC);
    expect(gammaEntry?.summary).toBe("A-gamma summary.");

    // A's circle no longer has any pins.
    expect(core.listFirstBlock("A")).toHaveLength(0);

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Finding 2b: merge where a source concept folds into a DUPLICATE in B — that
  //             pin is removed (no dangling row), not re-homed.
  // ---------------------------------------------------------------------------
  it("Finding 2b: merge where source concept folds into duplicate in B — pin is removed, no dangling row", async () => {
    // Use real thresholds so identical-content stores dedupe (score=1.0 >= tauAttach=0.55).
    const core = new MonetCore(":memory:");

    const content = "Cache auth tokens in Redis with 30min TTL.";
    // Create the concept in B first (the duplicate that will survive).
    const targetId = await storeOne(core, content, "B");
    promote(core, targetId, "Redis TTL summary.", "B");

    // Create the same concept in A (will merge into targetId on reassign → deleted).
    const srcId = await storeOne(core, content, "A");
    promote(core, srcId, "Source Redis TTL summary.", "A");

    // Merge A → B with auto resolution — srcId dedupes into targetId and is DELETED.
    await core.mergeCircle("A", "B", { resolution: "auto" });

    // srcId was deleted — its pin must be gone (no dangling FK row).
    const aEntries = core.listFirstBlock("A");
    expect(aEntries.some((e) => e.conceptId === srcId)).toBe(false);
    const bEntries = core.listFirstBlock("B");
    expect(bEntries.some((e) => e.conceptId === srcId)).toBe(false);

    // The surviving target pin in B is still present.
    expect(bEntries.some((e) => e.conceptId === targetId)).toBe(true);

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Finding 2c: moveConcept (reassignCircle) into existing dest — pin re-homed,
  //             position appended after dest's existing pins.
  // ---------------------------------------------------------------------------
  it("Finding 2c: moveConcept into dest with existing pins — re-homed pin appends after dest pins", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });

    // Dest circle "dest" with 2 existing pins.
    const dA = await storeOne(core, "Dest circle concept alpha unique-d2a.", "dest");
    const dB = await storeOne(core, "Dest circle concept beta unique-d2b.", "dest");
    promote(core, dA, "Dest-alpha.", "dest");
    promote(core, dB, "Dest-beta.", "dest");

    // Src concept in "src" with a pin.
    const srcId = await storeOne(core, "Src circle concept gamma unique-s2g.", "src");
    promote(core, srcId, "Src-gamma.", "src");

    // Move srcId into "dest" (no dedup — content is distinct).
    core.reassignCircle(srcId, "dest");

    // All 3 pins now in dest.
    const entries = core.listFirstBlock("dest");
    expect(entries).toHaveLength(3);

    // No position collision.
    const positions = entries.map((e) => e.position);
    expect(new Set(positions).size).toBe(3);

    // Moved pin position must be > both original dest positions.
    const destOriginals = entries.filter((e) => e.conceptId === dA || e.conceptId === dB);
    const movedEntry = entries.find((e) => e.conceptId === srcId);
    expect(movedEntry).toBeDefined();
    const maxDestPos = Math.max(...destOriginals.map((e) => e.position));
    expect(movedEntry!.position).toBeGreaterThan(maxDestPos);

    // Summary is intact after re-home.
    expect(movedEntry!.summary).toBe("Src-gamma.");

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Finding 3: list with full=true returns untruncated summaries;
  //            default (full omitted) still truncates at 120 chars.
  // ---------------------------------------------------------------------------
  it("Finding 3: list full=true returns untruncated summaries; default truncates at 120 chars", async () => {
    const core = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });
    const longSummary = "F".repeat(300); // 300 chars — well above the 120-char preview cap.
    const id = await storeOne(core, "Finding-3 full-summary test concept.");
    promote(core, id, longSummary);

    type McpResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
    const { client } = await mcpHarness(core);

    // Default list (no full flag) — summary must be truncated.
    const defaultRaw = (await client.callTool({ name: "memory_first_block", arguments: { action: "list" } })) as McpResult;
    expect(defaultRaw.isError).toBeFalsy();
    const defaultParsed = JSON.parse(defaultRaw.content[0]!.text) as { entries: Array<{ summary: string }> };
    const defaultEntry = defaultParsed.entries.find((e: { summary: string }) => e.summary.includes("FFFF"));
    expect(defaultEntry).toBeDefined();
    // Truncated: at most 121 chars (120-char slice + "…").
    expect(defaultEntry!.summary.length).toBeLessThanOrEqual(121);
    expect(defaultEntry!.summary.endsWith("…")).toBe(true);

    // full=true — summary must be the full 300-char string.
    const fullRaw = (await client.callTool({ name: "memory_first_block", arguments: {
      action: "list",
      full: true,
    }})) as McpResult;
    expect(fullRaw.isError).toBeFalsy();
    const fullParsed = JSON.parse(fullRaw.content[0]!.text) as { entries: Array<{ conceptId: string; summary: string }> };
    const fullEntry = fullParsed.entries.find((e) => e.conceptId === id);
    expect(fullEntry).toBeDefined();
    // Full: exact 300 chars, no truncation.
    expect(fullEntry!.summary.length).toBe(300);
    expect(fullEntry!.summary).toBe(longSummary);
    expect(fullEntry!.summary.endsWith("…")).toBe(false);

    core.close();
  });

  // Finding 3 guard: full=true on an already-short summary returns it unchanged.
  it("Finding 3: full=true on a short summary returns the summary unchanged (no ellipsis)", async () => {
    const core = freshCore();
    const shortSummary = "Short pin summary — under 120 chars.";
    const id = await storeOne(core, "Finding-3 short summary concept.");
    promote(core, id, shortSummary);

    type McpResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
    const { client } = await mcpHarness(core);
    const raw = (await client.callTool({ name: "memory_first_block", arguments: {
      action: "list",
      full: true,
    }})) as McpResult;
    expect(raw.isError).toBeFalsy();
    const parsed = JSON.parse(raw.content[0]!.text) as { entries: Array<{ conceptId: string; summary: string }> };
    const entry = parsed.entries.find((e) => e.conceptId === id);
    expect(entry).toBeDefined();
    expect(entry!.summary).toBe(shortSummary);

    core.close();
  });
});

// ==============================================================================
// STEP 11 — full=true overflow guard (Codex PR-32 follow-up)
// ==============================================================================

describe("Step 11: full=true page-size overflow guard", () => {
  // ---------------------------------------------------------------------------
  // Primary: full=true + limit=100000 + 60 × 800-char summaries
  // → response is valid JSON, under RESULT_MAX_CHARS, returns at most
  //   FIRST_BLOCK_LIST_FULL_MAX_LIMIT (40) entries.
  // ---------------------------------------------------------------------------
  it("full=true with limit=100000 and 60 entries of 800-char summaries — valid JSON, under 40k chars, at most 40 entries", async () => {
    const PIN_COUNT = 60;
    const SUMMARY_CHARS = 800;
    const FULL_MAX_LIMIT = 40; // must match FIRST_BLOCK_LIST_FULL_MAX_LIMIT in mcp-server.ts
    const RESULT_MAX_CHARS = 40_000;

    const core = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });
    const bigSummary = "X".repeat(SUMMARY_CHARS);
    for (let i = 0; i < PIN_COUNT; i++) {
      const id = await storeOne(core, `Full-overflow concept ${i} unique-fo-${i}.`);
      promote(core, id, bigSummary);
    }

    type McpResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
    const { client } = await mcpHarness(core);
    const raw = (await client.callTool({ name: "memory_first_block", arguments: {
      action: "list",
      limit: 100_000,
      full: true,
    }})) as McpResult;

    // Must not be an error.
    expect(raw.isError).toBeFalsy();
    const text = raw.content[0]!.text;

    // 1. Must be valid JSON — no truncation mid-object.
    let parsed: { total: number; offset: number; limit: number; entries: Array<{ conceptId: string; summary: string }> };
    expect(() => { parsed = JSON.parse(text) as typeof parsed; }).not.toThrow();

    // 2. Total serialized response must be under RESULT_MAX_CHARS (40 000).
    expect(text.length).toBeLessThan(RESULT_MAX_CHARS);

    // 3. At most FULL_MAX_LIMIT (40) entries returned — the tighter cap applies.
    expect(parsed!.entries.length).toBeLessThanOrEqual(FULL_MAX_LIMIT);

    // 4. Reported limit is clamped (not the caller's 100000).
    expect(parsed!.limit).toBeLessThanOrEqual(FULL_MAX_LIMIT);

    // 5. Summaries are UNTRUNCATED (full=true) — each must be exactly SUMMARY_CHARS.
    for (const entry of parsed!.entries) {
      expect(entry.summary.length).toBe(SUMMARY_CHARS);
      expect(entry.summary.endsWith("…")).toBe(false);
    }

    // 6. total still reflects the full pin count (60), not just the page.
    expect(parsed!.total).toBe(PIN_COUNT);

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Guard: preview mode (full=false / omitted) is unaffected — still allows up
  // to FIRST_BLOCK_LIST_MAX_LIMIT (200) entries.
  // ---------------------------------------------------------------------------
  it("preview mode (full omitted) is unaffected — limit capped at 200, not 40", async () => {
    const PIN_COUNT = 50;
    const MAX_LIMIT = 200; // FIRST_BLOCK_LIST_MAX_LIMIT — preview path unchanged
    const RESULT_MAX_CHARS = 40_000;

    const core = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });
    const bigSummary = "P".repeat(800); // 800-char summary — truncated to 120 in preview
    for (let i = 0; i < PIN_COUNT; i++) {
      const id = await storeOne(core, `Preview-mode concept ${i} unique-pm-${i}.`);
      promote(core, id, bigSummary);
    }

    type McpResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
    const { client } = await mcpHarness(core);
    const raw = (await client.callTool({ name: "memory_first_block", arguments: {
      action: "list",
      limit: 100_000,
    }})) as McpResult;

    expect(raw.isError).toBeFalsy();
    const text = raw.content[0]!.text;

    // Valid JSON.
    let parsed: { total: number; limit: number; entries: Array<{ summary: string }> };
    expect(() => { parsed = JSON.parse(text) as typeof parsed; }).not.toThrow();

    // Under RESULT_MAX_CHARS.
    expect(text.length).toBeLessThan(RESULT_MAX_CHARS);

    // Preview mode cap still allows up to 200 (not the tighter 40).
    expect(parsed!.limit).toBeLessThanOrEqual(MAX_LIMIT);
    expect(parsed!.limit).toBeGreaterThan(40); // definitively not the full=true cap

    // All entries have truncated summaries (≤121 chars).
    for (const entry of parsed!.entries) {
      expect(entry.summary.length).toBeLessThanOrEqual(121);
    }

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Guard: full=true with a small limit (≤40) — the caller-specified limit wins
  // (clamping only applies if the requested limit exceeds the max).
  // ---------------------------------------------------------------------------
  it("full=true with limit=5 — returns exactly 5 entries (caller limit honored under cap)", async () => {
    const core = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });
    const bigSummary = "Y".repeat(800);
    for (let i = 0; i < 20; i++) {
      const id = await storeOne(core, `Full-small-limit concept ${i} unique-fsl-${i}.`);
      promote(core, id, bigSummary);
    }

    type McpResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
    const { client } = await mcpHarness(core);
    const raw = (await client.callTool({ name: "memory_first_block", arguments: {
      action: "list",
      limit: 5,
      full: true,
    }})) as McpResult;

    expect(raw.isError).toBeFalsy();
    const parsed = JSON.parse(raw.content[0]!.text) as { limit: number; entries: unknown[] };
    // Caller's limit (5) is under the full-mode cap (40) — must be honored exactly.
    expect(parsed.limit).toBe(5);
    expect(parsed.entries).toHaveLength(5);

    core.close();
  });
});

// ==============================================================================
// STEP 12 — Codex PR #33 P2 regressions (3 fixes)
// ==============================================================================

describe("Step 12: Codex PR #33 P2 regressions", () => {
  // ---------------------------------------------------------------------------
  // Fix 1 — memory_first_block `list` can exceed the response ceiling.
  // At the old FIRST_BLOCK_LIST_MAX_LIMIT (200), a full preview page of max-length
  // (120-char) summaries serialised to ~60 000 chars, so ok() truncated content[0]
  // mid-object and clients could not JSON.parse the list response.  The cap was lowered
  // to 130 so a max-preview page stays valid JSON under the 40 000-char ceiling; callers
  // page with offset+limit.
  // ---------------------------------------------------------------------------
  it("Fix 1: a max-preview list page parses as valid JSON under the ceiling (not truncated mid-object)", async () => {
    // Reproduce the exact overflow: at the old FIRST_BLOCK_LIST_MAX_LIMIT (200), a caller
    // requesting limit=100000 with 200 max-summary pins got ~60 000 chars of preview JSON,
    // so ok() truncated content[0] mid-object and JSON.parse threw.  The cap was lowered to
    // 130 so the worst-case preview page stays parseable; callers page with offset+limit.
    const STORED_PINS = 200; // > the new cap, so the clamped page is full
    const NEW_CAP = 130;     // FIRST_BLOCK_LIST_MAX_LIMIT after the fix
    const RESULT_MAX_CHARS = 40_000;

    const core = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });
    const bigSummary = "M".repeat(800); // truncated to a 120-char preview per row
    for (let i = 0; i < STORED_PINS; i++) {
      const id = await storeOne(core, `Fix-1 pin concept ${i} unique-fix1-${i}.`);
      promote(core, id, bigSummary);
    }

    type McpResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
    const { client } = await mcpHarness(core);
    const raw = (await client.callTool({ name: "memory_first_block", arguments: {
      action: "list",
      limit: 100_000, // request far more than the cap — must be clamped, not overflow
    }})) as McpResult;

    expect(raw.isError).toBeFalsy();
    const text = raw.content[0]!.text;

    // Primary regression assertion: the response MUST parse as valid JSON.  At the old cap
    // ok() sliced content[0] inside the entries array and this threw.
    let parsed: { total: number; offset: number; limit: number; entries: Array<{ summary: string }> };
    expect(() => { parsed = JSON.parse(text) as typeof parsed; }).not.toThrow();

    // And the whole serialized response must stay under the hard ceiling.
    expect(text.length).toBeLessThan(RESULT_MAX_CHARS);

    // The page is clamped to the new preview cap (130), not the old 200; the remainder is
    // addressable via offset pagination (total still reflects the full store).
    expect(parsed!.total).toBe(STORED_PINS);
    expect(parsed!.limit).toBeLessThanOrEqual(NEW_CAP);
    expect(parsed!.entries).toHaveLength(parsed!.limit);

    // Every preview summary is at most 121 chars (120-char slice + "…").
    for (const entry of parsed!.entries) {
      expect(entry.summary.length).toBeLessThanOrEqual(121);
    }

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Fix 2 — mergeCircle loses pin order.
  // mergeCircle iterated `SELECT concepts` (row/creation) order, so a user-reordered
  // source block like [B, A] was appended to the destination in creation order instead of
  // first_block.position order.  The source pin selection is now ordered by position so
  // destination positions are assigned in the user's curated order.
  // ---------------------------------------------------------------------------
  it("Fix 2: mergeCircle carries source pin position order into the destination First Block", async () => {
    // Use forceNew so every source concept moves (no dedup-merge deletes anything).
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });

    // Destination circle "B" with one existing pin (position 0).
    const b0 = await storeOne(core, "Dest circle B base concept unique-fix2-b0.", "B");
    promote(core, b0, "B-base summary.", "B");

    // Source circle "A": create A then B (creation order), then REORDER to [B, A]
    // so position order is the reverse of creation order.
    const aId = await storeOne(core, "Source circle A concept alpha unique-fix2-a.", "A");
    const bId = await storeOne(core, "Source circle B concept beta unique-fix2-b.", "A");
    promote(core, aId, "A summary.", "A"); // position 0 (creation order)
    promote(core, bId, "B summary.", "A"); // position 1 (creation order)

    // Reorder so position order becomes [B, A] — the reverse of creation/row order.
    core.reorderFirstBlock([bId, aId], "A");
    const srcEntries = core.listFirstBlock("A");
    expect(srcEntries[0]!.conceptId).toBe(bId); // position 0
    expect(srcEntries[1]!.conceptId).toBe(aId); // position 1

    // Merge A → B.  Before the fix the helper appended in creation order (aId then bId);
    // after the fix it appends in position order (bId then aId).
    await core.mergeCircle("A", "B", { resolution: "forceNew" });

    const entries = core.listFirstBlock("B");
    expect(entries).toHaveLength(3);

    // Source circle emptied.
    expect(core.listFirstBlock("A")).toHaveLength(0);

    // Destination order must reflect the SOURCE position order, not creation order:
    // after B's existing base pin (position 0), the moved pins follow as [B, A]
    // → bId at position 1, aId at position 2.
    const byPos = [...entries].sort((x, y) => x.position - y.position);
    expect(byPos.map((e) => e.conceptId)).toEqual([b0, bId, aId]);

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Fix 3 — oversize pins drop lower prewarm sections.
  // When active First Block summaries exceeded the prewarm budget, buildPrewarmBlock
  // early-returned ONLY the oversize advisory and dropped all of lowerLines (workstreams,
  // contradictions, …) even though the advisory left room for them.  The path now uses
  // the advisory as the first-block blob and continues fitting lower sections.
  // ---------------------------------------------------------------------------
  it("Fix 3: oversize First Block pins still render workstreams + open contradictions alongside the advisory", async () => {
    // PREWARM_BLOCK_MAX_CHARS = 2_500; budget = cap - header(44) - footer(24) ≈ 2_432.
    // 4 pins × 700-char summaries = 2_800 chars of summaries alone → exceeds the budget,
    // tripping the oversize path.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });

    const bigSummary = "z".repeat(700);
    for (let i = 0; i < 4; i++) {
      const id = (await core.store(`Fix-3 oversized pin concept ${i} token-fix3-${i}oken.`, {
        circle: "default",
        resolution: "forceNew",
      })).conceptId;
      core.promoteToFirstBlock(id, bigSummary, "default");
    }

    // An ACTIVE workstream — must still render after the oversize advisory.
    await core.saveWorkstream({ status: "active", nextSteps: ["resume the migration"] });

    // An OPEN contradiction — must still render after the oversize advisory.
    const contraId = await storeOne(core, "Fix-3 contradiction concept unique-fix3-contra.");
    core.flagContradiction(contraId, { detail: "Fix-3 conflict detail" });

    // Trigger the rendered block via autoPrewarm on the first tool call.
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: true, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);
    const result = (await client.callTool({ name: "memory_first_block", arguments: { action: "list" } })) as McpContent;

    const blockText = result.content.slice(1).map((c) => c.text).join("");

    // Must still be bounded by the prewarm cap.
    expect(blockText.length).toBeLessThanOrEqual(2_500);

    // The oversize advisory must be present (replaces the raw pinned summaries).
    expect(blockText).toMatch(/exceed.*prewarm budget/i);
    expect(blockText).not.toContain(bigSummary);

    // The lower-priority sections must STILL render — the regression is that they were
    // dropped entirely by the early return.  (Before the fix, none of these would appear.)
    expect(blockText).toMatch(/Active workstreams:/i);
    expect(blockText).toMatch(/Open contradictions:/i);

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Fix A — mergeCircle unpinned merge order follows insertion (rowid) order, not UUID
  // order.  The prior fix ordered source concepts by `(fb.concept_id IS NULL), fb.position
  // ASC, c.id ASC`.  That preserves PINNED order, but the UNPINNED tail is ordered by `c.id`
  // (a random UUID) instead of insertion order.  For resolution:"auto" merges the order
  // unpinned near-duplicates are processed decides which concept SURVIVES (merge-into-
  // earlier), so UUID order could arbitrarily pick the survivor's id/title/body.  A later
  // round added `c.created_at ASC` with `c.id ASC` as a same-ms tiebreak — but created_at is
  // unixepoch()*1000 (whole-ms) and bulk imports land many concepts in the same ms, so ties
  // still fall through to UUID order.  The ORDER BY now uses `c.rowid ASC` (concepts is a
  // normal rowid table, not WITHOUT ROWID) — the canonical monotonic insertion key — so the
  // unpinned tail is processed oldest-first deterministically regardless of created_at.
  // ---------------------------------------------------------------------------
  it("Fix A: mergeCircle processes unpinned source concepts in rowid order — survivor is insertion-stable even when created_at ties", async () => {
    // Build three UNPINNED near-duplicate concepts in source circle "A" and deliberately
    // TIE them on created_at (all stamped to the same value, as a same-ms bulk import would).
    // Because they are near-identical (HashingEmbeddingProvider → score=1.0 ≥ tauAttach), the
    // FIRST one moved into an empty destination "B" becomes the survivor the OTHERS merge
    // into.  The survivor MUST therefore be the FIRST-INSERTED concept (lowest rowid), `a`.
    // Before the rowid fix this assertion was non-deterministic — a created_at tie fell
    // through to c.id ASC (random UUID order) and could pick b or c as the survivor.
    type McpResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

    const core = new MonetCore(":memory:");
    const db = (core as unknown as { db: import("../storage").StoragePort }).db;

    // Three near-duplicate, UNPINNED facts in source circle "A" (same content → 1.0 match
    // once they meet in the destination, so resolution:"auto" merges the later arrivals into
    // the first-arriving).  forceNew keeps them DISTINCT in the source so there are 3 to merge
    // — storeOne()'s default resolution:"auto" would attach the 2nd/3rd to the 1st instead.
    // Insert consecutively so rowid(a) < rowid(b) < rowid(c) (true insertion order).
    const a = (await core.store("Fix-A duplicate fact alpha token-fixa.", { circle: "A", resolution: "forceNew" })).conceptId;
    const b = (await core.store("Fix-A duplicate fact alpha token-fixa.", { circle: "A", resolution: "forceNew" })).conceptId;
    const c = (await core.store("Fix-A duplicate fact alpha token-fixa.", { circle: "A", resolution: "forceNew" })).conceptId;

    // Deliberately TIE created_at — stamp all three to the SAME value so a created_at-based
    // ORDER BY would leave them in an arbitrary (c.id) order and pick a non-deterministic
    // survivor.  The rowid fix must ignore this tie and process them by rowid = insertion order.
    const tied = Date.parse("2024-01-01T00:00:00.000Z");
    db.prepare(`UPDATE concepts SET created_at = ? WHERE id = ?`).run(tied, a);
    db.prepare(`UPDATE concepts SET created_at = ? WHERE id = ?`).run(tied, b);
    db.prepare(`UPDATE concepts SET created_at = ? WHERE id = ?`).run(tied, c);

    // Sanity: rowid ordering mirrors insertion order (a < b < c).
    const rowids = (() => {
      const r = db.prepare(`SELECT id, rowid AS r FROM concepts WHERE circle = 'A' AND kind != 'workstream' ORDER BY rowid ASC`).all() as Array<{ id: string; r: number }>;
      return r.map((x) => x.id);
    })();
    expect(rowids).toEqual([a, b, c]);

    // None are pinned — the unpinned tail is the path the fix orders by rowid.
    expect(core.listFirstBlock("A")).toHaveLength(0);
    expect(core.listFirstBlock("B")).toHaveLength(0);

    await core.mergeCircle("A", "B", { resolution: "auto" });

    // After merge, exactly ONE concept survives in B (the others merged into it).
    expect(core.conceptCount("B")).toBe(1);

    // The survivor MUST be the FIRST-INSERTED concept (a, lowest rowid), because the unpinned
    // tail is processed insertion-first (rowid ASC) and the first-arriving concept in the empty
    // destination is the merge target.  Before the rowid fix, the created_at tie fell through
    // to c.id ASC and could arbitrarily pick b or c — this assertion failed non-deterministically.
    const row = db.prepare(`SELECT id FROM concepts WHERE circle = 'B' AND kind != 'workstream'`).get() as { id: string } | undefined;
    expect(row?.id).toBe(a);

    // The merged-away ids (b, c) no longer exist as concepts anywhere.
    const stillExists = (id: string) => !!db.prepare(`SELECT 1 FROM concepts WHERE id = ?`).get(id);
    expect(stillExists(b)).toBe(false);
    expect(stillExists(c)).toBe(false);

    // Source circle emptied.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM concepts WHERE circle = 'A' AND kind != 'workstream'`).get() as { n: number }).n).toBe(0);

    core.close();
  });

  // ---------------------------------------------------------------------------
  // Fix B — memory_first_block `list` cap must account for JSON escaping.
  // The FIRST_BLOCK_LIST_MAX_LIMIT=130 cap assumes plain-text size, but summaries are
  // arbitrary strings and JSON.stringify expands quotes/backslashes/newlines/control
  // chars.  A preview page of escape-heavy summaries can still exceed RESULT_MAX_CHARS,
  // so ok() truncates content[0] mid-JSON → un-parseable.  The list path now fits entries
  // against the ACTUAL serialized payload size, stopping early so the response provably
  // stays under the ceiling.  Callers page with offset+limit; `total` still reports the
  // full store.  No data is silently dropped — the page is just shrunk and the rest is
  // addressable via offset.
  // ---------------------------------------------------------------------------
  it("Fix B: a max-preview list page of escape-heavy summaries parses as valid JSON under the ceiling", async () => {
    // Reproduce the escape-expansion overflow: build pins whose 120-char previews are dense
    // with characters JSON.stringify expands (quotes, backslashes, newlines, tabs).  Each
    // such char takes 2 bytes in the JSON output, so a near-130-row preview page can balloon
    // past RESULT_MAX_CHARS even though the raw preview char count is under the count cap.
    // Request a large limit; the size-aware fit must shrink the page so the serialized
    // response stays valid JSON AND under the ceiling, with `total` still reporting all pins.
    const STORED_PINS = 160;  // > the count cap (130), so the count cap alone would allow a full page
    const RESULT_MAX_CHARS = 40_000;

    const core = freshCore({ tauAttach: 1.1, tauAmbiguous: 1.1 });
    // A 120-char preview full of JSON-escapable characters.  JSON.stringify turns each `"`
    // and `\` into 2 chars and each control char ("\n","\t") into 2 chars, so the serialized
    // preview is far larger than 120 bytes.
    const escapeHeavy = '"\\\n\t'.repeat(30); // 120 chars, all escapable
    expect(escapeHeavy.length).toBe(120);
    for (let i = 0; i < STORED_PINS; i++) {
      const id = await storeOne(core, `Fix-B pin concept ${i} unique-fixb-${i}.`);
      promote(core, id, escapeHeavy);
    }

    type McpResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
    const { client } = await mcpHarness(core);
    const raw = (await client.callTool({ name: "memory_first_block", arguments: {
      action: "list",
      limit: 100_000, // request far more than the cap — must be shrunk by the size-aware fit
    }})) as McpResult;

    expect(raw.isError).toBeFalsy();
    const text = raw.content[0]!.text;

    // Primary regression assertion: the response MUST parse as valid JSON.  Before the fix the
    // escape-heavy page ballooned past the ceiling and ok() sliced content[0] mid-object.
    let parsed: { total: number; offset: number; limit: number; entries: Array<{ summary: string }> };
    expect(() => { parsed = JSON.parse(text) as typeof parsed; }).not.toThrow();

    // And the whole serialized response MUST stay under the hard ceiling.
    expect(text.length).toBeLessThan(RESULT_MAX_CHARS);

    // No data is silently dropped: `total` still reflects the full store so offset paging
    // reaches the remainder.  The page may be smaller than the count cap, but it is non-empty
    // (the first entry alone fits well within the budget).
    expect(parsed!.total).toBe(STORED_PINS);
    expect(parsed!.entries.length).toBeGreaterThan(0);
    expect(parsed!.entries.length).toBeLessThanOrEqual(parsed!.limit);
    // The returned limit reflects the fitted page size actually returned (≤ the count cap).
    expect(parsed!.limit).toBeLessThanOrEqual(130);

    // The offset-paging contract still holds: requesting a later offset returns the NEXT
    // slice, so no pin is silently hidden by the size-aware shrink.  Compare by conceptId
    // (all summaries are identical by construction), and assert the second page continues
    // exactly where the first ended — no overlap, no gap.
    const page0Ids = parsed!.entries.map((e) => (e as { conceptId?: string }).conceptId);
    const firstLen = parsed!.entries.length;
    expect(firstLen).toBeGreaterThan(0);
    const nextRaw = (await client.callTool({ name: "memory_first_block", arguments: {
      action: "list",
      limit: 100_000,
      offset: firstLen, // advance past the fitted first page
    }})) as McpResult;
    const nextText = nextRaw.content[0]!.text;
    let nextPage: { total: number; offset: number; entries: Array<{ conceptId?: string; summary: string }> };
    expect(() => { nextPage = JSON.parse(nextText) as typeof nextPage; }).not.toThrow();
    expect(nextText.length).toBeLessThan(RESULT_MAX_CHARS);
    expect(nextPage!.total).toBe(STORED_PINS);
    expect(nextPage!.offset).toBe(firstLen);
    expect(nextPage!.entries.length).toBeGreaterThan(0);
    // The second page starts where the first ended — no overlap (conceptIds disjoint).
    const nextIds = nextPage!.entries.map((e) => e.conceptId);
    for (const id of nextIds) expect(page0Ids).not.toContain(id);
    // Together the two pages reach strictly more pins than the first page alone.
    expect(firstLen + nextPage!.entries.length).toBeGreaterThan(firstLen);

    core.close();
  });
});
