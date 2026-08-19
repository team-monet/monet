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
const openTexts = (payload: { items: Array<{ slot?: string; text: string; state: string }> }, slot: "question" | "step"): string[] =>
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
      WHERE circle = ? AND kind = 'workstream'
      ORDER BY id`,
  ).all(circle) as Array<{ id: string; version: number; body: string }>;
}

function workstreamIdentities(db: StoragePort, circle: string): Array<{ id: string; slug: string; title: string; status: string }> {
  return db.prepare(
    `SELECT id, slug, title, status FROM concepts
      WHERE circle = ? AND kind = 'workstream'
      ORDER BY id`,
  ).all(circle) as Array<{ id: string; slug: string; title: string; status: string }>;
}

function revisionVersions(db: StoragePort, conceptId: string): number[] {
  return (db.prepare(
    `SELECT version FROM concept_revisions WHERE concept_id = ? ORDER BY version ASC`,
  ).all(conceptId) as Array<{ version: number }>).map((row) => row.version);
}

function workstreamStatuses(db: StoragePort, circle: string): Array<{ id: string; status: string; updatedAt: number }> {
  return (db.prepare(
    `SELECT id, status, updated_at FROM concepts
      WHERE circle = ? AND kind = 'workstream'
      ORDER BY id`,
  ).all(circle) as Array<{ id: string; status: string; updated_at: number }>)
    .map((row) => ({ id: row.id, status: row.status, updatedAt: row.updated_at }));
}

describe("memory_workstreams MCP tool", () => {
  it("rejects removed top-level checkpoint keys instead of stripping them", async () => {
    const core = new MonetCore(":memory:");
    const result = await withWorkstreamServer(core, (client) => client.callTool({
      name: "memory_checkpoint",
      arguments: { summary: "removed session ritual" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unrecognized key(s) in object: 'summary'");
    core.close();
  });

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
    // memory_checkpoint's `close` takes. Stored slot maps to wire kind.
    expect(detail).toEqual({
      id: saved!.id,
      title: saved!.title,
      status: "paused",
      items: saved!.payload.items.map((item) => ({ id: item.id, kind: item.slot, text: item.text })),
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

    const recovered: Array<{ kind: string; text: string }> = [];
    await withWorkstreamServer(core, async (client) => {
      let detailOffset = 0;
      do {
        const detail = toolJson(await client.callTool({
          name: "memory_workstreams",
          arguments: { id: saved!.id, detailOffset },
        }));
        const page = (detail.items as Array<{ kind: string; text: string }>) ?? [];
        expect(page.length).toBeGreaterThan(0);
        recovered.push(...page.map(({ kind, text }) => ({ kind, text })));
        detailOffset += page.length;
        if (detail.detailOmitted === undefined) break;
        expect(detail.detailOmitted).toBe(open.length - detailOffset);
      } while (true);
    });

    // Every item exactly once, in the documented order: questions first, then steps, each in the
    // order it was opened. Paging must not lose or repeat one across the boundary.
    expect(recovered).toEqual(open.map(({ slot: kind, text }) => ({ kind, text })));
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
      items: [{ id: saved!.payload.items[1]!.id, kind: "step", text: "recover me next" }],
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
      items: saved!.payload.items.map((item) => ({ id: item.id, kind: item.slot, text: item.text })),
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
    expect(toolJson(ack).workstream).toMatchObject({ opened: [], closed: [realId] });
    core.close();
  });

  it("uses detail-read affinity for a later unaddressed checkpoint and relays ambiguity plainly", async () => {
    const core = new MonetCore(":memory:");
    const alpha = (await core.saveWorkstream({ title: "Alpha", status: "active" }))!;
    const beta = (await core.saveWorkstream({ title: "Beta", status: "active" }))!;

    await withWorkstreamServer(core, async (client) => {
      await client.callTool({ name: "memory_workstreams", arguments: { id: alpha.id } });
      const receipt = toolJson(await client.callTool({
        name: "memory_checkpoint",
        arguments: { workstream: { open: [{ kind: "step", text: "continue alpha" }] } },
      }));
      expect(receipt.workstream).toMatchObject({ id: alpha.id, opened: [expect.any(String)] });
    });
    expect(openTexts(core.getWorkstreamById(alpha.id)!.payload, "step")).toEqual(["continue alpha"]);
    expect(openTexts(core.getWorkstreamById(beta.id)!.payload, "step")).toEqual([]);

    const freshServerRefusal = await withWorkstreamServer(core, (client) => client.callTool({
      name: "memory_checkpoint",
      arguments: { workstream: { status: "paused" } },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(freshServerRefusal.isError).toBe(true);
    expect(freshServerRefusal.content[0]!.text).toContain(alpha.id);
    expect(freshServerRefusal.content[0]!.text).toContain("Alpha");
    expect(freshServerRefusal.content[0]!.text).not.toContain("checkpoint failed");
    core.close();
  });

  it("receipts report only this call's thread and inbox effects", async () => {
    const core = new MonetCore(":memory:");
    const receipt = await withWorkstreamServer(core, (client) => client.callTool({
      name: "memory_checkpoint",
      arguments: {
        inbox: "unrelated find",
        workstream: {
          title: "Release plan",
          status: "paused",
          open: [{ kind: "question", text: "who approves?" }, { kind: "step", text: "draft it" }],
        },
      },
    }));
    const payload = toolJson(receipt);
    expect(payload.circle).toBe("default");
    expect(payload.workstream).toEqual({
      id: expect.any(String),
      title: "Release plan",
      status: "paused",
      opened: [expect.any(String), expect.any(String)],
      closed: [],
    });
    expect(payload.inbox).toEqual({ opened: [expect.any(String)] });
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
    expect(restored[0]!.payload).not.toHaveProperty("nextSteps");
    expect(restored[0]!.payload).not.toHaveProperty("openQuestions");
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
    // empty active "session state" thread. Round 2: refusing it instead broke the documented
    // contract that an unknown close is a no-op. Nothing to write is not an error — it is `null`.
    const core = new MonetCore(":memory:");
    const result = await core.saveWorkstream(
      { close: [{ id: "stale-from-another-circle", as: "done" }] },
    );
    expect(result).toBeNull();
    expect(core.getActiveWorkstreams()).toHaveLength(0);
    core.close();
  });

  it("closes an item as filed with its ref, and refuses an unknown disposition", async () => {
    // Codex round 2 on #152: only the MCP boundary enforced the enum, so a direct caller's typo
    // persisted verbatim — hiding the item from the default view AND making every later
    // legitimate close skip it, because it was no longer `open`.
    const core = new MonetCore(":memory:");
    const opened = (await core.saveWorkstream({ status: "active", open: [
      { slot: "step" as const, text: "file the issue" },
      { slot: "step" as const, text: "leave open" },
    ] }))!;
    const filedId = opened.payload.items[0]!.id;
    const openId = opened.payload.items[1]!.id;

    const saved = (await core.saveWorkstream({
      close: [{ id: filedId, as: "filed", ref: "https://github.com/team-monet/monet-core/issues/181" }],
    }))!;
    expect(saved.payload.items.find((item) => item.id === filedId)).toMatchObject({
      state: "filed",
      ref: "https://github.com/team-monet/monet-core/issues/181",
    });

    await expect(
      core.saveWorkstream({ close: [{ id: openId, as: "filed" }] }),
    ).rejects.toThrow(/filed.*non-empty ref/);
    await expect(
      core.saveWorkstream({ close: [{ id: openId, as: "filed", ref: "  " }] }),
    ).rejects.toThrow(/filed.*non-empty ref/);
    await expect(
      core.saveWorkstream({ close: [{ id: openId, as: "closed" as "done" }] }),
    ).rejects.toThrow(/must be 'done', 'dropped', or 'filed'/);
    expect(core.getActiveWorkstreams()[0]!.payload.items.find((item) => item.id === openId)?.state).toBe("open");
    core.close();
  });

  it("counts work threads only — the inbox is not a workstream in stats or overview", async () => {
    const core = new MonetCore(":memory:");
    await core.saveWorkstream({ title: "Real work", open: [{ slot: "step", text: "do it" }] }, { circle: "counted" });
    await core.captureFind("stray find", { circle: "counted" });
    await core.saveWorkstream({ status: "active" }, { circle: "team::inbox" });
    expect(core.stats("counted").workstreams).toBe(1);
    expect(core.stats("team::inbox").workstreams).toBe(1);
    expect(core.stats().workstreams).toBe(2);
    expect(core.overview("counted").counts.workstreams).toBe(1);
    expect(core.overview("team::inbox").counts.workstreams).toBe(1);
    core.close();
  });

  it("a combined checkpoint refuses before the inbox mutates when addressing is ambiguous", async () => {
    const core = new MonetCore(":memory:");
    await core.saveWorkstream({ title: "Alpha", open: [{ slot: "step", text: "a" }] });
    await core.saveWorkstream({ title: "Beta", open: [{ slot: "step", text: "b" }] });

    const refusal = await withWorkstreamServer(core, (client) => client.callTool({
      name: "memory_checkpoint",
      arguments: { inbox: "must not be stranded", workstream: { open: [{ kind: "step", text: "c" }] } },
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(refusal.isError).toBe(true);
    expect(refusal.content[0]!.text).toMatch(/workstream address required/);
    expect(core.getWorkstreamInbox()).toBeUndefined();
    core.close();
  });

  it("a combined checkpoint refuses a deterministic violation before the inbox mutates", async () => {
    const core = new MonetCore(":memory:");
    await core.saveWorkstream({ title: "Solo", open: [{ slot: "step", text: "open item" }] });

    const refusal = await withWorkstreamServer(core, (client) => client.callTool({
      name: "memory_checkpoint",
      arguments: { inbox: "must not be stranded", workstream: { status: "done" } },
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(refusal.isError).toBe(true);
    expect(refusal.content[0]!.text).toMatch(/still open/);
    expect(core.getWorkstreamInbox()).toBeUndefined();
    core.close();
  });

  it("merge receipts reflect actual inbox collisions, not pre-move prediction", async () => {
    const core = new MonetCore(":memory:");
    await core.captureFind("find A", { circle: "A" });
    await core.captureFind("find TMP", { circle: "TMP" });
    // First merge leaves circle A holding an active survivor plus an archived drained inbox row.
    await core.mergeCircle("TMP", "A");

    // Second merge into a destination with NO inbox: the moved source rows still collide with
    // each other after the re-slug, so one is an item-merge — a fact only the collision helper
    // knows; the old pre-move prediction (destination inbox presence) classified all as moved.
    const result = await core.mergeCircle("A", "B");
    const mergedReceipts = result.conceptResults.filter((r) => r.action === "merged");
    // EXACTLY one merge (the archived drained history row into the live survivor) and no
    // reciprocal churn: the group resolves once, so a row already used as a destination is
    // never re-processed as an incoming (Codex round 3 on #212).
    expect(mergedReceipts).toHaveLength(1);

    const survivor = core.getWorkstreamInbox("B");
    expect(survivor).toBeDefined();
    expect(survivor!.payload.status).toBe("active");
    const openTextsInB = survivor!.payload.items.filter((i) => i.state === "open").map((i) => i.text).sort();
    expect(openTextsInB).toEqual(["find A", "find TMP"]);
    // The merged receipt names the LIVE survivor, and only one live inbox row exists at B.
    expect(mergedReceipts[0]!.mergedIntoId).toBe(survivor!.id);
    expect(core.circleOf(survivor!.id)).toBe("B");
    const liveInboxRows = rawDb(core)
      .prepare(`SELECT COUNT(*) AS n FROM concepts WHERE circle='B' AND kind='workstream'
        AND slug='workstream:B::inbox' AND status != 'archived'`)
      .get() as { n: number };
    expect(liveInboxRows.n).toBe(1);
    core.close();
  });

  it("an ambiguity refusal renders a bounded candidate sample", async () => {
    const core = new MonetCore(":memory:");
    for (let i = 0; i < 10; i++) {
      await core.saveWorkstream({ title: `Thread ${i}`, open: [{ slot: "step", text: `t${i}` }] });
    }
    await expect(core.saveWorkstream({ open: [{ slot: "step", text: "unaddressed" }] }))
      .rejects.toThrow(/and 2 more/);
    core.close();
  });

  it("an oversized open batch refuses at the schema before any mutation", async () => {
    const core = new MonetCore(":memory:");
    const refusal = await withWorkstreamServer(core, (client) => client.callTool({
      name: "memory_checkpoint",
      arguments: { workstream: { title: "Bulk", open: Array.from({ length: 101 }, (_, i) => ({ kind: "step", text: `item ${i}` })) } },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refusal.isError).toBe(true);
    expect(refusal.content[0]!.text).toMatch(/at most 100/);
    expect(core.getActiveWorkstreams()).toHaveLength(0);
    core.close();
  });

  it("an inbox settle reports under the inbox receipt, never as a workstream", async () => {
    const core = new MonetCore(":memory:");
    const captured = await core.captureFind("settle me");

    const receipt = await withWorkstreamServer(core, async (client) => toolJson(await client.callTool({
      name: "memory_checkpoint",
      arguments: { workstream: { id: "inbox", close: [{ id: captured.itemId, as: "dropped" }] } },
    }))) as { workstream?: unknown; inbox?: { closed?: string[] } };

    expect(receipt.workstream).toBeUndefined();
    expect(receipt.inbox?.closed).toEqual([captured.itemId]);
    core.close();
  });

  it("a self-merge does not destroy touched-thread affinity", async () => {
    const core = new MonetCore(":memory:");
    await core.saveWorkstream({ title: "Other", open: [{ slot: "step", text: "o" }] }, { circle: "A" });

    const landed = await withWorkstreamServer(core, async (client) => {
      const touched = toolJson(await client.callTool({
        name: "memory_checkpoint",
        arguments: { circle: "A", workstream: { title: "Mine", open: [{ kind: "step", text: "m" }] } },
      })) as { workstream: { id: string } };
      await client.callTool({ name: "memory_circle_manage", arguments: { action: "merge", circle: "A", to: "A" } });
      const after = toolJson(await client.callTool({
        name: "memory_checkpoint",
        arguments: { circle: "A", workstream: { open: [{ kind: "step", text: "post-noop" }] } },
      })) as { workstream: { id: string } };
      return { touched, after };
    });
    expect(landed.after.workstream.id).toBe(landed.touched.workstream.id);
    core.close();
  });

  it("refuses duplicate close ids, over-length titles, and document-sized refs", async () => {
    const core = new MonetCore(":memory:");
    const opened = (await core.saveWorkstream({ open: [{ slot: "step", text: "x" }] }))!;
    const itemId = opened.openedItemIds[0]!;

    await expect(core.saveWorkstream({ close: [{ id: itemId, as: "done" }, { id: itemId, as: "dropped" }] }))
      .rejects.toThrow(/at most once/);
    await expect(core.saveWorkstream({ title: "T".repeat(81), open: [{ slot: "step", text: "y" }] }))
      .rejects.toThrow(/80 characters or fewer/);
    await expect(core.saveWorkstream({ close: [{ id: itemId, as: "filed", ref: "r".repeat(2049) }] }))
      .rejects.toThrow(/2048 characters or fewer/);
    // The refusals wrote nothing: the item is still open.
    expect(core.getActiveWorkstreams()[0]!.payload.items.find((i) => i.id === itemId)?.state).toBe("open");
    core.close();
  });

  it("clips over-length stored titles by code point, never splitting a surrogate", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "astral", circle: "astral", version: 0, updatedAt: 100 });
    db.prepare(`UPDATE concepts SET body = ? WHERE id = ?`).run(JSON.stringify({
      status: "active",
      title: "𝐀".repeat(100),
      items: [{ id: "astral-item", slot: "step", text: "x", state: "open", openedAt: 10 }],
    }, null, 2), "astral");

    const saved = (await core.saveWorkstream({ status: "paused" }, { circle: "astral" }))!;
    expect(saved.title).toBe("𝐀".repeat(77) + "…");
    core.close();
  });

  it("a capture in flight across a circle rename lands in the destination", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const embedder: EmbeddingProvider = {
      dim: 2,
      modelId: "test:rename-race",
      async embed(text: string) {
        if (String(text).includes("in-flight find")) await gate;
        return new Float32Array([1, 0]);
      },
    };
    const core = new MonetCore(":memory:", { embedder, tauAttach: 1.1, tauAmbiguous: 1.1 });
    await core.store("Anchor so the source circle exists.", { circle: "old" });

    const pending = core.captureFind("in-flight find", { circle: "old" });
    await new Promise((resolve) => setTimeout(resolve, 25)); // let the capture reach its embed await
    core.renameCircle("old", "new");
    release();
    const captured = await pending;

    // The write re-resolved the circle under its reservation: the find lives where the circle
    // now lives, and both names reach it through the alias.
    expect(core.circleOf(captured.row.id)).toBe("new");
    expect(core.getWorkstreamInbox("new")!.payload.items.map((i) => i.text)).toContain("in-flight find");
    expect(core.getWorkstreamInbox("old")!.id).toBe(captured.row.id);
    core.close();
  });

  it("unions replica-minted inbox siblings on read and collapses them on the next write", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    // Two replicas that both lacked an inbox mint different ids at the same reserved slug; sync
    // converges concepts BY ID, so a graft leaves both live rows here.
    for (const [id, itemId, text] of [["inbox-a", "item-a", "find from A"], ["inbox-b", "item-b", "find from B"]]) {
      insertWorkstreamRow(db, { id, circle: "shared", version: 0, updatedAt: id === "inbox-a" ? 200 : 100 });
      db.prepare(`UPDATE concepts SET slug=?, body=? WHERE id=?`).run(
        "workstream:shared::inbox",
        JSON.stringify({ status: "active", items: [{ id: itemId, text, state: "open", openedAt: 10 }] }, null, 2),
        id,
      );
    }

    // READ: neither find is invisible, even before any write reconciles them.
    const unioned = core.getWorkstreamInbox("shared")!;
    expect(unioned.payload.items.map((i) => i.text).sort()).toEqual(["find from A", "find from B"]);

    // WRITE: the next capture collapses the siblings into one live row carrying every item.
    await core.captureFind("third find", { circle: "shared" });
    const liveRows = db.prepare(
      `SELECT id FROM concepts WHERE circle='shared' AND kind='workstream'
        AND slug='workstream:shared::inbox' AND status != 'archived'`,
    ).all() as Array<{ id: string }>;
    expect(liveRows).toHaveLength(1);
    expect(core.getWorkstreamInbox("shared")!.payload.items.map((i) => i.text).sort())
      .toEqual(["find from A", "find from B", "third find"]);

    // SETTLE: an item that arrived on the archived sibling is closable by id.
    const settled = await core.saveWorkstream({ id: "inbox", close: [{ id: "item-b", as: "dropped" }] }, { circle: "shared" });
    expect(settled!.closedItemIds).toEqual(["item-b"]);
    core.close();
  });

  it("filed without a usable ref refuses at the MCP schema", async () => {
    const core = new MonetCore(":memory:");
    const opened = (await core.saveWorkstream({ open: [{ slot: "step", text: "x" }] }))!;
    const refusal = await withWorkstreamServer(core, (client) => client.callTool({
      name: "memory_checkpoint",
      arguments: { workstream: { close: [{ id: opened.openedItemIds[0], as: "filed" }] } },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refusal.isError).toBe(true);
    expect(refusal.content[0]!.text).toMatch(/ref/);
    core.close();
  });

  it("graceful close stamps the live session's end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-close-"));
    const dbPath = join(dir, "monet.db");
    const core = new MonetCore(dbPath);
    await core.saveWorkstream({ open: [{ slot: "step", text: "before close" }] });
    core.close();

    const reopened = new MonetCore(dbPath);
    const row = (reopened as unknown as { db: StoragePort }).db
      .prepare(`SELECT ended_at, status FROM sessions ORDER BY started_at DESC LIMIT 1`)
      .get() as { ended_at: number | null; status: string };
    expect(row.status).toBe("ended");
    expect(row.ended_at).not.toBeNull();
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("captureFind keeps working when the accumulated inbox text exceeds the embedding budget", async () => {
    const core = new MonetCore(":memory:");
    for (let i = 0; i < 3; i++) await core.captureFind(`find ${i} ${"x".repeat(1500)}`);
    const result = await core.captureFind("one more small find");
    expect(result.itemId).toBeTruthy();
    expect(core.getWorkstreamInbox()!.payload.items.filter((i) => i.state === "open")).toHaveLength(4);
    core.close();
  });

  it("touched-thread affinity follows a circle rename", async () => {
    const core = new MonetCore(":memory:");
    // A second active thread in the DESTINATION makes the sole-active rung fail, so only
    // migrated affinity can route the post-rename unaddressed call.
    await core.saveWorkstream({ title: "Resident", open: [{ slot: "step", text: "r" }] }, { circle: "B" });

    const landed = await withWorkstreamServer(core, async (client) => {
      const touched = toolJson(await client.callTool({
        name: "memory_checkpoint",
        arguments: { circle: "A", workstream: { title: "Moving", open: [{ kind: "step", text: "m" }] } },
      })) as { workstream: { id: string } };
      await client.callTool({ name: "memory_circle_manage", arguments: { action: "rename", circle: "A", to: "B" } });
      const after = toolJson(await client.callTool({
        name: "memory_checkpoint",
        arguments: { circle: "B", workstream: { open: [{ kind: "step", text: "post-rename" }] } },
      })) as { workstream: { id: string } };
      return { touched, after };
    });
    expect(landed.after.workstream.id).toBe(landed.touched.workstream.id);
    core.close();
  });

  it("reads the inbox by reserved id without lifecycle fields and keeps it out of thread lists", async () => {
    const core = new MonetCore(":memory:");
    const open = await core.captureFind("open find");
    const closed = await core.captureFind("filed find");
    await core.saveWorkstream({ id: "inbox", close: [{ id: closed.itemId, as: "filed", ref: "issue-181" }] });

    const { list, openDetail, allDetail } = await withWorkstreamServer(core, async (client) => ({
      list: toolJson(await client.callTool({ name: "memory_workstreams", arguments: {} })),
      openDetail: toolJson(await client.callTool({ name: "memory_workstreams", arguments: { id: "inbox" } })),
      allDetail: toolJson(await client.callTool({ name: "memory_workstreams", arguments: { id: "inbox", includeClosed: true } })),
    }));
    expect(list).toEqual({ workstreams: [] });
    expect(openDetail).toEqual({
      id: "inbox",
      closedCount: 1,
      items: [{ id: open.itemId, text: "open find" }],
    });
    expect(openDetail).not.toHaveProperty("title");
    expect(openDetail).not.toHaveProperty("status");
    expect((openDetail.items as Array<Record<string, unknown>>)[0]).not.toHaveProperty("kind");
    expect(allDetail).toEqual({
      id: "inbox",
      openCount: 1,
      closedCount: 1,
      items: [
        { id: open.itemId, text: "open find" },
        expect.objectContaining({ id: closed.itemId, text: "filed find", state: "filed", ref: "issue-181", closedAt: expect.any(Number) }),
      ],
    });
    expect(JSON.stringify(allDetail)).not.toContain("closedIn");
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
      openCount: 0,
      closedCount: 1,
      items: [{ id: itemId, kind: "step", text: "finish me", state: "done", closedAt: expect.any(Number) }],
    });
    expect(JSON.stringify(toolJson(detail))).not.toContain("closedIn");
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

    const result = await core.saveWorkstream({ close: [{ id: "stale", as: "done" }] });
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

  it("preserves unknown payload keys through normalization and checkpoint merge", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "future-payload", circle: "future", version: 0, updatedAt: 100 });
    const seeded = {
      status: "active",
      items: [{
        id: "future-item",
        slot: "step",
        text: "keep future metadata",
        state: "open",
        openedAt: 10,
      }],
      futureKey: { retained: true },
    };
    db.prepare(`UPDATE concepts SET body = ? WHERE id = ?`).run(JSON.stringify(seeded, null, 2), "future-payload");
    expect(core.getActiveWorkstreams("future")[0]!.payload).toMatchObject({
      futureKey: { retained: true },
    });

    const saved = (await core.saveWorkstream({ status: "paused" }, { circle: "future" }))!;
    expect(saved.payload).toMatchObject({
      status: "paused",
      futureKey: { retained: true },
    });
    expect(JSON.parse(workstreamRows(db, "future")[0]!.body)).toMatchObject({
      futureKey: { retained: true },
    });
    core.close();
  });

  it("uses a stored title verbatim within the column budget and clips longer stored titles", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "named", circle: "named", version: 0, updatedAt: 100 });
    const namedPayload = {
      status: "active",
      title: "Capture redesign",
      items: [{ id: "named-item", slot: "step", text: "derived title must not win", state: "open", openedAt: 10 }],
    };
    db.prepare(`UPDATE concepts SET body = ? WHERE id = ?`).run(JSON.stringify(namedPayload, null, 2), "named");

    const named = (await core.saveWorkstream({ status: "paused" }, { circle: "named" }))!;
    expect(named.title).toBe("Capture redesign");

    const longTitle = "T".repeat(81);
    db.prepare(`UPDATE concepts SET body = ? WHERE id = ?`).run(
      JSON.stringify({ ...named.payload, title: longTitle }, null, 2),
      named.id,
    );
    const clipped = (await core.saveWorkstream({ status: "active" }, { circle: "named" }))!;
    expect(clipped.title).toBe(`${longTitle.slice(0, 77)}…`);
    core.close();
  });

  it("upserts named threads by slug, preserving the first stored-title echo on a collision", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });

    const first = (await core.saveWorkstream({
      title: "Release Plan",
      open: [{ slot: "step", text: "draft the plan" }],
    }))!;
    const collided = (await core.saveWorkstream({
      title: "Release---Plan",
      open: [{ slot: "question", text: "who approves it?" }],
    }))!;

    expect(first.slug).toBe("workstream:default:release-plan");
    expect(collided.id).toBe(first.id);
    expect(collided.payload.title).toBe("Release Plan");
    expect(collided.title).toBe("Release Plan");
    expect(openTexts(collided.payload, "step")).toEqual(["draft the plan"]);
    expect(openTexts(collided.payload, "question")).toEqual(["who approves it?"]);
    expect(core.getActiveWorkstreams()).toHaveLength(1);

    const emptyNamed = (await core.saveWorkstream({ title: "Empty named thread" }))!;
    expect(emptyNamed.slug).toBe("workstream:default:empty-named-thread");
    expect(emptyNamed.payload.title).toBe("Empty named thread");

    await expect(core.saveWorkstream({ title: "😀✨", status: "active" }))
      .rejects.toThrow(/slugifies to empty/);
    core.close();
  });

  it("targets an exact id and refuses unaddressed ambiguity before embedding", async () => {
    let embedCalls = 0;
    const counting = new StaticEmbeddingProvider();
    const embed = counting.embed.bind(counting);
    counting.embed = () => { embedCalls += 1; return embed(); };
    const core = new MonetCore(":memory:", { embedder: counting });
    const alpha = (await core.saveWorkstream({ title: "Alpha", status: "active" }))!;
    const beta = (await core.saveWorkstream({ title: "Beta", status: "active" }))!;
    const beforeRefusal = embedCalls;

    let refusal: unknown;
    try {
      await core.saveWorkstream({ status: "paused" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      name: "WorkstreamAddressRequiredError",
      candidates: [
        { id: beta.id, title: "Beta" },
        { id: alpha.id, title: "Alpha" },
      ],
    });
    expect(embedCalls).toBe(beforeRefusal);

    const updated = (await core.saveWorkstream({ id: alpha.id, status: "paused" }))!;
    expect(updated.id).toBe(alpha.id);
    expect(updated.payload.status).toBe("paused");
    expect(core.getWorkstreamById(beta.id)?.payload.status).toBe("active");
    core.close();
  });

  it("an unaddressed call targets the only active named thread; done threads do not count", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const live = (await core.saveWorkstream({ title: "Live", status: "active" }))!;
    const finished = (await core.saveWorkstream({ title: "Finished", status: "done" }))!;

    const saved = (await core.saveWorkstream({ open: [{ slot: "step", text: "continue live" }] }))!;
    expect(saved.id).toBe(live.id);
    expect(saved.id).not.toBe(finished.id);
    expect(openTexts(saved.payload, "step")).toEqual(["continue live"]);
    core.close();
  });

  it("captures slotless inbox finds, excludes the inbox from active threads, and disposes by literal id", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const captured = await core.captureFind("Follow up on the flaky test");

    expect(captured.row.slug).toBe("workstream:default::inbox");
    expect(captured.row.payload).not.toHaveProperty("title");
    expect(captured.row.payload.items).toEqual([
      expect.objectContaining({ id: captured.itemId, text: "Follow up on the flaky test", state: "open" }),
    ]);
    expect(captured.row.payload.items[0]).not.toHaveProperty("slot");
    expect(core.getActiveWorkstreams()).toEqual([]);
    expect(() => core.getWorkstreamById("inbox")).toThrow(/getWorkstreamInbox/);
    expect(core.getWorkstreamById(captured.row.id)).toBeUndefined();
    expect(core.getWorkstreamInbox()).toEqual(captured.row);

    const disposed = (await core.saveWorkstream({
      id: "inbox",
      close: [{ id: captured.itemId, as: "filed", ref: "https://example.test/181" }],
    }))!;
    expect(disposed.payload.items[0]).toMatchObject({
      state: "filed",
      ref: "https://example.test/181",
    });
    expect(core.getWorkstreamInbox()?.payload.items).toEqual(disposed.payload.items);
    await expect(core.saveWorkstream({ id: "inbox" }))
      .rejects.toThrow(/inbox has no lifecycle/);
    await expect(core.saveWorkstream({ id: "inbox", status: "active" }))
      .rejects.toThrow(/inbox has no lifecycle/);
    await expect(core.saveWorkstream({ id: "inbox", open: [{ slot: "step", text: "not allowed" }] }))
      .rejects.toThrow(/inbox has no lifecycle/);
    core.close();
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

  it("a checkpoint keeps a repeated claim in the same session", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0, tauAmbiguous: 0 });
    const first = await core.store("The capture layer preserves one host session.");

    await core.saveWorkstream({ status: "active" });
    const second = await core.store("The capture layer preserves one host session.");
    const row = rawDb(core)
      .prepare(`SELECT confidence, arousal_score FROM concepts WHERE id = ?`)
      .get(first.conceptId) as { confidence: number; arousal_score: number };

    expect(second.conceptId).toBe(first.conceptId);
    expect(row.confidence).toBeCloseTo(0.6, 5);
    expect(row.arousal_score).toBe(0);
    expect(core.stats().sessions).toBe(1);
    core.close();
  });

  it("two checkpoints stamp the same lastSessionId", async () => {
    const core = new MonetCore(":memory:");
    const first = (await core.saveWorkstream({
      status: "active",
      open: [{ slot: "step" as const, text: "capture the first checkpoint" }],
    }))!;
    const second = (await core.saveWorkstream({
      open: [{ slot: "step" as const, text: "capture the second checkpoint" }],
    }))!;

    expect(first.payload.lastSessionId).toBeTruthy();
    expect(second.payload.lastSessionId).toBe(first.payload.lastSessionId);
    core.close();
  });

  it("a checkpoint does not break the follows chain", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const first = await core.store("Capture thought Alpha through the host session.", { circle: "capture" });
    await core.saveWorkstream({ status: "active" }, { circle: "capture" });
    const second = await core.store("Capture thought Beta after the checkpoint.", { circle: "capture" });

    expect(core.edges({ type: "follows", circle: "capture" })).toContainEqual(
      expect.objectContaining({ srcId: first.conceptId, dstId: second.conceptId }),
    );
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
  it("preserves named, unnamed, and inbox suffixes for moved rows without rewriting destination rows", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    const unnamed = (await core.saveWorkstream({ status: "active" }, { circle: "from_%_*" }))!;
    const named = (await core.saveWorkstream({ title: "Auth", status: "active" }, { circle: "from_%_*" }))!;
    const inbox = await core.captureFind("source find", { circle: "from_%_*" });
    const destination = (await core.saveWorkstream({ title: "Destination", status: "active" }, { circle: "to_%_*" }))!;
    const destinationBefore = workstreamIdentities(db, "to_%_*");

    core.renameCircle("from_%_*", "to_%_*");

    expect(workstreamIdentities(db, "to_%_*").filter((row) => row.id === destination.id)).toEqual(destinationBefore);
    expect(workstreamIdentities(db, "to_%_*").filter((row) => [unnamed.id, named.id, inbox.row.id].includes(row.id)))
      .toEqual([
        { id: inbox.row.id, slug: "workstream:to_%_*::inbox", title: "source find", status: "active" },
        { id: named.id, slug: "workstream:to_%_*:auth", title: "Auth", status: "active" },
        { id: unnamed.id, slug: "workstream:to_%_*", title: "session state", status: "active" },
      ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(core.getWorkstreamInbox("to_%_*")?.payload.items.map((item) => item.text)).toEqual(["source find"]);
    core.close();
  });

  it("uses SQLite code-point prefix length when an astral circle name moves", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const named = (await core.saveWorkstream({ title: "Rocket plan", status: "active" }, { circle: "team🚀" }))!;
    const inbox = await core.captureFind("astral find", { circle: "team🚀" });

    core.renameCircle("team🚀", "launch🚀");

    expect(core.getWorkstreamById(named.id, "launch🚀")?.slug).toBe("workstream:launch🚀:rocket-plan");
    expect(core.getWorkstreamInbox("launch🚀")?.id).toBe(inbox.row.id);
    expect(core.getWorkstreamInbox("launch🚀")?.slug).toBe("workstream:launch🚀::inbox");
    core.close();
  });

  it("uses successive reserved counters when two destination slugs are already occupied", () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "source-auth", circle: "A", slug: "workstream:A:auth", nextStep: "source" });
    insertWorkstreamRow(db, { id: "dest-auth", circle: "B", slug: "workstream:B:auth", nextStep: "dest" });
    insertWorkstreamRow(db, { id: "dest-auth-2", circle: "B", slug: "workstream:B:auth::2", nextStep: "earlier collision" });

    core.renameCircle("A", "B");

    expect(workstreamIdentities(db, "B").find((row) => row.id === "source-auth")?.slug).toBe("workstream:B:auth::3");
    expect(core.getActiveWorkstreams("B").map((row) => row.id).sort()).toEqual(["dest-auth", "dest-auth-2", "source-auth"]);
    core.close();
  });

  it("item-merges colliding inboxes, carries closed history, revives a done destination, and archives the source", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    const destination = await core.captureFind("destination closed", { circle: "B" });
    await core.saveWorkstream({ id: "inbox", close: [{ id: destination.itemId, as: "done" }] }, { circle: "B" });
    db.prepare(`UPDATE concepts SET body=? WHERE id=?`).run(
      JSON.stringify({ ...core.getWorkstreamInbox("B")!.payload, status: "done" }, null, 2),
      destination.row.id,
    );
    const sourceClosed = await core.captureFind("source closed", { circle: "A" });
    await core.saveWorkstream({ id: "inbox", close: [{ id: sourceClosed.itemId, as: "filed", ref: "issue-181" }] }, { circle: "A" });
    const sourceOpen = await core.captureFind("source open", { circle: "A" });

    core.renameCircle("A", "B");

    const merged = core.getWorkstreamInbox("B")!;
    expect(merged.id).toBe(destination.row.id);
    expect(merged.payload.status).toBe("active");
    expect(merged.payload.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: destination.itemId, state: "done" }),
      expect.objectContaining({ id: sourceClosed.itemId, state: "filed", ref: "issue-181" }),
      expect.objectContaining({ id: sourceOpen.itemId, state: "open" }),
    ]));
    expect(workstreamIdentities(db, "B").find((row) => row.id === sourceOpen.row.id)?.status).toBe("archived");
    expect(workstreamIdentities(db, "B").filter((row) => row.slug === "workstream:B::inbox" && row.status !== "archived"))
      .toHaveLength(1);
    core.close();
  });

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

  it("rename collision keeps both work threads active and gives the moved row an unreachable counter suffix", () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "a-ws", circle: "A", version: 0, updatedAt: 100, nextStep: "moved in from A" });
    insertWorkstreamRow(db, { id: "b-ws", circle: "B", version: 0, updatedAt: 200, nextStep: "already in B" });

    core.renameCircle("A", "B");

    expect(workstreamRows(db, "B").map((r) => r.id)).toEqual(["a-ws", "b-ws"]);
    expect(workstreamStatuses(db, "B").map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "a-ws", status: "active" },
      { id: "b-ws", status: "active" },
    ]);
    const active = core.getActiveWorkstreams("B");
    expect(active.map(({ id, slug }) => ({ id, slug }))).toEqual([
      { id: "a-ws", slug: "workstream:B::2" },
      { id: "b-ws", slug: "workstream:B" },
    ]);
    expect(openTexts(active.find((row) => row.id === "a-ws")!.payload, "step")).toEqual(["moved in from A"]);
    expect(openTexts(active.find((row) => row.id === "b-ws")!.payload, "step")).toEqual(["already in B"]);
    core.close();
  });

  it("unrelated destination workstream rows remain byte-stable when another circle moves in", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "b-active", circle: "B", slug: "workstream:B:other", version: 1, updatedAt: 100, nextStep: "active, genuinely canonical" });
    insertWorkstreamRow(db, { id: "b-archived-newer", circle: "B", slug: "workstream:B:other", status: "archived", version: 5, updatedAt: 999999, nextStep: "stale archived" });
    const before = workstreamRows(db, "B");
    await core.saveWorkstream({ title: "Incoming", status: "active" }, { circle: "A" });

    core.renameCircle("A", "B");

    expect(workstreamRows(db, "B").filter((row) => row.id.startsWith("b-"))).toEqual(before);
    const restored = core.getActiveWorkstreams("B").find((row) => row.id === "b-active");
    expect(restored).toBeDefined();
    expect(openTexts(restored!.payload, "step")).toEqual(["active, genuinely canonical"]);
    core.close();
  });

  it("idempotence: re-running the rename does not further mutate either active thread", () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "a-ws", circle: "A", version: 0, updatedAt: 100, nextStep: "moved in from A" });
    insertWorkstreamRow(db, { id: "b-ws", circle: "B", version: 0, updatedAt: 200, nextStep: "already in B" });

    core.renameCircle("A", "B");
    const afterFirst = workstreamRows(db, "B");

    core.renameCircle("A", "B");
    expect(workstreamRows(db, "B")).toEqual(afterFirst);
    expect(core.getActiveWorkstreams("B").map((row) => row.id).sort()).toEqual(["a-ws", "b-ws"]);
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
