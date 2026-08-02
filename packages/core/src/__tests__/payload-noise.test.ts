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
import { ok, registerMonetCoreTools } from "../mcp-server";
import { BetterSqlitePort } from "../storage";

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
  it("returns only the session-state acknowledgement, never stored evidence or curation state", async () => {
    const core = newCore();
    const evidence = "Postgres beat DynamoDB here because the reporting path is join-heavy.";
    await core.store(evidence, { circle });

    const res = await withServer(core, (c) =>
      c.callTool({
        name: "memory_checkpoint",
        arguments: { circle, workstream: { status: "active", nextSteps: ["continue the payload trim"] } },
      }),
    );

    expect(wire(res)).not.toContain(evidence);
    expect(parse(res)).toEqual({
      circle,
      workstream: expect.objectContaining({ id: expect.any(String), status: "active", version: expect.any(Number) }),
    });
    core.close();
  });

  it("keeps a 200+ dirty-concept checkpoint parseable and limited to the workstream ack", async () => {
    const store = new BetterSqlitePort(":memory:");
    const core = new MonetCore(store, { deferCreatedPin: true });
    const totalDirty = 205;
    const conceptInsert = store.prepare(`
      INSERT INTO concepts (id, slug, title, body, embedding, dirty, circle)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `);
    const observationInsert = store.prepare(`
      INSERT INTO observations (id, content, embedding, concept_id, author_agent_id, circle)
      VALUES (?, ?, ?, ?, 'checkpoint-fixture', ?)
    `);
    const workstream = {
      status: "active" as const,
      openQuestions: ["Does the checkpoint preserve this workstream?"],
      decisions: ["Synthesis debt is ordered by evidence volume."],
      nextSteps: ["Continue after this checkpoint."],
    };
    // Seed the workstream before fixture SQL adds the bulk concepts; a real checkpoint updates this
    // row and therefore proves the primary contract survives under the large dirty population.
    await core.saveWorkstream(workstream, { circle });
    const fixtureEmbedding = JSON.stringify(Array(256).fill(0));
    store.transaction(() => {
      for (let n = 0; n < totalDirty; n++) {
        const conceptId = `dirty-${String(n).padStart(3, "0")}`;
        conceptInsert.run(conceptId, conceptId, `Dirty concept ${n}`, `Body ${n}`, fixtureEmbedding, circle);
        const observationCount = n < 25 ? 3 : n < 100 ? 2 : 1;
        for (let obs = 0; obs < observationCount; obs++) {
          observationInsert.run(`${conceptId}-obs-${obs}`, `Evidence ${n}/${obs}`, fixtureEmbedding, conceptId, circle);
        }
      }
    })();

    const { first, second } = await withServer(core, async (c) => ({
      first: await c.callTool({ name: "memory_checkpoint", arguments: { circle, workstream } }),
      second: await c.callTool({ name: "memory_checkpoint", arguments: { circle, workstream: { ...workstream, decisions: ["A stable replay updates the same workstream."] } } }),
    }));

    const firstText = (first as ToolResult).content[0]!.text;
    const secondText = (second as ToolResult).content[0]!.text;
    if ((first as { isError?: boolean }).isError || (second as { isError?: boolean }).isError) {
      throw new Error(`checkpoint fixture failed: first=${firstText}; second=${secondText}`);
    }
    expect(firstText.length).toBeLessThanOrEqual(40_000);
    expect(secondText.length).toBeLessThanOrEqual(40_000);
    const firstPayload = JSON.parse(firstText);
    const secondPayload = JSON.parse(secondText);
    for (const payload of [firstPayload, secondPayload]) {
      expect(payload).not.toHaveProperty("dirty");
      expect(payload).not.toHaveProperty("dirtyCount");
      expect(payload).not.toHaveProperty("dirtyTruncated");
      expect(payload).not.toHaveProperty("dirtyOmitted");
      expect(payload).toEqual({
        circle,
        workstream: expect.objectContaining({
          id: expect.any(String),
          status: workstream.status,
          version: expect.any(Number),
        }),
      });
    }
    expect(firstPayload.workstream.id).toBe(secondPayload.workstream.id);
    expect(secondPayload.workstream.version).toBeGreaterThan(firstPayload.workstream.version);

    const restored = core.getActiveWorkstreams(circle).find((w) => w.id === firstPayload.workstream.id);
    expect(restored?.payload).toMatchObject({
      status: workstream.status,
      openQuestions: workstream.openQuestions,
      decisions: ["A stable replay updates the same workstream."],
      nextSteps: workstream.nextSteps,
    });
    core.close();
  });
});

// Cross-tool defense: per-tool fitters should prevent this path, but no successful tool may ever
// produce the old raw mid-string slice when a future or synthetic payload escapes those fitters.
describe("payload noise — canonical success serializer", () => {
  it("keeps an ordinary payload byte-identical to the established pretty-printed JSON", () => {
    const payload = { status: "ok", items: [1, 2, 3] };
    const result = ok(payload);
    expect((result.content[0] as { type: "text"; text: string }).text)
      .toBe(JSON.stringify(payload, null, 2));
  });

  it("degrades a synthetic oversized payload to a valid JSON envelope under the ceiling", () => {
    const result = ok({ payload: "x".repeat(50_000) });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text.length).toBeLessThanOrEqual(40_000);
    expect(JSON.parse(text)).toEqual({
      truncated: true,
      originalChars: 50_019,
      note: "Result exceeded the host tool-result limit; the original payload was omitted.",
    });
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
  it("never delivers stale state", async () => {
    const core = newCore({ staleAfterMs: 5 });
    await core.store("Retries use exponential backoff capped at thirty seconds.", { circle });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const restored = await withServer(core, (c) =>
      c.callTool({ name: "agent_context", arguments: { circle } }),
    );

    const payload = parse(restored);
    expect(payload).not.toHaveProperty("staleConcepts");
    expect(payload).not.toHaveProperty("staleCount");
    core.close();
  });
});

describe("payload noise — memory_fetch body vs observations", () => {
  it("keeps observations absent by default even when the body is truncated", async () => {
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
          await c.callTool({ name: "memory_fetch", arguments: { id: stored.conceptId, circle, observations: true } }),
        ),
      };
    });

    expect(byDefault.bodyTruncated).toBe(true);
    expect(byDefault.body).toBeTruthy();
    expect(byDefault).not.toHaveProperty("observations");
    expect(byDefault).not.toHaveProperty("observationsOffset");
    expect(JSON.stringify(byDefault)).not.toContain(evidence);

    expect(evidenceView.bodyTruncated).toBe(true);
    expect(evidenceView.body).toBeTruthy();
    expect(evidenceView.observations).toHaveLength(1);
    expect(evidenceView.observationsOffset).toBe(0);
    expect(JSON.stringify(evidenceView)).toContain(evidence);
    core.close();
  });

  it("keeps observations absent by default when the body fits", async () => {
    const core = newCore();
    const stored = await core.store("Feature flags are evaluated once per request.", { circle });

    const fetched = await withServer(core, async (c) => {
      await c.callTool({ name: "memory_synthesize", arguments: { id: stored.conceptId, body: "Short durable claim.", circle } });
      return parse(await c.callTool({ name: "memory_fetch", arguments: { id: stored.conceptId, circle } }));
    });

    expect(fetched).not.toHaveProperty("bodyTruncated");
    expect(fetched.body).toBe("Short durable claim.");
    expect(fetched).not.toHaveProperty("observations");
    expect(fetched).not.toHaveProperty("observationsOffset");
    core.close();
  });
});
