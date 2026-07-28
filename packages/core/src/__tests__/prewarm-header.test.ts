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
import { STAGE_INDEX_CAP, upsertStage } from "../gates";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

type McpContent = { content: Array<{ type: string; text: string }>; isError?: boolean };

type RawDb = { prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] } };
/** Reaches past MonetCore's public surface for the same reason gates.test.ts's own `raw()` does:
 * building fixture rows fast, via upsertStage + raw INSERTs, without paying per-row embedding cost. */
const raw = (c: MonetCore): RawDb => (c as unknown as { db: RawDb }).db;

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

  it("carries a stage-index recognition-cue line, capped at STAGE_INDEX_PREWARM_MAX_SHOWN with a '+K more' tail (review fix, item 5b)", async () => {
    const core = new MonetCore(":memory:");
    // 18 rules bound to 18 distinct stages — more than the 15-name cap, so the tail must appear.
    for (let i = 0; i < 18; i++) {
      await core.store(`Rule number ${i}.`, {
        kind: "rule", resolution: "forceNew",
        rule: { stage: `stage-${String(i).padStart(2, "0")}`, scope: "domain" },
      });
    }

    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: true, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);

    // First non-agent_context call — a worker that never explicitly calls agent_context still
    // gets this cue, which is the whole point of putting it in the auto-injected block at all.
    const result = (await client.callTool({
      name: "memory_first_block",
      arguments: { action: "list" },
    })) as McpContent;
    const blockText = result.content.slice(1).map((c) => c.text).join("");

    expect(blockText).toContain("Stages you can recognize (ask stage_lookup): ");
    expect(blockText).toContain("stage-00");
    expect(blockText).toContain("(+3 more)"); // 18 stages, 15 shown, 3 in the tail
    // Sane footprint — nowhere near the 2 500-char PREWARM_BLOCK_MAX_CHARS budget on its own.
    expect(blockText.length).toBeLessThan(1_500);

    core.close();
  });

  it("'+K more' tail reports the TRUE total past STAGE_INDEX_CAP, not the retrieval-capped array length (Codex round 4, item 1)", async () => {
    const core = new MonetCore(":memory:");
    let n = 0;
    const deps = { db: raw(core) as never, newId: () => `extra-stage-${n++}`, nextSyncTimestamp: () => Date.now(), syncDeviceId: "d" };
    const db = raw(core);
    // Past STAGE_INDEX_CAP (2 000) by a recognizable margin. Raw INSERTs (not store()/declare())
    // keep this fast — the same technique gates.test.ts's own "liveStageIndex — SQL-level
    // retrieval bound" suite uses to prove the SQL cap+total arithmetic at true scale: upsertStage
    // (the real minter) plus one concept row and one rule_binding row per stage, no embedding.
    const STAGE_COUNT = STAGE_INDEX_CAP + 100;
    for (let i = 0; i < STAGE_COUNT; i++) {
      const stage = upsertStage(deps, { stage: `bulk stage ${String(i).padStart(5, "0")}`, origin: "declaration" });
      const conceptId = `bulk-concept-${i}`;
      db.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, circle, embedding)
         VALUES (?, ?, ?, ?, 'rule', 'active', 'default', '[]')`,
      ).run(conceptId, `bulk-slug-${i}`, `Bulk rule ${i}`, `Body ${i}`);
      db.prepare(
        `INSERT INTO rule_bindings (concept_id, stage_id, severity, scope, model_tag, origin, circle, created_at, sync_updated_at, sync_revision)
         VALUES (?, ?, 'advisory', 'domain', NULL, 'import', 'default', ?, ?, 0)`,
      ).run(conceptId, stage.id, Date.now(), Date.now());
    }

    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: true, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);

    const result = (await client.callTool({
      name: "memory_first_block",
      arguments: { action: "list" },
    })) as McpContent;
    const blockText = result.content.slice(1).map((c) => c.text).join("");

    expect(blockText).toContain("Stages you can recognize (ask stage_lookup): ");
    // 2 100 live stages, 15 shown (STAGE_INDEX_PREWARM_MAX_SHOWN — short names here never trip the
    // line's own byte budget first), so the HONEST tail is 2 100 - 15 = 2 085. BEFORE this fix the
    // tail was computed from the retrieval-capped array length alone (2 000), so it would have read
    // "(+1 985 more)" here regardless of how many more stages truly existed past the cap — silently
    // ignoring the 100 that SQL retrieval itself never returned at all.
    expect(blockText).toContain(`(+${STAGE_COUNT - 15} more)`);
    expect(blockText).not.toContain("(+1985 more)");

    core.close();
  }, 30_000);

  it("survives pathologically long stage names — a non-empty cue prefix with an honest '+K more' tail, not a silently vanished line (Codex round 2, item 1)", async () => {
    const core = new MonetCore(":memory:");
    // 15 stages, each named close to STAGE_NAME_MAX_CHARS (491 of 500). The OLD version joined all
    // 15 into ONE line BEFORE the lower-section fitter ran, and that fitter accepts or drops WHOLE
    // lines — so the joined line alone (15 x ~500 chars) blew far past the ~2,400-char
    // lower-section budget, and the fitter dropped the ENTIRE line: the whole recognition cue
    // silently vanished, on exactly the rich-store case the cue exists for.
    for (let i = 0; i < 15; i++) {
      const name = `stage-${String(i).padStart(2, "0")}-${"x".repeat(480)}`;
      await core.store(`Rule for stage ${i}.`, {
        kind: "rule", resolution: "forceNew", rule: { stage: name, scope: "domain" },
      });
    }

    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerMonetCoreTools(server, core, { autoPrewarm: true, checkpointNudge: false });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await client.connect(ct);

    const result = (await client.callTool({
      name: "memory_first_block",
      arguments: { action: "list" },
    })) as McpContent;
    const blockText = result.content.slice(1).map((c) => c.text).join("");

    // THE CUE IS NOT ENTIRELY ABSENT, and at least one name actually shows.
    expect(blockText).toContain("Stages you can recognize (ask stage_lookup): ");
    expect(blockText).toContain("stage-00");
    // AN ACCURATE +K TAIL: not all 15 fit at this length, and the tail says so honestly (neither
    // silently dropped nor silently wrong about how many are missing).
    const tailMatch = blockText.match(/\(\+(\d+) more\)/);
    expect(tailMatch).not.toBeNull();
    const more = Number(tailMatch![1]);
    expect(more).toBeGreaterThan(0);
    expect(more).toBeLessThan(15);
    // The block as a whole still stays within its own overall budget regardless.
    expect(blockText.length).toBeLessThanOrEqual(2_500);

    core.close();
  });
});