/**
 * overview() — the "what your agent knows" snapshot: living-model/thread/contradiction composition,
 * the read-only invariant (inspecting never mutates), no-answer-leak (§4.5), and
 * scope isolation.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MonetCore,
  OVERVIEW_CONTRADICTION_DETAIL_MAX_CHARS,
  OVERVIEW_ENUMERATION_LIMIT,
  OVERVIEW_EXCEPTION_LIMIT,
} from "../engine";
import { fitOverviewEnvelope, registerMonetCoreTools } from "../mcp-server";
import type { StoragePort } from "../storage";

function core(opts: { staleAfterMs?: number; runtimeModelTag?: string } = {}): MonetCore {
  let seq = 0;
  return new MonetCore(":memory:", {
    idGen: () => `c${seq++}`,
    tauAttach: 1.1,
    tauAmbiguous: 1.1,
    ...opts,
  });
}

const raw = (c: MonetCore): StoragePort => (c as unknown as { db: StoragePort }).db;

async function callOverview(c: MonetCore, args: Record<string, unknown> = {}): Promise<{ text: string; json: Record<string, unknown>; close: () => Promise<void> }> {
  const server = new McpServer({ name: "overview-test", version: "0.0.0" }, { capabilities: { tools: {} } });
  registerMonetCoreTools(server, c, { autoPrewarm: false, checkpointNudge: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "overview-client", version: "0.0.0" });
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "memory_overview", arguments: args }) as { content: Array<{ type: string; text: string }> };
  const text = result.content[0]!.text;
  return { text, json: JSON.parse(text) as Record<string, unknown>, close: () => client.close() };
}

describe("overview composition + invariants", () => {
  it("applies a meaningful living-model limit while preserving ranking and other sections", async () => {
    const c = core();
    for (let index = 0; index < 6; index++) {
      await c.store(`Distinct overview concept ${index}.`, { kind: "fact", resolution: "forceNew" });
    }
    await c.saveWorkstream({ status: "active", nextSteps: ["wire rotation"] });
    const full = c.overview("default");
    const limited = c.overview("default", { conceptLimit: 3 });
    expect(full.livingModel).toHaveLength(5);
    const expanded = c.overview("default", { conceptLimit: 6 });
    expect(expanded.livingModel).toHaveLength(6);
    expect(limited.livingModel).toHaveLength(3);
    expect(limited.livingModel).toEqual(expanded.livingModel.slice(0, 3));
    expect(limited.openContradictions).toEqual(full.openContradictions);
    c.close();
  });

  it("is READ-ONLY: inspecting opens no session and triggers no synthesis", async () => {
    const c = core();
    await c.store("A first fact.", { kind: "fact" });
    await c.store("A second fact.", { kind: "fact" });
    c.endSessionForEval();
    const before = c.stats();
    c.overview("default");
    c.overview("default");
    const after = c.stats();
    expect(after).toEqual(before); // no new session, no concept cleaned (dirty unchanged)
    c.close();
  });

  it("never leaks a concept body (§4.5) — the snapshot carries the topic, not the rationale", async () => {
    const c = core();
    // First sentence is the topic/title (shown); the rationale lives only in the BODY (never shown).
    await c.store("Storage backend choice. The deciding rationale was xyzzy-zero-config-secret.", { kind: "decision" });
    const json = JSON.stringify(c.overview("default"));
    expect(json).not.toContain('"body"');
    expect(json.toLowerCase()).not.toContain("xyzzy-zero-config-secret"); // body rationale never appears
    expect(json).toContain("Storage backend choice"); // the topic legitimately does
    c.close();
  });

  it("is scope-isolated: overview('a') reflects only circle a", async () => {
    const c = core();
    await c.store("Alpha fact about the AuthService.", { circle: "a", kind: "fact" });
    await c.store("Another alpha fact about the AuthService.", { circle: "a", kind: "fact" });
    await c.store("Beta fact about billing in circle b.", { circle: "b", kind: "fact" });
    const a = c.overview("a");
    expect(a.counts.concepts).toBe(2);
    expect(JSON.stringify(a)).not.toContain("billing");
    expect(c.overview("b").counts.concepts).toBe(1);
    c.close();
  });

  it("removes diagnostics, thread state, inventory, and timestamps by key absence", async () => {
    const c = core();
    await c.store("A workbench concept.", { resolution: "forceNew" });
    await c.saveWorkstream({ status: "active", nextSteps: ["continue elsewhere"] });
    await c.store("Another circle concept.", { circle: "other", resolution: "forceNew" });
    const overview = c.overview("default");
    for (const key of ["activeThreads", "graph", "resolutionStats", "health", "otherCircles", "agentId", "generatedAt"]) {
      expect(overview).not.toHaveProperty(key);
    }
    c.close();
  });

  it("keeps gate aggregates and emits actionable exceptions only when present", async () => {
    const c = core({ runtimeModelTag: "current" });
    const clean = c.overview("default").gateStats as Record<string, unknown>;
    expect(Object.keys(clean).sort()).toEqual([
      "delivered", "fires", "overflows", "silences", "total", "windowDays", "windowTotal",
    ].sort());
    expect(clean).not.toHaveProperty("byStage");
    expect(clean).not.toHaveProperty("byMatcher");
    expect(clean).not.toHaveProperty("unverifiedPatterns");
    expect(clean).not.toHaveProperty("malformedPatterns");

    await c.store("Retire this old-model rule.", {
      kind: "rule", resolution: "forceNew",
      rule: { stage: "old stage", scope: "agent", modelTag: "old" },
    });
    expect(c.overview("default").gateStats.retirementCandidates).toHaveLength(1);
    expect(c.overview("default").gateStats).not.toHaveProperty("unexplainedDenies");
    c.close();
  });

  it("returns dirty and stale card queues only on request, with caps and honest signals", async () => {
    const c = core({ staleAfterMs: 5 });
    for (let index = 0; index < OVERVIEW_ENUMERATION_LIMIT + 3; index++) {
      await c.store(`Curation card ${index}.`, { resolution: "forceNew" });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));

    const absent = c.overview("default");
    expect(absent).not.toHaveProperty("dirty");
    expect(absent).not.toHaveProperty("stale");

    const included = c.overview("default", { includeDirty: true, includeStale: true });
    expect(included.dirty).toHaveLength(OVERVIEW_ENUMERATION_LIMIT);
    expect(included.dirty![0]).toEqual(expect.objectContaining({ id: expect.any(String), slug: expect.any(String), kind: "fact", observationCount: 1 }));
    expect(included.dirty![0]).not.toHaveProperty("title");
    expect(included.dirtyTruncated).toBe(true);
    expect(included.dirtyOmitted).toBe(3);
    expect(included.stale).toHaveLength(OVERVIEW_ENUMERATION_LIMIT);
    expect(included.staleTruncated).toBe(true);
    expect(included.staleOmitted).toBe(3);
    c.close();
  });

  it("uses the full evidence-ledger count on dirty/stale cards after supersession", async () => {
    const c = core({ staleAfterMs: 5 });
    const stored = await c.store("Ledger-count curation card.", { resolution: "forceNew" });
    const second = await c.store("Second ledger entry.", { attachTo: stored.conceptId });
    c.supersedeObservation(second.observationId, null);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const overview = c.overview("default", { includeDirty: true, includeStale: true });
    expect(overview.dirty!.find((card) => card.id === stored.conceptId)?.observationCount).toBe(2);
    expect(overview.stale!.find((card) => card.id === stored.conceptId)?.observationCount).toBe(2);
    c.close();
  });

  it("caps contradictions oldest-first, clips detail, and reports the true omitted count", async () => {
    const c = core();
    for (let index = 0; index < OVERVIEW_EXCEPTION_LIMIT + 2; index++) {
      const stored = await c.store(`Contradicted concept ${index}.`, { resolution: "forceNew" });
      c.flagContradiction(stored.conceptId, { detail: `${index}:` + "x".repeat(500) });
      raw(c).prepare(`UPDATE contradictions SET detected_at = ? WHERE concept_id = ?`).run(index, stored.conceptId);
    }
    const overview = c.overview("default");
    expect(overview.openContradictions).toHaveLength(OVERVIEW_EXCEPTION_LIMIT);
    expect(overview.openContradictionsOmitted).toBe(2);
    expect(overview.openContradictions[0]!.detail.startsWith("0:")).toBe(true);
    expect(overview.openContradictions[0]!.detail).toHaveLength(OVERVIEW_CONTRADICTION_DETAIL_MAX_CHARS + "…[truncated]".length);
    expect(overview.openContradictions[0]!.detail.endsWith("…[truncated]")).toBe(true);
    c.close();
  });

  it("caps gate exception queues at source with honest omitted counts", async () => {
    const c = core({ runtimeModelTag: "current" });
    for (let index = 0; index < OVERVIEW_EXCEPTION_LIMIT + 3; index++) {
      await c.store(`Old model rule ${index}.`, {
        kind: "rule", resolution: "forceNew",
        rule: { stage: `old-stage-${index}`, scope: "agent", modelTag: "old" },
      });
    }
    const overview = c.overview("default");
    expect(overview.gateStats.retirementCandidates).toHaveLength(OVERVIEW_EXCEPTION_LIMIT);
    expect(overview.gateStats.retirementCandidatesOmitted).toBe(3);
    expect(c.gateStats("default").retirementCandidates).toHaveLength(OVERVIEW_EXCEPTION_LIMIT + 3);
    c.close();
  });

  it("clips oversized skeleton content as the final envelope rung while preserving identity", async () => {
    const c = core();
    const ids: string[] = [];
    const db = raw(c);
    const referenceContent = "0-" + "s".repeat(8_000);
    const reference = await c.store(referenceContent, { kind: "principle", resolution: "forceNew" });
    await c.ratify({ candidateId: reference.conceptId, verdict: "approve" });
    ids.push(reference.conceptId);
    const embedding = (db.prepare(`SELECT embedding FROM concepts WHERE id = ?`).get(reference.conceptId) as { embedding: string }).embedding;
    const insertConcept = db.prepare(
      `INSERT INTO concepts (id, slug, title, body, kind, embedding, support_count, version, dirty, circle)
       VALUES (?, ?, ?, ?, 'principle', ?, 1, 0, 1, 'default')`,
    );
    const insertRatification = db.prepare(
      `INSERT INTO ratifications (id, subject_concept_id, verdict, packet, ratified_by, circle, created_at, sync_updated_at)
       VALUES (?, ?, 'approve', NULL, 'fixture', 'default', ?, ?)`,
    );
    for (let index = 1; index < 25; index++) {
      const id = `skeleton-${String(index).padStart(2, "0")}`;
      ids.push(id);
      const content = `${index}-` + "s".repeat(8_000);
      insertConcept.run(id, `skeleton-${index}`, content, content, embedding);
      insertRatification.run(`ratification-${index}`, id, index, index);
    }

    const oversized = c.overview("default");
    oversized.skeleton = oversized.skeleton.map((member, index) => ({
      ...member,
      content: `${index}-` + "s".repeat(8_000),
    }));
    const fitted = fitOverviewEnvelope(oversized);
    const text = JSON.stringify(fitted, null, 2);
    const skeleton = fitted.skeleton as Array<{ conceptId: string; content: string }>;
    expect(text.length).toBeLessThanOrEqual(40_000);
    expect(fitted).not.toHaveProperty("truncated");
    expect(fitted.skeletonClipped).toBe(true);
    expect(skeleton.map((member) => member.conceptId).sort()).toEqual(ids.sort());
    expect(skeleton.some((member) => member.content.endsWith("…"))).toBe(true);
    c.close();
  });

  it("fits an adversarial MCP envelope without invoking the fallback", async () => {
    const c = core({ staleAfterMs: 1 });
    for (let index = 0; index < 250; index++) {
      const stored = await c.store(`Adversarial concept ${index}.`, { resolution: "forceNew" });
      c.flagContradiction(stored.conceptId, { detail: `${index}:` + "z".repeat(10_000) });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await callOverview(c, { includeDirty: true, includeStale: true, conceptLimit: 250 });
    expect(result.text.length).toBeLessThanOrEqual(40_000);
    expect(result.json).not.toHaveProperty("truncated");
    expect(result.json).toHaveProperty("counts");
    expect(result.json).toHaveProperty("skeleton");
    expect(result.json.openContradictionsOmitted).toBe(240);
    expect(result.json.dirtyOmitted).toBe(230);
    expect(result.json.stale).toEqual([]);
    await result.close();
    c.close();
  });
});
