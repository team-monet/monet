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
      openQuestions: ["Which threshold should move?"],
      confirmedContext: ["The serial runner is authoritative."],
      decisions: ["Keep resident context minimal."],
      discardedAlternatives: ["Push every workstream at session start."],
      importantEntities: ["src/mcp-server.ts"],
      nextSteps: ["Run the serial suite."],
    });

    const { list, detail } = await withWorkstreamServer(core, async (client) => ({
      list: toolJson(await client.callTool({ name: "memory_workstreams", arguments: {} })),
      detail: toolJson(await client.callTool({ name: "memory_workstreams", arguments: { id: saved.id } })),
    }));

    expect(list).toEqual({ workstreams: [{ id: saved.id, title: saved.title, status: "paused" }] });
    expect(detail).toEqual({ id: saved.id, title: saved.title, ...saved.payload });
    expect(JSON.stringify(list)).not.toContain("Which threshold should move?");
    core.close();
  });

  it("walks fat detail pages without gaps or duplicates in the documented slot order", async () => {
    const core = new MonetCore(":memory:");
    const expected = [
      ...Array.from({ length: 10 }, (_, index) => ({ slot: "openQuestions", value: `question-${index}-${"q".repeat(1_500)}` })),
      ...Array.from({ length: 10 }, (_, index) => ({ slot: "decisions", value: `decision-${index}-${"d".repeat(1_500)}` })),
      ...Array.from({ length: 10 }, (_, index) => ({ slot: "discardedAlternatives", value: `discarded-${index}-${"a".repeat(1_500)}` })),
      ...Array.from({ length: 10 }, (_, index) => ({ slot: "confirmedContext", value: `context-${index}-${"c".repeat(1_500)}` })),
      ...Array.from({ length: 10 }, (_, index) => ({ slot: "importantEntities", value: `entity-${index}-${"e".repeat(1_500)}` })),
      ...Array.from({ length: 10 }, (_, index) => ({ slot: "nextSteps", value: `step-${index}-${"s".repeat(1_500)}` })),
    ] as const;
    const payload = Object.fromEntries(
      ["openQuestions", "decisions", "discardedAlternatives", "confirmedContext", "importantEntities", "nextSteps"]
        .map((slot) => [slot, expected.filter((entry) => entry.slot === slot).map((entry) => entry.value)]),
    );
    const saved = await core.saveWorkstream({ status: "active", ...payload } as Parameters<MonetCore["saveWorkstream"]>[0]);

    const recovered: Array<{ slot: string; value: string }> = [];
    await withWorkstreamServer(core, async (client) => {
      let detailOffset = 0;
      do {
        const detail = toolJson(await client.callTool({
          name: "memory_workstreams",
          arguments: { id: saved.id, detailOffset },
        }));
        const pageEntries = ["openQuestions", "decisions", "discardedAlternatives", "confirmedContext", "importantEntities", "nextSteps"]
          .flatMap((slot) => ((detail[slot] as string[] | undefined) ?? []).map((value) => ({ slot, value })));
        expect(pageEntries.length).toBeGreaterThan(0);
        recovered.push(...pageEntries);
        detailOffset += pageEntries.length;
        if (detail.detailOmitted === undefined) break;
        expect(detail.detailOmitted).toBe(expected.length - detailOffset);
      } while (true);
    });

    expect(recovered).toEqual(expected);
    core.close();
  });

  it("delivers one oversized entry alone with clipping and an honest continuation offset", async () => {
    const core = new MonetCore(":memory:");
    const oversized = `oversized-${"z".repeat(80_000)}`;
    const saved = await core.saveWorkstream({
      status: "active",
      openQuestions: [oversized],
      nextSteps: ["recover me next"],
    });

    const first = await withWorkstreamServer(core, (client) =>
      client.callTool({ name: "memory_workstreams", arguments: { id: saved.id, detailOffset: 0 } }),
    ) as { content: Array<{ text: string }> };
    const firstDetail = toolJson(first);
    expect(first.content[0]!.text.length).toBeLessThanOrEqual(40_000);
    expect((firstDetail.openQuestions as string[])).toHaveLength(1);
    expect((firstDetail.openQuestions as string[])[0]).toContain("…[truncated");
    expect(firstDetail).toMatchObject({
      detailOffset: 0,
      detailTruncated: true,
      detailValuesClipped: true,
      detailOmitted: 1,
    });

    const second = await withWorkstreamServer(core, (client) =>
      client.callTool({ name: "memory_workstreams", arguments: { id: saved.id, detailOffset: 1 } }),
    );
    expect(toolJson(second)).toMatchObject({ detailOffset: 1, nextSteps: ["recover me next"] });
    core.close();
  });

  it("keeps offset-zero default behavior unchanged for small details", async () => {
    const core = new MonetCore(":memory:");
    const saved = await core.saveWorkstream({
      status: "active",
      openQuestions: ["small question"],
      decisions: ["small decision"],
      nextSteps: ["small step"],
    });
    const detail = await withWorkstreamServer(core, (client) =>
      client.callTool({ name: "memory_workstreams", arguments: { id: saved.id } }),
    );
    expect(toolJson(detail)).toEqual({ id: saved.id, title: saved.title, ...saved.payload });
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
      openQuestions: ["how to tune dedup thresholds?"],
      nextSteps: ["wire prewarm"],
    });
    expect(w1.payload.openQuestions).toEqual(["how to tune dedup thresholds?"]);
    expect(w1.version).toBe(0);
    expect(core.isDirty(w1.id)).toBe(false); // agent-authored → no synthesis needed

    const w2 = await core.saveWorkstream({
      status: "active",
      openQuestions: [],
      nextSteps: ["wire prewarm", "add contradiction tier"],
      decisions: ["use MiniLM-384 locally"],
    });
    expect(w2.id).toBe(w1.id); // same workstream, updated in place
    expect(w2.version).toBe(1);
    expect(w2.payload.decisions).toEqual(["use MiniLM-384 locally"]);
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
        { status: "active", openQuestions: [], nextSteps: [] },
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
      { status: "active", nextSteps: ["caller write"] },
      { circle: "race" },
    );

    expect(saved.id).toBe("interleaved");
    expect(saved.version).toBe(1);
    expect(saved.payload.nextSteps).toEqual(["caller write"]);
    expect(workstreamRows(port, "race")).toEqual([
      { id: "interleaved", version: 1, body: JSON.stringify(saved.payload, null, 2) },
    ]);
    expect(revisionVersions(port, saved.id)).toEqual([0, 1]);
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
      { status: "active", nextSteps: ["caller write"] },
      { circle: "snapshot" },
    );

    expect(saved.version).toBe(0);
    expect(saved.payload.nextSteps).toEqual(["caller write"]);
    expect(workstreamRows(port, "snapshot")).toEqual([
      {
        id: saved.id,
        version: 1,
        body: JSON.stringify({ status: "active", nextSteps: ["competing write"] }, null, 2),
      },
    ]);
    expect(revisionVersions(port, saved.id)).toEqual([0, 1]);
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
        first.saveWorkstream({ status: "active", nextSteps: ["from first"] }, { circle: "shared" }),
        second.saveWorkstream({ status: "active", nextSteps: ["from second"] }, { circle: "shared" }),
      ]);

      const db = rawDb(first);
      const rows = workstreamRows(db, "shared");
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe(1);
      expect(new Set([a.id, b.id])).toEqual(new Set([rows[0].id]));
      expect(new Set([a.version, b.version])).toEqual(new Set([0, 1]));
      expect(revisionVersions(db, rows[0].id)).toEqual([0, 1]);

      first.close();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("different-circle workstream saves do not cross-mutate", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });

    const alpha = await core.saveWorkstream({ status: "active", nextSteps: ["alpha step"] }, { circle: "alpha" });
    const beta = await core.saveWorkstream({ status: "active", nextSteps: ["beta step"] }, { circle: "beta" });
    const alpha2 = await core.saveWorkstream({ status: "active", nextSteps: ["alpha step 2"] }, { circle: "alpha" });

    expect(alpha2.id).toBe(alpha.id);
    expect(alpha2.version).toBe(1);
    expect(beta.version).toBe(0);
    expect(core.getActiveWorkstreams("alpha").map((w) => w.payload.nextSteps)).toEqual([["alpha step 2"]]);
    expect(core.getActiveWorkstreams("beta").map((w) => w.payload.nextSteps)).toEqual([["beta step"]]);
    core.close();
  });

  it("restores active workstreams in a NEW session (DB reopen = next session)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-ws-"));
    const dbPath = join(dir, "ws.db");
    try {
      const s1 = new MonetCore(dbPath);
      await s1.saveWorkstream(
        { status: "active", openQuestions: ["resume #242?"], nextSteps: ["build prewarm ranking"] },
        { summary: "end of session 1" },
      );
      s1.close();

      const s2 = new MonetCore(dbPath); // "next session" — fresh instance, same store
      const restored = s2.getActiveWorkstreams();
      expect(restored).toHaveLength(1);
      expect(restored[0].payload.openQuestions).toEqual(["resume #242?"]);
      expect(restored[0].payload.nextSteps).toEqual(["build prewarm ranking"]);
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
      decisions: ["use approach B"],
      discardedAlternatives: ["approach A — failed on X"],
      nextSteps: ["write tests"],
    });
    expect(core.getActiveWorkstreams()).toHaveLength(1); // five turns → one durable workstream
    expect(w.payload.discardedAlternatives?.[0]).toContain("approach A");
    core.close();
  });

  it("a normal store() never folds into a workstream, and search excludes workstreams", async () => {
    const core = new MonetCore(":memory:");
    // payload text deliberately overlaps a real concept we then store
    const w = await core.saveWorkstream({ status: "active", nextSteps: ["use SQLite for storage backend"] });

    const s = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    expect(s.conceptId).not.toBe(w.id); // did NOT attach to the workstream
    expect(s.action).toBe("created");

    const hits = await core.search("sqlite storage backend");
    expect(hits.some((h) => h.id === w.id)).toBe(false); // workstream never appears as a search card
    expect(core.conceptCount()).toBe(1); // conceptCount excludes the workstream
    core.close();
  });

  it("'done' workstreams drop out of the active restore set", async () => {
    const core = new MonetCore(":memory:");
    await core.saveWorkstream({ status: "active", nextSteps: ["ship it"] });
    expect(core.getActiveWorkstreams()).toHaveLength(1);
    await core.saveWorkstream({ status: "done", nextSteps: [] });
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

    const saved = await core.saveWorkstream({ status: "active", nextSteps: ["next"] }, { circle: "peer" });
    expect(saved.id).toBe("survivor");
    expect(saved.version).toBe(1);
    expect(workstreamStatuses(db, "peer").find((s) => s.id === "loser")?.status).toBe("archived"); // never resurrected
    core.close();
  });

  it("saveWorkstream rejects a connector-owned same-slug row even with an ordinary candidate present", async () => {
    const core = new MonetCore(":memory:", { embedder: new StaticEmbeddingProvider() });
    const db = rawDb(core);
    insertWorkstreamRow(db, { id: "ordinary", circle: "guard", version: 0, updatedAt: 100, nextStep: "ordinary" });
    insertWorkstreamRow(db, { id: "connector", circle: "guard", version: 1, updatedAt: 200, nextStep: "connector" });
    db.prepare(`UPDATE concepts SET source_identity = ? WHERE id = ?`).run("source://guard", "connector");

    await expect(core.saveWorkstream({ status: "active", nextSteps: ["caller"] }, { circle: "guard" }))
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
    expect(active[0].payload.nextSteps).toEqual(["moved in from A"]);
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
    expect(active[0].payload.nextSteps).toEqual(["active, genuinely canonical"]);
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
    await core.saveWorkstream({ status: "active", nextSteps: ["only workstream"] }, { circle: "solo-a" });

    core.renameCircle("solo-a", "solo-b");

    const db = rawDb(core);
    expect(workstreamRows(db, "solo-b")).toHaveLength(1); // no collision minted, so nothing to canonicalize
    const active = core.getActiveWorkstreams("solo-b");
    expect(active).toHaveLength(1);
    expect(active[0].slug).toBe("workstream:solo-b");
    expect(active[0].payload.nextSteps).toEqual(["only workstream"]);
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

    const saved = await core.saveWorkstream({ status: "active", nextSteps: ["checkpoint after merge"] }, { circle: "B" });

    expect(saved.id).toBe("b-active"); // updates the survivor, NOT the higher-updated_at archived loser
    expect(saved.version).toBe(2); // b-active was version 1 before this checkpoint

    const loser = (db.prepare(`SELECT status FROM concepts WHERE id = ?`).get("b-archived-newer") as { status: string });
    expect(loser.status).toBe("archived"); // never resurrected back to active

    const active = core.getActiveWorkstreams("B");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("b-active");
    expect(active[0].payload.nextSteps).toEqual(["checkpoint after merge"]);
    core.close();
  });
});
