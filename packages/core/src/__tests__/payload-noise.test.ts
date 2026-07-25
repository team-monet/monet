/**
 * PAYLOAD-NOISE CONTRACT (Tier 1) — what the read/write surface is allowed to put in an agent's
 * context window.
 *
 * Every assertion here is a measured field failure, not a style preference:
 *   • memory_checkpoint returned every dirty concept's full observation text and blew the host's
 *     tool-result limit twice in one session — a WRITE path emitting the largest payload in the
 *     system, none of which the caller asked for.
 *   • gather cards carried up to 20 source refs each (one card's true total was 255) — file paths
 *     and agent ids, never consumed.
 *   • agent_context returned 20 staleConcepts on session restore; zero were used.
 *   • memory_fetch truncated a 191K-char body and then still appended a page of newest-first
 *     observations — cutting the durable synthesized claim to pay for tactical churn.
 *
 * The shared shape of all four: the read path optimized RECALL over SELECTION — returning
 * everything it had rather than what the caller needed.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";

const circle = "noise-circle";
/** tauAttach/tauAmbiguous > 1 keeps every store() a distinct concept, so counts are predictable. */
const newCore = (opts: Record<string, unknown> = {}) =>
  new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, ...opts });

type ToolResult = { content: Array<{ type: string; text: string }> };

async function withServer<T>(core: MonetCore, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer({ name: "payload-noise-test", version: "1" });
  registerMonetCoreTools(server, core, { autoPrewarm: false, checkpointNudge: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "payload-noise-client", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const parse = (r: unknown) => JSON.parse((r as ToolResult).content[0]!.text);
/** Every text part joined — catches a leak hiding in a part the structured parse ignores. */
const wire = (r: unknown) => (r as ToolResult).content.map((p) => p.text).join("\n");

describe("payload noise — memory_checkpoint", () => {
  it("returns the dirty list as a worklist (id/title/count), never observation text", async () => {
    const core = newCore();
    const evidence = "Postgres beat DynamoDB here because the reporting path is join-heavy.";
    await core.store(evidence, { circle });

    const res = await withServer(core, (c) =>
      c.callTool({
        name: "memory_checkpoint",
        arguments: { circle, workstream: { status: "active", nextSteps: ["continue the payload trim"] } },
      }),
    );

    // The load-bearing assertion first: a checkpoint must never carry the evidence itself.
    expect(wire(res)).not.toContain(evidence);

    const payload = parse(res);
    expect(payload.dirtyCount).toBeGreaterThan(0);
    expect(payload.dirty[0]).not.toHaveProperty("observations");
    expect(payload.dirty[0].id).toBeTruthy();
    expect(payload.dirty[0].title).toBeTruthy();
    expect(payload.dirty[0].observationCount).toBeGreaterThan(0);
    core.close();
  });
});

describe("payload noise — gather cards", () => {
  it("carries a source-ref count and never the refs themselves", async () => {
    const core = newCore();
    const ref = "/work/secret-project/DESIGN.md";
    await core.store("Cache invalidation uses a per-tenant version stamp.", { circle, sourceRefs: [ref] });

    const res = await withServer(core, (c) =>
      c.callTool({ name: "memory_gather", arguments: { intent: "cache invalidation", circle } }),
    );

    expect(wire(res)).not.toContain(ref);
    const payload = parse(res);
    const card = [...payload.ranked, ...payload.seed].find((x: { sourceRefsCount?: number }) => x.sourceRefsCount !== undefined);
    expect(card, "the stored concept should surface with a ref count").toBeDefined();
    expect(card.sourceRefsCount).toBe(1);
    expect(card).not.toHaveProperty("sourceRefs");
    expect(card).not.toHaveProperty("sourceRefsTotal");
    core.close();
  });
});

describe("payload noise — agent_context", () => {
  it("omits staleConcepts by default, carries staleCount, and returns them on request", async () => {
    const core = newCore({ staleAfterMs: 5 });
    const staleTitle = "Retries use exponential backoff capped at thirty seconds.";
    await core.store(staleTitle, { circle });
    await new Promise((resolve) => setTimeout(resolve, 30)); // cross the 5ms staleness window

    const { byDefault, onRequest } = await withServer(core, async (c) => ({
      byDefault: await c.callTool({ name: "agent_context", arguments: { circle } }),
      onRequest: await c.callTool({ name: "agent_context", arguments: { circle, includeStale: true } }),
    }));

    const restored = parse(byDefault);
    expect(restored).not.toHaveProperty("staleConcepts");
    expect(restored.staleCount).toBeGreaterThan(0);

    const curating = parse(onRequest);
    expect(Array.isArray(curating.staleConcepts)).toBe(true);
    expect(curating.staleConcepts.length).toBeGreaterThan(0);
    expect(curating.staleCount).toBe(restored.staleCount);
    core.close();
  });

  it("carries staleCount even when it is zero (Codex P2)", async () => {
    // The contract says the field is always present. Omitting it at zero makes "no stale concepts"
    // indistinguishable from "server predates the field", so a consumer cannot read it as a number.
    const core = newCore({ staleAfterMs: 10 * 60 * 1000 }); // nothing can go stale inside the test
    await core.store("Feature flags are evaluated once per request.", { circle });

    const restored = await withServer(core, (c) =>
      c.callTool({ name: "agent_context", arguments: { circle } }).then(parse),
    );

    expect(restored).toHaveProperty("staleCount");
    expect(restored.staleCount).toBe(0);
    core.close();
  });
});

describe("payload noise — memory_fetch body vs observations", () => {
  it("sends the body OR the observations once the body is truncated, never both", async () => {
    const core = newCore();
    const evidence = "Rollback drill on 2026-03-02 took forty-one minutes end to end.";
    const stored = await core.store(evidence, { circle });
    // FETCH_BODY_MAX_CHARS is 6_000; 10_000 guarantees the clip.
    const longBody = "Durable synthesized claim. ".repeat(400);
    expect(longBody.length).toBeGreaterThan(6_000);

    const { byDefault, evidenceView } = await withServer(core, async (c) => {
      await c.callTool({ name: "memory_synthesize", arguments: { id: stored.conceptId, body: longBody, circle } });
      return {
        byDefault: parse(await c.callTool({ name: "memory_fetch", arguments: { id: stored.conceptId, circle } })),
        evidenceView: parse(
          await c.callTool({ name: "memory_fetch", arguments: { id: stored.conceptId, circle, includeBody: false } }),
        ),
      };
    });

    // Default view: the durable claim, and nothing else.
    expect(byDefault.bodyTruncated).toBe(true);
    expect(byDefault.body).toBeTruthy();
    expect(byDefault).not.toHaveProperty("observations");
    expect(byDefault.totalObservations).toBeGreaterThan(0);
    expect(byDefault.observationsNote).toMatch(/includeBody:false/);
    expect(JSON.stringify(byDefault)).not.toContain(evidence);

    // Opt-in view: the evidence, and not the body it would have displaced.
    expect(evidenceView.bodyOmitted).toBe(true);
    expect(evidenceView).not.toHaveProperty("body");
    expect(evidenceView.observations.length).toBeGreaterThan(0);
    expect(JSON.stringify(evidenceView)).toContain(evidence);
    core.close();
  });

  it("keeps a clipped-body dirty concept synthesizable instead of stranding it (Codex P2)", async () => {
    // The trim withholds observations when the body is clipped. For a DIRTY concept whose evidence
    // would nonetheless fit one page, the response must still route to synthesis — naming the one
    // re-fetch that exposes it — rather than to the permanent "leave it dirty" defer. Getting this
    // wrong makes the checkpoint worklist unworkable and deepens the synthesis debt.
    const core = newCore();
    const stored = await core.store("Blue-green cutover needs the drain step before the flip.", { circle });
    // A long body that is ALSO still dirty: synthesize, then attach new evidence.
    const longBody = "Durable synthesized claim. ".repeat(400);
    await core.applySynthesis(stored.conceptId, longBody);
    await core.store("Follow-up: the drain step timed out once at 90s.", { circle, attachTo: stored.conceptId });

    const fetched = await withServer(core, (c) =>
      c.callTool({ name: "memory_fetch", arguments: { id: stored.conceptId, circle } }).then(parse),
    );

    expect(fetched.needsSynthesis).toBe(true);
    expect(fetched.bodyTruncated).toBe(true);
    expect(fetched).not.toHaveProperty("observations");
    expect(fetched.totalObservations).toBeLessThanOrEqual(20);
    // Actionable, not abandoned.
    expect(fetched).not.toHaveProperty("synthesisDeferred");
    expect(fetched.synthesisInstruction).toMatch(/includeBody:false/);
    core.close();
  });

  it("still sends both when the body fits — the trim is triggered by truncation, not by default", async () => {
    const core = newCore();
    const stored = await core.store("Feature flags are evaluated once per request.", { circle });

    const fetched = await withServer(core, async (c) => {
      await c.callTool({ name: "memory_synthesize", arguments: { id: stored.conceptId, body: "Short durable claim.", circle } });
      return parse(await c.callTool({ name: "memory_fetch", arguments: { id: stored.conceptId, circle } }));
    });

    expect(fetched).not.toHaveProperty("bodyTruncated");
    expect(fetched.body).toBe("Short durable claim.");
    expect(fetched.observations.length).toBeGreaterThan(0);
    core.close();
  });
});
