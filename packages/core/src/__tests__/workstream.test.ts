import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonetCore } from "../engine";
import { BREADTH_CIRCLE } from "../gates";
import { registerMonetCoreTools } from "../mcp-server";
import { BetterSqlitePort } from "../storage";
import type { EmbeddingProvider } from "../embedding";
import type { PragmaOptions, Statement, StoragePort } from "../storage";

/** Open item texts for a slot — the post-#131 shape of what these assertions used to read directly. */
const openTexts = (payload: { items: Array<{ slot: string; text: string; state: string }> }, slot: "question" | "step"): string[] =>
  payload.items.filter((i) => i.state === "open" && i.slot === slot).map((i) => i.text);


function rawDb(core: MonetCore): StoragePort {
  return (core as unknown as { db: StoragePort }).db;
}

async function withWorkstreamServer<T>(
  core: MonetCore,
  fn: (client: Client) => Promise<T>,
  opts: { autoPrewarm?: boolean } = {},
): Promise<T> {
  const server = new McpServer({ name: "workstream-tool-test", version: "1" });
  registerMonetCoreTools(server, core, { autoPrewarm: opts.autoPrewarm ?? false, checkpointNudge: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "workstream-tool-client", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function toolJson(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
}

function toolExtraText(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.slice(1).map((item) => item.text).join("\n");
}

class StaticEmbeddingProvider implements EmbeddingProvider {
  readonly dim = 2;
  readonly modelId = "test:static";

  embed(): Float32Array {
    return new Float32Array([1, 0]);
  }
}

class BarrierEmbeddingProvider implements EmbeddingProvider {
  readonly dim = 2;
  readonly modelId = "test:barrier";
  private waiting = 0;
  private release: (() => void) | null = null;
  private readonly released: Promise<void>;

  constructor(private readonly expected: number) {
    this.released = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async embed(): Promise<Float32Array> {
    this.waiting += 1;
    if (this.waiting === this.expected) this.release?.();
    await this.released;
    return new Float32Array([1, 0]);
  }
}

class InterleavingPort implements StoragePort {
  private readonly inner: BetterSqlitePort;
  private beforeNextTransaction: (() => void) | null = null;
  private afterNextImmediateTransaction: (() => void) | null = null;

  constructor() {
    this.inner = new BetterSqlitePort(":memory:");
  }

  armBeforeNextTransaction(callback: () => void): void {
    this.beforeNextTransaction = callback;
  }

  armAfterNextImmediateTransaction(callback: () => void): void {
    this.afterNextImmediateTransaction = callback;
  }

  prepare(sql: string): Statement {
    return this.inner.prepare(sql);
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  pragma(source: string, options?: PragmaOptions): unknown {
    return this.inner.pragma(source, options);
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const tx = this.inner.transaction(fn);
    return (...args: A): R => {
      this.fireInterleavingHook();
      return tx(...args);
    };
  }

  immediateTransaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const tx = this.inner.immediateTransaction(fn);
    return (...args: A): R => {
      this.fireInterleavingHook();
      const result = tx(...args);
      this.fireAfterImmediateTransactionHook();
      return result;
    };
  }

  acquireExclusiveOwnership(): void {
    this.inner.acquireExclusiveOwnership();
  }

  releaseExclusiveOwnership(): void {
    this.inner.releaseExclusiveOwnership();
  }

  close(): void {
    this.inner.close();
  }

  private fireInterleavingHook(): void {
    const callback = this.beforeNextTransaction;
    if (!callback) return;
    this.beforeNextTransaction = null;
    callback();
  }

  private fireAfterImmediateTransactionHook(): void {
    const callback = this.afterNextImmediateTransaction;
    if (!callback) return;
    this.afterNextImmediateTransaction = null;
    callback();
  }
}

function insertWorkstreamRow(
  db: StoragePort,
  row: {
    id: string;
    circle: string;
    status?: "active" | "archived";
    payloadStatus?: "active" | "paused" | "done";
    version?: number;
    updatedAt?: number;
    nextStep?: string;
    slug?: string;
  },
): void {
  const payload = {
    status: row.payloadStatus ?? "active",
    nextSteps: row.nextStep ? [row.nextStep] : undefined,
  };
  const body = JSON.stringify(payload, null, 2);
  db.prepare(
    `INSERT INTO concepts (id, slug, title, body, kind, status, embedding, support_count, version, dirty, circle, updated_at)
     VALUES (?, ?, ?, ?, 'workstream', ?, ?, 1, ?, 0, ?, ?)`,
  ).run(
    row.id,
    row.slug ?? `workstream:${row.circle}`,
    `workstream: ${row.id}`,
    body,
    row.status ?? "active",
    "[1,0]",
    row.version ?? 0,
    row.circle,
    row.updatedAt ?? 1,
  );
  db.prepare(`UPDATE concepts SET updated_at = ? WHERE id = ?`).run(row.updatedAt ?? 1, row.id);
  db.prepare(
    `INSERT INTO concept_revisions (id, concept_id, version, body, trigger_observation_id)
     VALUES (?, ?, ?, ?, NULL)`,
  ).run(`rev-${row.id}`, row.id, row.version ?? 0, body);
}

function updateWorkstreamRow(
  db: StoragePort,
  row: {
    id: string;
    version: number;
    updatedAt: number;
    nextStep: string;
  },
): void {
  const payload = {
    status: "active",
    nextSteps: [row.nextStep],
  };
  const body = JSON.stringify(payload, null, 2);
  db.prepare(`UPDATE concepts SET body = ?, version = ?, updated_at = ? WHERE id = ?`).run(
    body,
    row.version,
    row.updatedAt,
    row.id,
  );
  db.prepare(
    `INSERT INTO concept_revisions (id, concept_id, version, body, trigger_observation_id)
     VALUES (?, ?, ?, ?, NULL)`,
  ).run(`rev-${row.id}-${row.version}`, row.id, row.version, body);
}

function workstreamRows(db: StoragePort, circle: string): Array<{ id: string; version: number; body: string }> {
  return db.prepare(
    `SELECT id, version, body FROM concepts
      WHERE circle = ? AND kind = 'workstream' AND source_identity IS NULL AND active_observation_id IS NULL
      ORDER BY id`,
  ).all(circle) as Array<{ id: string; version: number; body: string }>;
}

function revisionVersions(db: StoragePort, conceptId: string): number[] {
  return (db.prepare(
    `SELECT version FROM concept_revisions WHERE concept_id = ? ORDER BY version ASC`,
  ).all(conceptId) as Array<{ version: number }>).map((row) => row.version);
}

function workstreamStatuses(db: StoragePort, circle: string): Array<{ id: string; status: string; updatedAt: number }> {
  return (db.prepare(
    `SELECT id, status, updated_at FROM concepts
      WHERE circle = ? AND kind = 'workstream' AND source_identity IS NULL AND active_observation_id IS NULL
      ORDER BY id`,
  ).all(circle) as Array<{ id: string; status: string; updated_at: number }>)
    .map((row) => ({ id: row.id, status: row.status, updatedAt: row.updated_at }));
}

describe("memory_workstreams MCP tool", () => {
  it("suppresses auto-prewarm for default and explicit-circle continuation pulls", async () => {
    for (const { args, stage } of [
      { args: {}, stage: "default continuation stage" },
      { args: { circle: "explicit" }, stage: "explicit continuation stage" },
    ]) {
      const core = new MonetCore(":memory:");
      await core.store(`Rule for ${stage}.`, {
        circle: "circle" in args ? args.circle : "default",
        kind: "rule",
        rule: { stage, scope: "domain" },
      });
      const result = await withWorkstreamServer(
        core,
        (client) => client.callTool({ name: "memory_workstreams", arguments: args }),
        { autoPrewarm: true },
      );
      expect(toolExtraText(result)).toBe("");
      core.close();
    }
  });

  it("keeps sibling memory_search auto-prewarm enabled as the control", async () => {
    const core = new MonetCore(":memory:");
    await core.store("Check the control stage before continuing.", {
      kind: "rule",
      rule: { stage: "control search stage", scope: "domain" },
    });
    const result = await withWorkstreamServer(
      core,
      (client) => client.callTool({ name: "memory_search", arguments: { query: "control" } }),
      { autoPrewarm: true },
    );
    expect(toolExtraText(result)).toContain("Stages you can recognize (ask stage_lookup): control search stage");
    core.close();
  });

  it("lists only id, title, and status, then returns full detail for one id", async () => {
    const core = new MonetCore(":memory:");
    const saved = await core.saveWorkstream({
      status: "paused",
      open: [{ slot: "question" as const, text: "Which threshold should move?" }, { slot: "step" as const, text: "Run the serial suite." }],
    });

    const { list, detail } = await withWorkstreamServer(core, async (client) => ({
      list: toolJson(await client.callTool({ name: "memory_workstreams", arguments: {} })),
      detail: toolJson(await client.callTool({ name: "memory_workstreams", arguments: { id: saved!.id } })),
    }));

    expect(list).toEqual({ workstreams: [{ id: saved!.id, title: saved!.title, status: "paused" }] });
    // Detail is the OPEN working set, questions before steps, each carrying the id that
    // memory_checkpoint's `close` takes. `lastSessionId` is not delivered — nothing acts on it.
    expect(detail).toEqual({
      id: saved!.id,
      title: saved!.title,
      status: "paused",
      openItems: 2,
      items: saved!.payload.items.map((item) => ({ id: item.id, slot: item.slot, text: item.text })),
    });
    expect(JSON.stringify(list)).not.toContain("Which threshold should move?");
    core.close();
  });

  it("walks fat detail pages without gaps or duplicates, questions before steps", async () => {
    const core = new MonetCore(":memory:");
    const open = [
      ...Array.from({ length: 10 }, (_, i) => ({ slot: "question" as const, text: `question-${i}-${"q".repeat(1_500)}` })),
      ...Array.from({ length: 10 }, (_, i) => ({ slot: "step" as const, text: `step-${i}-${"s".repeat(1_500)}` })),
    ];
    const saved = await core.saveWorkstream({ status: "active", open });

    const recovered: Array<{ slot: string; text: string }> = [];
    await withWorkstreamServer(core, async (client) => {
      let detailOffset = 0;
      do {
        const detail = toolJson(await client.callTool({
          name: "memory_workstreams",
          arguments: { id: saved!.id, detailOffset },
        }));
        const page = (detail.items as Array<{ slot: string; text: string }>) ?? [];
        expect(page.length).toBeGreaterThan(0);
        recovered.push(...page.map(({ slot, text }) => ({ slot, text })));
        detailOffset += page.length;
        if (detail.detailOmitted === undefined) break;
        expect(detail.detailOmitted).toBe(open.length - detailOffset);
      } while (true);
    });

    // Every item exactly once, in the documented order: questions first, then steps, each in the
    // order it was opened. Paging must not lose or repeat one across the boundary.
    expect(recovered).toEqual(open.map(({ slot, text }) => ({ slot, text })));
    core.close();
  });

  it("delivers one oversized entry alone with clipping and an honest continuation offset", async () => {
    const core = new MonetCore(":memory:");
    const oversized = `oversized-${"z".repeat(80_000)}`;
    const saved = await core.saveWorkstream({
      status: "active",
      open: [
        { slot: "question" as const, text: oversized },
        { slot: "step" as const, text: "recover me next" },
      ],
    });

    const first = await withWorkstreamServer(core, (client) =>
      client.callTool({ name: "memory_workstreams", arguments: { id: saved!.id, detailOffset: 0 } }),
    ) as { content: Array<{ text: string }> };
    const firstDetail = toolJson(first);
    expect(first.content[0]!.text.length).toBeLessThanOrEqual(40_000);
    expect((firstDetail.items as unknown[])).toHaveLength(1);
    expect(((firstDetail.items as Array<{ text: string }>)[0]!).text).toContain("…[truncated");
    expect(firstDetail).toMatchObject({
      detailOffset: 0,
      detailTruncated: true,
      detailValuesClipped: true,
      detailOmitted: 1,
    });

    const second = await withWorkstreamServer(core, (client) =>
      client.callTool({ name: "memory_workstreams", arguments: { id: saved!.id, detailOffset: 1 } }),
    );
    expect(toolJson(second)).toMatchObject({
      detailOffset: 1,
      items: [{ slot: "step", text: "recover me next" }],
    });
    core.close();
  });

  it("keeps offset-zero default behavior unchanged for small details", async () => {
    const core = new MonetCore(":memory:");
    const saved = await core.saveWorkstream({
      status: "active",
      open: [{ slot: "question" as const, text: "small question" }, { slot: "step" as const, text: "small step" }],
    });
    const detail = await withWorkstreamServer(core, (client) =>
      client.callTool({ name: "memory_workstreams", arguments: { id: saved!.id } }),
    );
    expect(toolJson(detail)).toEqual({
      id: saved!.id,
      title: saved!.title,
      status: "active",
      openItems: 2,
      items: saved!.payload.items.map((item) => ({ id: item.id, slot: item.slot, text: item.text })),
    });
    core.close();
  });

  it("refuses a pre-#131 checkpoint instead of silently discarding it", async () => {
    // Codex P2 on PR #149: Zod strips unknown keys by default, so a caller still sending
    // openQuestions/nextSteps got a SUCCESS back with openItems: 0 and its whole checkpoint gone.
    const core = new MonetCore(":memory:");
    const result = await withWorkstreamServer(core, (client) =>
      client.callTool({
        name: "memory_checkpoint",
        arguments: { workstream: { status: "active", nextSteps: ["legacy shape"] } },
      }),
    ) as { isError?: boolean; content: Array<{ text: string }> };
    expect(JSON.stringify(result)).toMatch(/nextSteps/);
    expect(core.getActiveWorkstreams()).toHaveLength(0); // nothing was written
    core.close();
  });

  it("opening items revives a done workstream instead of dead-ending", async () => {
    // Codex round 2 on PR #149, and a dead end the round-1 guard created: a finished workstream
    // kept status 'done', a later checkpoint that opened follow-up work inherited it, the guard
    // then refused — and done workstreams are filtered out of memory_workstreams, so the caller
    // could not even see the status it was inheriting.
    const core = new MonetCore(":memory:");
    const first = await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "ship it" }] });
    await core.saveWorkstream({ status: "done", close: [{ id: first!.payload.items[0]!.id, as: "done" }] });
    expect(core.getActiveWorkstreams()).toHaveLength(0);

    const revived = await core.saveWorkstream({ open: [{ slot: "step" as const, text: "follow-up work" }] });
    expect(revived!.payload.status).toBe("active");
    expect(core.getActiveWorkstreams()).toHaveLength(1);
    expect(openTexts(revived!.payload, "step")).toEqual(["follow-up work"]);

    // An EXPLICIT done alongside open is still refused — reviving fills in a status the caller
    // did not state, it does not overrule one they did.
    await expect(
      core.saveWorkstream({ status: "done", open: [{ slot: "step" as const, text: "contradiction" }] }),
    ).rejects.toThrow(/still open/);
    core.close();
  });

  it("refuses a WorkstreamPayload where a checkpoint belongs", async () => {
    // Codex round 2: every checkpoint field is optional, so a payload variable satisfies the type
    // structurally and would write nothing while reporting success. `items?: never` stops TypeScript
    // callers; this refusal covers JavaScript ones.
    const core = new MonetCore(":memory:");
    await expect(
      core.saveWorkstream({ status: "active", items: [] } as unknown as Parameters<MonetCore["saveWorkstream"]>[0]),
    ).rejects.toThrow(/takes a checkpoint/);
    expect(core.getActiveWorkstreams()).toHaveLength(0);
    core.close();
  });

  it("the checkpoint receipt names the ids it actually closed", async () => {
    // Codex round 2: a close against an id this circle's row does not hold is a no-op by design
    // (stale ids, concurrency). A bare success reports that as done.
    const core = new MonetCore(":memory:");
    const opened = await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "real item" }] });
    const realId = opened!.payload.items[0]!.id;

    const ack = await withWorkstreamServer(core, (client) =>
      client.callTool({
        name: "memory_checkpoint",
        arguments: { workstream: { close: [{ id: realId, as: "done" }, { id: "not-in-this-row", as: "done" }] } },
      }),
    );
    expect(toolJson(ack).workstream).toMatchObject({ openItems: 0, closed: [realId] });
    core.close();
  });

  it("a legacy 'done' row that carried items stays reachable", async () => {
    // Codex on PR #152, and live: 5 of the 11 workstreams in the real store are `done` with items
    // still in their legacy slots — 7 items that migrating verbatim would hide behind
    // getActiveWorkstreams' done filter. #131's defect surviving the change that fixes #131.
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    db.prepare(
      `INSERT INTO concepts (id, slug, title, body, kind, status, embedding, support_count, version, dirty, circle, updated_at)
       VALUES (?, ?, ?, ?, 'workstream', 'active', ?, 1, 0, 0, ?, ?)`,
    ).run(
      "legacy-done", "workstream:legacy", "workstream: legacy",
      JSON.stringify({ status: "done", nextSteps: ["never finished"], openQuestions: ["still unanswered"] }),
      "[1,0]", "legacy", 1,
    );

    const restored = core.getActiveWorkstreams("legacy");
    expect(restored).toHaveLength(1); // not filtered away
    expect(restored[0]!.payload.status).toBe("active"); // the status was never honest
    expect(openTexts(restored[0]!.payload, "step")).toEqual(["never finished"]);
    expect(openTexts(restored[0]!.payload, "question")).toEqual(["still unanswered"]);
    core.close();
  });

  it("refuses legacy checkpoint fields from a direct caller, not only at the MCP boundary", async () => {
    // Codex on PR #152: the strict Zod schema guards the tool, but a package caller reaches
    // saveWorkstream with nothing in between and every legacy field is silently ignored by merge.
    const core = new MonetCore(":memory:");
    await expect(
      core.saveWorkstream({ status: "active", nextSteps: ["lost"] } as unknown as Parameters<MonetCore["saveWorkstream"]>[0]),
    ).rejects.toThrow(/nextSteps is ignored/);
    expect(core.getActiveWorkstreams()).toHaveLength(0);
    core.close();
  });

  it("a close against nothing is a no-op — it neither mints a workstream nor fails", async () => {
    // Two rounds on the same line. Round 1: a stale-only close with no existing row produced an
    // empty active "workstream: session state" thread. Round 2: refusing it instead broke the
    // documented contract that an unknown close is a no-op, and skipped the caller's
    // session-ending summary with it. Nothing to write is not an error — it is `null`.
    const core = new MonetCore(":memory:");
    const result = await core.saveWorkstream(
      { close: [{ id: "stale-from-another-circle", as: "done" }] },
      { summary: "session that closed nothing" },
    );
    expect(result).toBeNull();
    expect(core.getActiveWorkstreams()).toHaveLength(0);
    core.close();
  });

  it("refuses a close disposition outside done | dropped", async () => {
    // Codex round 2 on #152: only the MCP boundary enforced the enum, so a direct caller's typo
    // persisted verbatim — hiding the item from the default view AND making every later
    // legitimate close skip it, because it was no longer `open`.
    const core = new MonetCore(":memory:");
    const opened = (await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "real" }] }))!;
    await expect(
      core.saveWorkstream({ close: [{ id: opened.payload.items[0]!.id, as: "closed" as "done" }] }),
    ).rejects.toThrow(/must be 'done' or 'dropped'/);
    expect(openTexts(core.getActiveWorkstreams()[0]!.payload, "step")).toEqual(["real"]);
    core.close();
  });

  it("includeClosed reaches a workstream that is already done", async () => {
    // Codex round 2 on #152: the id lookup searched only getActiveWorkstreams, which filters done
    // — so the workstream a caller most wants the resolved items of, the one just finished, came
    // back "not found" from the option that advertises exactly that.
    const core = new MonetCore(":memory:");
    const opened = (await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "finish me" }] }))!;
    const itemId = opened.payload.items[0]!.id;
    await core.saveWorkstream({ status: "done", close: [{ id: itemId, as: "done" }] });
    expect(core.getActiveWorkstreams()).toHaveLength(0);

    const detail = await withWorkstreamServer(core, (client) =>
      client.callTool({ name: "memory_workstreams", arguments: { id: opened.id, includeClosed: true } }),
    );
    expect(toolJson(detail)).toMatchObject({
      id: opened.id,
      items: [{ id: itemId, text: "finish me", state: "done" }],
    });
    core.close();
  });

  it("a close-only no-op never reaches the embedder", async () => {
    // Codex round 3 on #152, completing round 2's fix: returning null from inside the transaction
    // was too late, because the preview still embedded first — so an unavailable embedder turned a
    // documented no-op into `checkpoint failed` and took the session summary with it.
    let embedCalls = 0;
    const counting = new StaticEmbeddingProvider();
    const embed = counting.embed.bind(counting);
    counting.embed = () => { embedCalls += 1; return embed(); };
    const core = new MonetCore(":memory:", { embedder: counting });

    const result = await core.saveWorkstream({ close: [{ id: "stale", as: "done" }] }, { summary: "ended anyway" });
    expect(result).toBeNull();
    expect(embedCalls).toBe(0);
    core.close();
  });

  it("a close-only no-op does not resurrect an archived workstream", async () => {
    // Codex round 3 on #152: with only an archived row for the slug, existingPayload was defined,
    // so the no-op branch was skipped and the update set the row back to active — a hidden
    // archived workstream resurrected by an operation documented as a no-op.
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "arch", circle: "z", status: "archived", version: 3, updatedAt: 9, nextStep: "long gone" });

    const result = await core.saveWorkstream({ close: [{ id: "stale", as: "done" }] }, { circle: "z" });
    expect(result).toBeNull();
    expect((db.prepare(`SELECT status FROM concepts WHERE id='arch'`).get() as { status: string }).status).toBe("archived");
    expect(core.getActiveWorkstreams("z")).toHaveLength(0);
    core.close();
  });

  it("refuses an open slot outside question | step", async () => {
    const core = new MonetCore(":memory:");
    await expect(
      core.saveWorkstream({ open: [{ slot: "todo" as "step", text: "x" }] }),
    ).rejects.toThrow(/must be 'question' or 'step'/);
    core.close();
  });

  it("includeClosed does not surface an archived row by id", async () => {
    // Codex round 3 on #152: the list path treats an archived loser as gone on purpose, and
    // includeClosed is about resolved ITEMS, not about bypassing the row lifecycle.
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "arch2", circle: "z", status: "archived", version: 1, updatedAt: 5, nextStep: "hidden" });
    expect(core.getWorkstreamById("arch2", "z")).toBeUndefined();
    core.close();
  });

  it("returns a named error for an unknown id", async () => {
    const core = new MonetCore(":memory:");
    const result = await withWorkstreamServer(core, (client) =>
      client.callTool({ name: "memory_workstreams", arguments: { id: "missing-workstream" } }),
    ) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe("workstream not found: missing-workstream");
    core.close();
  });

  it("size-fits an oversized compact list to valid JSON with honest omission signals", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    for (let index = 0; index < 500; index++) {
      insertWorkstreamRow(db, {
        id: `large-${String(index).padStart(3, "0")}`,
        circle: "large",
        slug: `workstream:large-${index}`,
        nextStep: `${index}-${"x".repeat(300)}`,
      });
    }

    const result = await withWorkstreamServer(core, (client) =>
      client.callTool({ name: "memory_workstreams", arguments: { circle: "large" } }),
    ) as { content: Array<{ text: string }> };
    const text = result.content[0]!.text;
    const payload = JSON.parse(text) as {
      workstreams: Array<{ id: string; title: string; status: string }>;
      workstreamsTruncated?: boolean;
      workstreamsOmitted?: number;
    };
    expect(text.length).toBeLessThanOrEqual(40_000);
    expect(payload.workstreams.length).toBeGreaterThan(0);
    expect(payload.workstreamsTruncated).toBe(true);
    expect(payload.workstreamsOmitted).toBe(500 - payload.workstreams.length);
    expect(Object.keys(payload.workstreams[0]!)).toEqual(["id", "title", "status"]);
    core.close();
  });
});

/**
 * Session-state survival (#241, ADR §3.6/§4.3): the agent compresses a session into a
 * workstream payload at checkpoint; it survives as a single `workstream` concept that the
 * next session restores.
 */
describe("workstream + checkpoint (session-state survival, #241)", () => {
  it("saveWorkstream creates then UPDATES one concept (versioned, never dirty)", async () => {
    const core = new MonetCore(":memory:");

    const w1 = await core.saveWorkstream({
      status: "active",
      open: [{ slot: "question" as const, text: "how to tune dedup thresholds?" }, { slot: "step" as const, text: "wire prewarm" }],
    });
    expect(openTexts(w1!.payload, "question")).toEqual(["how to tune dedup thresholds?"]);
    expect(w1!.version).toBe(0);
    expect(core.isDirty(w1!.id)).toBe(false); // agent-authored → no synthesis needed

    const w2 = await core.saveWorkstream({
      status: "active",
      open: [{ slot: "step" as const, text: "wire prewarm" }, { slot: "step" as const, text: "add contradiction tier" }],
    });
    expect(w2!.id).toBe(w1!.id); // same workstream, updated in place
    expect(w2!.version).toBe(1);
    // MERGE, NOT REPLACE (#131). The second checkpoint never mentioned the question, and the
    // question is still open — that is the whole behavioural change. Before the cut this same
    // write would have destroyed it.
    expect(openTexts(w2!.payload, "question")).toEqual(["how to tune dedup thresholds?"]);
    // "wire prewarm" was re-sent, so it is a NEW item: re-typing an open item mints a duplicate
    // rather than matching it, which is why callers are told not to carry items forward.
    expect(openTexts(w2!.payload, "step")).toEqual(["wire prewarm", "wire prewarm", "add contradiction tier"]);
    expect(core.getActiveWorkstreams()).toHaveLength(1);

    core.close();
  });

  /**
   * THE 12th CIRCLE-MINTING SURFACE (Codex round 7, item 4; BREADTH_CIRCLE's own comment, gates.ts).
   * A workstream is a concept like any other (kind='workstream') — it has no more business landing
   * in circle '*' than a fact or a rule's own concept does. `saveWorkstream`'s own `opts.circle` had
   * no guard of its own before this fix: a direct '*' argument sailed straight through
   * resolveCircle (a plain passthrough for unmatched input) into the concept it creates or updates.
   */
  it("refuses to save a workstream into circle '*' — the reserved global-breadth marker, never a circle a concept can live in", async () => {
    const core = new MonetCore(":memory:");
    await expect(
      core.saveWorkstream(
        { status: "active", open: [] },
        { circle: BREADTH_CIRCLE },
      ),
    ).rejects.toThrow(/reserved global-breadth marker/);
    expect(core.getActiveWorkstreams()).toHaveLength(0);
    core.close();
  });

  it("re-reads the canonical workstream inside the write transaction before writing", async () => {
    const port = new InterleavingPort();
    const core = new MonetCore(port, { embedder: new StaticEmbeddingProvider() });
    port.armBeforeNextTransaction(() => {
      insertWorkstreamRow(port, {
        id: "interleaved",
        circle: "race",
        version: 0,
        updatedAt: 100,
        nextStep: "interleaved write",
      });
    });

    const saved = await core.saveWorkstream(
      { status: "active", open: [{ slot: "step" as const, text: "caller write" }] },
      { circle: "race" },
    );

    expect(saved!.id).toBe("interleaved");
    expect(saved!.version).toBe(1);
    // The re-read inside the transaction is what makes this true (#131): before merge semantics
    // this write replaced the interleaved row's payload wholesale and the competitor's item was
    // gone. Now the merge picks it up, so BOTH survive — the race is visible instead of silent.
    expect(openTexts(saved!.payload, "step")).toEqual(["interleaved write", "caller write"]);
    expect(workstreamRows(port, "race")).toEqual([
      { id: "interleaved", version: 1, body: JSON.stringify(saved!.payload, null, 2) },
    ]);
    expect(revisionVersions(port, saved!.id)).toEqual([0, 1]);
    core.close();
  });

  it("returns the saved snapshot when a competitor updates after commit before return", async () => {
    const port = new InterleavingPort();
    const core = new MonetCore(port, { embedder: new StaticEmbeddingProvider() });
    port.armAfterNextImmediateTransaction(() => {
      const savedRow = workstreamRows(port, "snapshot")[0];
      updateWorkstreamRow(port, {
        id: savedRow.id,
        version: savedRow.version + 1,
        updatedAt: 200,
        nextStep: "competing write",
      });
    });

    const saved = await core.saveWorkstream(
      { status: "active", open: [{ slot: "step" as const, text: "caller write" }] },
      { circle: "snapshot" },
    );

    expect(saved!.version).toBe(0);
    expect(openTexts(saved!.payload, "step")).toEqual(["caller write"]);
    expect(workstreamRows(port, "snapshot")).toEqual([
      {
        id: saved!.id,
        version: 1,
        // The competitor wrote a legacy body through the fixture helper; the assertion is that
        // OUR return value is the snapshot we committed, not whatever landed after it.
        body: JSON.stringify({ status: "active", nextSteps: ["competing write"] }, null, 2),
      },
    ]);
    expect(revisionVersions(port, saved!.id)).toEqual([0, 1]);
    core.close();
  });

  it("two same-store engines checkpointing the same circle keep one row and monotonic revisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-ws-race-"));
    const dbPath = join(dir, "race.db");
    try {
      const embedder = new BarrierEmbeddingProvider(2);
      const first = new MonetCore(dbPath, { embedder });
      const second = new MonetCore(dbPath, { embedder });

      const [a, b] = await Promise.all([
        first.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "from first" }] }, { circle: "shared" }),
        second.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "from second" }] }, { circle: "shared" }),
      ]);

      const db = rawDb(first);
      const rows = workstreamRows(db, "shared");
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe(1);
      expect(new Set([a!.id, b!.id])).toEqual(new Set([rows[0].id]));
      expect(new Set([a!.version, b!.version])).toEqual(new Set([0, 1]));
      expect(revisionVersions(db, rows[0].id)).toEqual([0, 1]);

      first.close();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("different-circle workstream saves do not cross-mutate", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });

    const alpha = await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "alpha step" }] }, { circle: "alpha" });
    const beta = await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "beta step" }] }, { circle: "beta" });
    const alpha2 = await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "alpha step 2" }] }, { circle: "alpha" });

    expect(alpha2!.id).toBe(alpha!.id);
    expect(alpha2!.version).toBe(1);
    expect(beta!.version).toBe(0);
    // alpha accumulates (merge), beta is untouched — the isolation claim, now stated against the
    // merge contract rather than against replacement.
    expect(core.getActiveWorkstreams("alpha").map((w) => openTexts(w.payload, "step"))).toEqual([["alpha step", "alpha step 2"]]);
    expect(core.getActiveWorkstreams("beta").map((w) => openTexts(w.payload, "step"))).toEqual([["beta step"]]);
    core.close();
  });

  it("restores active workstreams in a NEW session (DB reopen = next session)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-ws-"));
    const dbPath = join(dir, "ws.db");
    try {
      const s1 = new MonetCore(dbPath);
      await s1.saveWorkstream(
        { status: "active", open: [{ slot: "question" as const, text: "resume #242?" }, { slot: "step" as const, text: "build prewarm ranking" }] },
        { summary: "end of session 1" },
      );
      s1.close();

      const s2 = new MonetCore(dbPath); // "next session" — fresh instance, same store
      const restored = s2.getActiveWorkstreams();
      expect(restored).toHaveLength(1);
      expect(openTexts(restored[0].payload, "question")).toEqual(["resume #242?"]);
      expect(openTexts(restored[0].payload, "step")).toEqual(["build prewarm ranking"]);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compresses many observations into one workstream update", async () => {
    const core = new MonetCore(":memory:");
    for (const c of ["tried approach A", "approach A failed on X", "switched to approach B", "B works", "next: write tests"]) {
      await core.store(c);
    }
    expect(core.observationCount()).toBe(5);

    const w = await core.saveWorkstream({
      status: "active",
      open: [{ slot: "step" as const, text: "write tests" }],
    });
    expect(core.getActiveWorkstreams()).toHaveLength(1); // five turns → one durable workstream
    expect(openTexts(w!.payload, "step")).toEqual(["write tests"]);
    core.close();
  });

  it("a normal store() never folds into a workstream, and search excludes workstreams", async () => {
    const core = new MonetCore(":memory:");
    // payload text deliberately overlaps a real concept we then store
    const w = await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "use SQLite for storage backend" }] });

    const s = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    expect(s.conceptId).not.toBe(w!.id); // did NOT attach to the workstream
    expect(s.action).toBe("created");

    const hits = await core.search("sqlite storage backend");
    expect(hits.some((h) => h.id === w!.id)).toBe(false); // workstream never appears as a search card
    expect(core.conceptCount()).toBe(1); // conceptCount excludes the workstream
    core.close();
  });

  it("'done' workstreams drop out of the active restore set — once nothing is open", async () => {
    const core = new MonetCore(":memory:");
    const opened = await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "ship it" }] });
    expect(core.getActiveWorkstreams()).toHaveLength(1);
    const item = opened!.payload.items[0]!;
    await core.saveWorkstream({ status: "done", close: [{ id: item.id, as: "done" }] });
    expect(core.getActiveWorkstreams()).toHaveLength(0);
    core.close();
  });

  it("refuses 'done' while items are still open, and names them", async () => {
    // This test previously WAS the bug (Codex P1 on PR #149): it opened an item, checkpointed
    // `done` without closing it, and asserted the workstream disappeared — which is the silent
    // loss #131 exists to remove, reappearing inside the change that removes it.
    const core = new MonetCore(":memory:");
    const opened = await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "ship it" }] });
    const item = opened!.payload.items[0]!;

    await expect(core.saveWorkstream({ status: "done" })).rejects.toThrow(
      new RegExp(`1 item\\(s\\) are still open: ${item.id}`),
    );
    // Refused, not partially applied: the workstream is still active and the item still open.
    expect(core.getActiveWorkstreams()).toHaveLength(1);
    expect(openTexts(core.getActiveWorkstreams()[0]!.payload, "step")).toEqual(["ship it"]);

    // Closing it in the same checkpoint as the status is the supported move.
    await core.saveWorkstream({ status: "done", close: [{ id: item.id, as: "dropped" }] });
    expect(core.getActiveWorkstreams()).toHaveLength(0);
    core.close();
  });

  it("restores only the canonical ordinary row per slug before active filtering", () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "active-older", circle: "legacy", slug: "workstream:legacy-active", version: 1, updatedAt: 100, nextStep: "older active" });
    insertWorkstreamRow(db, { id: "active-winner", circle: "legacy", slug: "workstream:legacy-active", version: 2, updatedAt: 300, nextStep: "winner active" });
    insertWorkstreamRow(db, { id: "done-older", circle: "legacy", slug: "workstream:legacy-done", version: 3, updatedAt: 200, nextStep: "older active hidden by done" });
    insertWorkstreamRow(db, { id: "done-newer", circle: "legacy", slug: "workstream:legacy-done", payloadStatus: "done", version: 4, updatedAt: 400 });
    // An ACTIVE row beats an archived sibling regardless of updated_at/version (archived rows sort
    // last in the canonical pick — Codex review, PR #100, P1): updated_at is rewritten to a common
    // relayAt by graftRows, so ranking an archived row above an active one by timestamp would make
    // restore vanish the slug on a peer. Gone-ness needs the WHOLE group archived.
    insertWorkstreamRow(db, { id: "archived-older", circle: "legacy", slug: "workstream:legacy-archived", version: 5, updatedAt: 250, nextStep: "older active beats archived-newer" });
    insertWorkstreamRow(db, { id: "archived-newer", circle: "legacy", slug: "workstream:legacy-archived", status: "archived", version: 6, updatedAt: 450 });
    insertWorkstreamRow(db, { id: "all-archived", circle: "legacy", slug: "workstream:legacy-gone", status: "archived", version: 9, updatedAt: 475 });
    insertWorkstreamRow(db, { id: "distinct-a", circle: "legacy", slug: "workstream:legacy-distinct-a", version: 7, updatedAt: 150, nextStep: "distinct a" });
    insertWorkstreamRow(db, { id: "distinct-b", circle: "legacy", slug: "workstream:legacy-distinct-b", version: 8, updatedAt: 125, nextStep: "distinct b" });

    expect(core.getActiveWorkstreams("legacy").map((w) => w.id)).toEqual(["active-winner", "archived-older", "distinct-a", "distinct-b"]);
    core.close();
  });

  it("post-graft timestamp ties: an archived loser neither shadows the active survivor nor steals its checkpoint", async () => {
    // graftRows rewrites every grafted concept's updated_at to one common relayAt, so on a peer the
    // canonicalization survivor and its archived loser tie on updated_at while the loser can carry
    // the higher version (Codex review, PR #100, P1). Restore must return the active survivor (not
    // vanish the slug), and a checkpoint must update the survivor in place — not resurrect the
    // archived loser into a second active row for the slug.
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "survivor", circle: "peer", version: 0, updatedAt: 500, nextStep: "active survivor" });
    insertWorkstreamRow(db, { id: "loser", circle: "peer", status: "archived", version: 5, updatedAt: 500 });

    expect(core.getActiveWorkstreams("peer").map((w) => w.id)).toEqual(["survivor"]);

    const saved = await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "next" }] }, { circle: "peer" });
    expect(saved!.id).toBe("survivor");
    expect(saved!.version).toBe(1);
    expect(workstreamStatuses(db, "peer").find((s) => s.id === "loser")?.status).toBe("archived"); // never resurrected
    core.close();
  });

  it("saveWorkstream rejects a connector-owned same-slug row even with an ordinary candidate present", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "ordinary", circle: "guard", version: 0, updatedAt: 100, nextStep: "ordinary" });
    insertWorkstreamRow(db, { id: "connector", circle: "guard", version: 1, updatedAt: 200, nextStep: "connector" });
    db.prepare(`UPDATE concepts SET source_identity = ? WHERE id = ?`).run("source://guard", "connector");

    await expect(core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "caller" }] }, { circle: "guard" }))
      .rejects.toThrow(/connector-owned workstream/);

    expect(workstreamRows(db, "guard").map((row) => row.id)).toEqual(["ordinary"]);
    core.close();
  });

  it("checkpoint ends the session; the next write opens a fresh one", async () => {
    const core = new MonetCore(":memory:");
    await core.store("a"); // session 1 opens
    expect(core.stats().sessions).toBe(1);
    await core.saveWorkstream({ status: "active" }, { summary: "done for now" }); // ends session 1
    await core.store("b"); // session 2 opens
    expect(core.stats().sessions).toBe(2);
    expect(core.stats().workstreams).toBe(1);
    core.close();
  });
});

/**
 * renameCircle's slug-normalization step re-slugs every ordinary workstream row now in the
 * to-circle to 'workstream:${to}'. When the to-circle already had its own workstream, that mints
 * two rows sharing one slug. canonicalizeWorkstreamSlug (called at the same mint site, inside
 * renameCircle's transaction) collapses the group back down to exactly one non-archived row —
 * duplicates should never exist, not merely be picked around on read.
 */
describe("renameCircle workstream collision canonicalization (mint-site dup guard)", () => {
  // NOTE on updated_at in these fixtures: the pre-existing sync trigger (engine.ts's `trigger()`
  // helper, fired by any UPDATE that changes a "semantic" column — circle and slug are both in
  // that list) stamps a fresh wall-clock updated_at on any row renameCircle's bulk `circle=?`
  // move or its slug re-slug actually touches. So a row moved from `from` always comes out of a
  // rename with a freshly-stamped updated_at — it is NOT the fixture's hand-set value. Rows that
  // started out already resident in `to` (and whose slug therefore doesn't change value) are left
  // alone by both statements, so their hand-set updated_at survives untouched. The first two tests
  // below use that: the "archived-newest" and "post-canonicalization saveWorkstream" fixtures keep
  // BOTH rows of the colliding pair resident in `to` from the start (with `from` contributing an
  // unrelated concept only, so the rename has something to do) specifically so their updated_at
  // values stay under the test's control instead of being overwritten by the move.

  it("rename-merge collision: the moved-in workstream wins the slug (freshly touched by the move); the target's own workstream is archived, not deleted", () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "a-ws", circle: "A", version: 0, updatedAt: 100, nextStep: "moved in from A" });
    insertWorkstreamRow(db, { id: "b-ws", circle: "B", version: 0, updatedAt: 200, nextStep: "already in B" });

    core.renameCircle("A", "B");

    // Both rows survive physically — archived, never deleted.
    expect(workstreamRows(db, "B").map((r) => r.id)).toEqual(["a-ws", "b-ws"]);
    const statuses = workstreamStatuses(db, "B");
    // a-ws's `circle` column just changed (A→B), so the sync trigger stamps it with a fresh
    // updated_at — newer than b-ws's untouched 200 — making it the row getActiveWorkstreams picks.
    expect(statuses.find((s) => s.id === "a-ws")?.status).toBe("active");
    expect(statuses.find((s) => s.id === "b-ws")?.status).toBe("archived");

    const active = core.getActiveWorkstreams("B");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("a-ws");
    expect(active[0].slug).toBe("workstream:B");
    expect(openTexts(active[0].payload, "step")).toEqual(["moved in from A"]);
    core.close();
  });

  it("rename-collision canonicalization never archives a connector-owned row sharing the slug", () => {
    // B holds a connector-owned row on the workstream slug plus its own ordinary workstream; the
    // rename moves A's ordinary workstream in, colliding the two ORDINARY rows. The archive pass
    // must collapse only the ordinary group (Codex review, PR #100, P2) — the connector row is
    // source-controlled state the same ownership boundary saveWorkstream enforces, and a
    // native-circle rename has no business flipping its status.
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "b-connector", circle: "B", version: 9, updatedAt: 900, nextStep: "connector-owned" });
    db.prepare(`UPDATE concepts SET source_identity = ? WHERE id = ?`).run("source://b", "b-connector");
    insertWorkstreamRow(db, { id: "b-ws", circle: "B", version: 0, updatedAt: 200, nextStep: "already in B" });
    insertWorkstreamRow(db, { id: "a-ws", circle: "A", version: 0, updatedAt: 100, nextStep: "moved in from A" });

    core.renameCircle("A", "B");

    const status = (id: string): string =>
      (db.prepare(`SELECT status FROM concepts WHERE id = ?`).get(id) as { status: string }).status;
    expect(status("b-connector")).toBe("active"); // ownership boundary held
    expect(status("a-ws")).toBe("active"); // survivor of the ordinary group (freshly touched by the move)
    expect(status("b-ws")).toBe("archived"); // ordinary loser archived, never deleted
    core.close();
  });

  it("archived-newest edge: a stale archived sibling with a higher updated_at does not shadow the active survivor", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    // Pre-existing malformed state, entirely within B (e.g. from a historical bug, or clock skew
    // across synced devices): the active row is genuinely canonical, but an archived sibling
    // outranks it on updated_at. Both rows already live in B so the rename's bulk circle/slug
    // UPDATEs never touch either one — their fixture timestamps are exactly what canonicalization sees.
    insertWorkstreamRow(db, { id: "b-active", circle: "B", version: 1, updatedAt: 100, nextStep: "active, genuinely canonical" });
    insertWorkstreamRow(db, { id: "b-archived-newer", circle: "B", status: "archived", version: 5, updatedAt: 999999, nextStep: "stale archived, outranks by updated_at" });
    await core.store("unrelated fact, gives A something to rename", { circle: "A" }); // A must be non-empty; not a workstream, so it never touches B's pair

    core.renameCircle("A", "B");

    const statuses = workstreamStatuses(db, "B");
    const survivor = statuses.find((s) => s.id === "b-active");
    const loser = statuses.find((s) => s.id === "b-archived-newer");
    expect(survivor?.status).toBe("active");
    expect(loser?.status).toBe("archived");
    expect(loser!.updatedAt).toBe(999999); // untouched loser — canonicalization never rewrites losers' timestamps
    expect(survivor!.updatedAt).toBeGreaterThan(loser!.updatedAt); // survivor bumped so it unambiguously dominates the ordering

    // The active row must be restorable — it must NOT vanish behind the archived-but-newer sibling.
    const active = core.getActiveWorkstreams("B");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("b-active");
    expect(openTexts(active[0].payload, "step")).toEqual(["active, genuinely canonical"]);
    core.close();
  });

  it("idempotence: re-running the rename after canonicalization does not further mutate either row", () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "a-ws", circle: "A", version: 0, updatedAt: 100, nextStep: "moved in from A" });
    insertWorkstreamRow(db, { id: "b-ws", circle: "B", version: 0, updatedAt: 200, nextStep: "already in B" });

    core.renameCircle("A", "B");
    const afterFirst = workstreamStatuses(db, "B");

    core.renameCircle("A", "B"); // A is now empty but still exists as an alias; re-running must be inert
    const afterSecond = workstreamStatuses(db, "B");

    expect(afterSecond).toEqual(afterFirst);
    const active = core.getActiveWorkstreams("B");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("a-ws");
    core.close();
  });

  it("no-collision rename: a single workstream moves over with its slug updated and content intact", async () => {
    const core = new MonetCore(":memory:");
    await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "only workstream" }] }, { circle: "solo-a" });

    core.renameCircle("solo-a", "solo-b");

    const db = rawDb(core);
    expect(workstreamRows(db, "solo-b")).toHaveLength(1); // no collision minted, so nothing to canonicalize
    const active = core.getActiveWorkstreams("solo-b");
    expect(active).toHaveLength(1);
    expect(active[0].slug).toBe("workstream:solo-b");
    expect(openTexts(active[0].payload, "step")).toEqual(["only workstream"]);
    core.close();
  });

  it("a checkpoint after the merge updates the survivor row, not a resurrected archived loser", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    // Same archived-newest fixture as above: without the survivor bump in canonicalizeWorkstreamSlug,
    // saveWorkstream's own `existing` row-select (engine.ts, unfiltered by status, ordered
    // updated_at DESC/version DESC/id ASC) would pick "b-archived-newer" here and resurrect it.
    insertWorkstreamRow(db, { id: "b-active", circle: "B", version: 1, updatedAt: 100, nextStep: "active, genuinely canonical" });
    insertWorkstreamRow(db, { id: "b-archived-newer", circle: "B", status: "archived", version: 5, updatedAt: 999999, nextStep: "stale archived, outranks by updated_at" });
    await core.store("unrelated fact, gives A something to rename", { circle: "A" });

    core.renameCircle("A", "B"); // canonicalizes: b-active survives (bumped), b-archived-newer stays archived

    const saved = await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "checkpoint after merge" }] }, { circle: "B" });

    expect(saved!.id).toBe("b-active"); // updates the survivor, NOT the higher-updated_at archived loser
    expect(saved!.version).toBe(2); // b-active was version 1 before this checkpoint

    const loser = (db.prepare(`SELECT status FROM concepts WHERE id = ?`).get("b-archived-newer") as { status: string });
    expect(loser.status).toBe("archived"); // never resurrected back to active

    const active = core.getActiveWorkstreams("B");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("b-active");
    // The survivor's own item is still there: the checkpoint added to it rather than replacing it,
    // which is also a sharper proof that the archived loser was not the row that got written.
    expect(openTexts(active[0].payload, "step")).toEqual(["active, genuinely canonical", "checkpoint after merge"]);
    core.close();
  });
});
