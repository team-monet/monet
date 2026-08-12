/**
 * PAYLOAD-NOISE CONTRACT (Tier 1) — what the read/write surface is allowed to put in an agent's
 * context window.
 *
 * Every assertion here is a measured field failure, not a style preference:
 *   • memory_checkpoint returned every dirty concept's full observation text and blew the host's
 *     tool-result limit twice in one session — a WRITE path emitting the largest payload in the
 *     system, none of which the caller asked for.
 *   • recall cards must never carry source refs — file paths and agent ids are not retrieval data.
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
        arguments: { circle, workstream: { status: "active", open: [{ kind: "step" as const, text: "continue the payload trim" }] } },
      }),
    );

    expect(wire(res)).not.toContain(evidence);
    const payload = parse(res);
    expect(payload).toEqual({
      circle,
      workstream: {
        id: expect.any(String),
        title: "continue the payload trim",
        opened: [expect.any(String)],
        closed: [],
      },
    });
    expect(payload.workstream).not.toHaveProperty("version");
    expect(payload.workstream).not.toHaveProperty("openItems");
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
      open: [{ kind: "question" as const, text: "Does the checkpoint preserve this workstream?" }, { kind: "step" as const, text: "Continue after this checkpoint." }],
    };
    // Seed the workstream before fixture SQL adds the bulk concepts; a real checkpoint updates this
    // row and therefore proves the primary contract survives under the large dirty population.
    await core.saveWorkstream({
      status: workstream.status,
      open: workstream.open.map(({ kind: slot, text }) => ({ slot, text })),
    }, { circle });
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
      second: await c.callTool({ name: "memory_checkpoint", arguments: { circle, workstream: { ...workstream } } }),
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
        workstream: {
          id: expect.any(String),
          title: "Continue after this checkpoint.",
          opened: [expect.any(String), expect.any(String)],
          closed: [],
        },
      });
      expect(payload.workstream).not.toHaveProperty("version");
      expect(payload.workstream).not.toHaveProperty("openItems");
    }
    expect(firstPayload.workstream.id).toBe(secondPayload.workstream.id);
    expect(firstPayload.workstream.opened).not.toEqual(secondPayload.workstream.opened);

    const restored = core.getActiveWorkstreams(circle).find((w) => w.id === firstPayload.workstream.id);
    expect(restored?.payload.status).toBe(workstream.status);
    // The stored form is items, not the checkpoint's input shape. Both checkpoints sent the same
    // two, and merge does not deduplicate by text, so the survivor carries both rounds — the
    // contract this test guards is that the row survives the dirty population, not the count.
    expect(restored?.payload.items.filter((i) => i.state === "open").map((i) => i.text))
      .toEqual(expect.arrayContaining(workstream.open.map((o) => o.text)));
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

describe("payload noise — agent_context", () => {
  it("delivers open counts only when nonzero", async () => {
    const empty = newCore();
    const emptyPayload = await withServer(empty, async (client) => parse(
      await client.callTool({ name: "agent_context", arguments: { circle } }),
    ));
    expect(emptyPayload).not.toHaveProperty("open");
    empty.close();

    const core = newCore();
    await core.saveWorkstream({ title: "Open thread", status: "active" }, { circle });
    await core.captureFind("open find", { circle });
    const payload = await withServer(core, async (client) => parse(
      await client.callTool({ name: "agent_context", arguments: { circle } }),
    ));
    expect(payload.open).toEqual({ workstreams: 1, inboxItems: 1 });
    core.close();
  });

  it("auto-prewarm mirrors nonzero open counts", async () => {
    const core = newCore();
    await core.saveWorkstream({ title: "Open thread", status: "active" }, { circle });
    await core.captureFind("open find", { circle });
    const server = new McpServer({ name: "prewarm-open-test", version: "1" });
    registerMonetCoreTools(server, core, { autoPrewarm: true, checkpointNudge: false });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "prewarm-open-client", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "memory_search",
        arguments: { query: "anything", circle },
      }) as ToolResult;
      expect(result.content.slice(1).map((part) => part.text).join("\n"))
        .toContain("open: 1 workstreams · 1 inbox items");
    } finally {
      await client.close();
      await server.close();
      core.close();
    }
  });

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
