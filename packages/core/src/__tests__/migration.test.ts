/**
 * Circle-migration primitives (the apply layer behind with-monet's interactive memory migration):
 *   - listMemories(circle, {withProvenance})  — enumerate a circle as cards + where each came from
 *   - reassignCircle(id, toCircle)            — MOVE a concept (+ obs + graph membership), or MERGE
 *                                               it into a matching target, deduping
 * The load-bearing guarantees: bodies never leak from listMemories; a reassign never strands a
 * cross-circle edge; and a move into a circle that already holds the same memory dedupes instead of
 * duplicating (no re-embedding).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";

/** Distinct concepts per store (dedup off) — to exercise the graph the way edges.test does. */
function freshCore(): MonetCore {
  return new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
}

async function seedFiller(core: MonetCore, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await core.store(`Filler topic Kappa${i} concerns widget${i} only.`);
    core.endSessionForEval();
  }
}

describe("listMemories", () => {
  it("returns structural cards (never a body) and excludes workstreams", async () => {
    const core = new MonetCore(":memory:");
    await core.store("We cache auth tokens in Redis with a 5-minute TTL.", { circle: "c1" });
    await core.saveWorkstream({ status: "active", nextSteps: ["resume the cache work"] }, { circle: "c1" });

    const list = core.listMemories("c1");
    expect(list).toHaveLength(1); // the workstream concept is filtered out
    expect(list[0].kind).not.toBe("workstream");
    expect(list[0].title.length).toBeGreaterThan(0);
    expect(list[0]).not.toHaveProperty("body"); // cards only — the answer is never in the list
    expect(list[0]).not.toHaveProperty("provenance"); // omitted unless requested
    core.close();
  });

  it("pages with limit/offset over a stable order (a big legacy circle stays fully enumerable)", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 }); // distinct concepts
    for (let i = 0; i < 5; i++) await core.store(`Distinct fact number ${i} about widget ${i}.`, { circle: "c" });
    const all = core.listMemories("c");
    expect(all).toHaveLength(5);
    const ids = all.map((m) => m.id);
    expect(core.listMemories("c", { limit: 2, offset: 0 }).map((m) => m.id)).toEqual(ids.slice(0, 2));
    expect(core.listMemories("c", { limit: 2, offset: 2 }).map((m) => m.id)).toEqual(ids.slice(2, 4));
    const last = core.listMemories("c", { limit: 2, offset: 4 });
    expect(last.map((m) => m.id)).toEqual(ids.slice(4)); // one left over
    core.close();
  });

  it("a keyset cursor enumerates the whole circle even as pages are reassigned OUT (no skips)", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    for (let i = 0; i < 6; i++) await core.store(`Distinct fact ${i} about widget ${i}.`, { circle: "default" });
    const seen: string[] = [];
    let cursor: { updatedAt: number; id: string } | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = core.listMemories("default", { limit: 2, cursor });
      if (page.length === 0) break;
      const last = page[page.length - 1];
      cursor = { updatedAt: last.updatedAt, id: last.id };
      for (const m of page) {
        seen.push(m.id);
        core.reassignCircle(m.id, "proj"); // drain the source as we page — an offset would skip rows here
      }
      if (page.length < 2) break;
    }
    expect(new Set(seen).size).toBe(6); // every memory enumerated exactly once despite the shrinking source
    expect(core.conceptCount("default")).toBe(0);
    expect(core.conceptCount("proj")).toBe(6);
    core.close();
  });

  it("withProvenance aggregates the working dirs of every session that contributed evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-mig-"));
    const dbPath = join(dir, "monet.db");
    try {
      // Same content from two different projects, into the same legacy "default" circle → one concept
      // (dedup), two observations, two provenance paths. (Different instances = different sessions.)
      const a = new MonetCore(dbPath, { scopeContext: "/work/acme-api" });
      await a.store("We use SQLite for local storage.");
      a.close();
      const b = new MonetCore(dbPath, { scopeContext: "/work/acme-web" });
      await b.store("We use SQLite for local storage.");
      b.close();

      const v = new MonetCore(dbPath);
      const list = v.listMemories("default", { withProvenance: true });
      expect(list).toHaveLength(1);
      expect(list[0].supportCount).toBe(2);
      expect(list[0].provenance).toEqual(["/work/acme-api", "/work/acme-web"]); // sorted, distinct
      v.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reassignCircle — move", () => {
  it("relocates the concept and its observations; the source circle is left empty", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("Acme API stores everything in Postgres.", { circle: "default" });

    const r = core.reassignCircle(a.conceptId, "acme-api");
    expect(r).not.toBeNull();
    expect(r!.action).toBe("moved");
    expect(r!.observationsMoved).toBe(1);
    expect(core.conceptCount("default")).toBe(0);
    expect(core.conceptCount("acme-api")).toBe(1);
    expect(core.circleOf(a.conceptId)).toBe("acme-api");

    const c = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    expect(c.circle).toBe("acme-api");
    expect(c.observations).toHaveLength(1);
    core.close();
  });

  it("re-homes graph membership in the new circle and strands NO cross-circle edge", async () => {
    const core = freshCore();
    await seedFiller(core, 25); // realistic corpus so the hub gate doesn't suppress everything
    const a = await core.store("The AuthService validates every request.");
    const b = await core.store("We split AuthService into smaller modules."); // same open session as a
    // Precondition: a shared rare entity links them in "default".
    expect(core.edges({ circle: "default", type: "about" }).some((e) => e.srcId === a.conceptId && e.dstId === b.conceptId)).toBe(true);

    core.reassignCircle(a.conceptId, "proj");
    core.reassignCircle(b.conceptId, "proj");

    // No edge in "default" touches either moved concept (no cross-circle dangling edge).
    const stranded = core
      .edges({ circle: "default" })
      .some((e) => [a.conceptId, b.conceptId].includes(e.srcId) || [a.conceptId, b.conceptId].includes(e.dstId));
    expect(stranded).toBe(false);

    // The two reconnect inside "proj" — via the shared entity (about) and same-session co-occurrence.
    expect(core.edges({ circle: "proj", type: "about" }).some((e) => e.srcId === a.conceptId && e.dstId === b.conceptId)).toBe(true);
    expect(core.edges({ circle: "proj", type: "co_occurred" }).some((e) => e.srcId === a.conceptId && e.dstId === b.conceptId)).toBe(true);
    // Entity membership followed the concept.
    expect(core.conceptEntities(a.conceptId)).toContain("id:AuthService");
    core.close();
  });

  it("rebuilds an asserted edge when the referenced concept arrives in the circle later", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const target = await core.store("The migration plan for the API.", { circle: "default" });
    const referrer = await core.store(`Switched the API to Postgres. supports: #${target.concept.slug}`, { circle: "default" });
    // The asserted edge exists in "default" at store time.
    expect(core.edges({ circle: "default", type: "supports" }).some((e) => e.srcId === referrer.conceptId && e.dstId === target.conceptId)).toBe(true);

    // Move the REFERRER first — its target isn't in "proj" yet, so the edge can't resolve on this move.
    core.reassignCircle(referrer.conceptId, "proj");
    expect(core.edges({ circle: "proj", type: "supports" })).toHaveLength(0);

    // Now move the TARGET — its arrival must rebuild the incoming asserted edge in "proj".
    core.reassignCircle(target.conceptId, "proj");
    expect(core.edges({ circle: "proj", type: "supports" }).some((e) => e.srcId === referrer.conceptId && e.dstId === target.conceptId)).toBe(true);
    core.close();
  });

  it("re-homes graph edges on reassign even when graph WRITES are disabled (don't just delete them)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-mig-"));
    const dbPath = join(dir, "monet.db");
    try {
      // Build a graph with edges under a graph-ENABLED open (shared rare entity → an `about` edge).
      const a = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      await a.store("The AuthService validates every request.");
      await a.store("We split AuthService into smaller modules.");
      expect(a.edges({ circle: "default", type: "about" }).length).toBeGreaterThan(0);
      a.close();

      // Reopen with graph writes DISABLED, then migrate both concepts.
      const b = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1, graphEnabled: false });
      for (const m of b.listMemories("default")) b.reassignCircle(m.id, "proj");

      // The old circle is left with no stranded cross-circle edges, AND the graph is rebuilt in "proj"
      // — not silently deleted (which the version-gated backfill would never restore).
      expect(b.edges({ circle: "default" })).toHaveLength(0);
      expect(b.edges({ circle: "proj", type: "about" }).length).toBeGreaterThan(0);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when the target circle is the current one", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("Some fact.", { circle: "c1" });
    const r = core.reassignCircle(a.conceptId, "c1");
    expect(r!.action).toBe("noop");
    expect(r!.observationsMoved).toBe(0);
    core.close();
  });

  it("returns null for a missing id and refuses to reassign a workstream", async () => {
    const core = new MonetCore(":memory:");
    expect(core.reassignCircle("does-not-exist", "x")).toBeNull();
    const ws = await core.saveWorkstream({ status: "active", nextSteps: ["x"] }, { circle: "c1" });
    expect(() => core.reassignCircle(ws.id, "c2")).toThrow(/workstream/);
    core.close();
  });
});

describe("sourceRefs provenance — recorded regardless of graph mode", () => {
  it("records concept-level sourceRefs even with the graph DISABLED (the capture idempotency key)", async () => {
    // Regression: the concept-level source_refs merge used to sit inside `if (graphEnabled)`, so a
    // graph-off runtime never recorded provenance — and a source-keyed "did I already capture this?"
    // probe would always say "no". Provenance must be recorded independent of graph derivation.
    const core = new MonetCore(":memory:", { graphEnabled: false });
    const r = await core.store("Build conventions: never run a root-level build.", {
      circle: "acme-api",
      sourceRefs: ["/work/acme-api/AGENTS.md"],
    });
    // gather() exposes the concept-level source_refs on its ranked cards.
    const g = await core.gather("Build conventions: never run a root-level build.", { circle: "acme-api" });
    const card = g.ranked.find((c) => c.id === r.conceptId);
    expect(card?.sourceRefs).toContain("/work/acme-api/AGENTS.md");
    core.close();
  });
});

describe("reassignCircle — merge (dedup into an existing target)", () => {
  it("folds the source into a matching target instead of duplicating it", async () => {
    const core = new MonetCore(":memory:"); // default thresholds ⇒ identical content resolves as same concept
    const a = await core.store("We standardized on the jose library for auth tokens.", { circle: "default" });
    const b = await core.store("We standardized on the jose library for auth tokens.", { circle: "acme-api" });
    expect(a.conceptId).not.toBe(b.conceptId); // distinct: different circles don't cross-dedup at store time

    const r = core.reassignCircle(a.conceptId, "acme-api");
    expect(r!.action).toBe("merged");
    expect(r!.conceptId).toBe(b.conceptId); // the pre-existing target survives
    expect(r!.mergedIntoId).toBe(b.conceptId);

    expect(core.conceptCount("default")).toBe(0); // source gone
    expect(core.conceptCount("acme-api")).toBe(1); // NOT duplicated
    expect(core.circleOf(a.conceptId)).toBeNull(); // source row removed

    const merged = (await core.getConcept(b.conceptId, { synthesize: false }))!;
    expect(merged.supportCount).toBe(2); // support summed
    expect(merged.observations).toHaveLength(2); // both observations now under the target
    expect(merged.needsSynthesis).toBe(true); // marked dirty to re-synthesize the combined body
    core.close();
  });

  it("unions sourceRefs and preserves a disputed source's status on merge", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("We standardized on the jose library for auth tokens.", {
      circle: "default",
      sourceRefs: ["/work/default/NOTES.md"],
    });
    const b = await core.store("We standardized on the jose library for auth tokens.", {
      circle: "acme-api",
      sourceRefs: ["/work/acme-api/AGENTS.md"],
    });
    core.flagContradiction(a.conceptId, { detail: "jose vs jsonwebtoken" }); // source is disputed before the merge

    const r = core.reassignCircle(a.conceptId, "acme-api");
    expect(r!.action).toBe("merged");
    const target = r!.conceptId;

    // Both sources' return-to-source pointers survive (gather exposes concept-level source_refs).
    const g = await core.gather("jose library auth tokens", { circle: "acme-api" });
    const card = g.ranked.find((c) => c.id === target);
    expect(card?.sourceRefs).toEqual(expect.arrayContaining(["/work/acme-api/AGENTS.md", "/work/default/NOTES.md"]));

    // The carried-over open contradiction keeps the survivor disputed — not silently restored to active.
    expect((await core.getConcept(target, { synthesize: false }))!.status).toBe("disputed");
    expect(core.getOpenContradictions("acme-api").some((c) => c.conceptId === target)).toBe(true);
    core.close();
  });

  it("an asserted reference to a merged-away source still resolves to the survivor (alias)", async () => {
    const core = new MonetCore(":memory:");
    const target = await core.store("We standardized on the jose library for auth tokens everywhere.", { circle: "proj" });
    const src = await core.store("We standardized on the jose library for auth tokens.", { circle: "default" });
    expect(src.conceptId).not.toBe(target.conceptId); // distinct concepts, different slugs
    // A separate concept asserts an edge to the SOURCE (by id).
    const referrer = await core.store(`Key rotation runbook for the platform. supports: #${src.conceptId}`, { circle: "default" });
    expect(referrer.conceptId).not.toBe(src.conceptId);

    // Move the referrer first (target not in "proj" yet), then merge the source into "proj".
    core.reassignCircle(referrer.conceptId, "proj");
    const r = core.reassignCircle(src.conceptId, "proj");
    expect(r!.action).toBe("merged");
    expect(r!.conceptId).toBe(target.conceptId);

    // The asserted edge survives the merge — re-pointed onto the survivor via the carried-over alias.
    expect(core.edges({ circle: "proj", type: "supports" }).some((e) => e.srcId === referrer.conceptId && e.dstId === target.conceptId)).toBe(true);
    core.close();
  });
});

describe("batchReassignCircle — forceNew vs auto, per-item error capture", () => {
  it("forceNew keeps concepts distinct at the destination and records possible_duplicate_of edges", async () => {
    const core = new MonetCore(":memory:"); // default dedup thresholds
    // Identical content in two circles guarantees cosine >= tauAttach.
    await core.store("We use SQLite for local persistence.", { circle: "src" });
    await core.store("We use SQLite for local persistence.", { circle: "dst" });

    const srcIds = core.listMemories("src").map((m) => m.id);
    const result = core.batchReassignCircle(srcIds, "dst", { resolution: "forceNew" });
    // forceNew: moved, not merged.
    expect(result.counts.moved).toBe(1);
    expect(result.counts.merged).toBe(0);
    expect(result.counts.error).toBe(0);
    // Near-match → possible_duplicate_of edge recorded in dst.
    const dupEdges = core.edges({ circle: "dst", type: "possible_duplicate_of" });
    expect(dupEdges.length).toBeGreaterThan(0);
    core.close();
  });

  it("auto resolution merges a matching concept on batch move", async () => {
    const core = new MonetCore(":memory:");
    await core.store("We use SQLite for local persistence.", { circle: "src" });
    await core.store("We use SQLite for local persistence.", { circle: "dst" });

    const srcIds = core.listMemories("src").map((m) => m.id);
    const result = core.batchReassignCircle(srcIds, "dst", { resolution: "auto" });
    expect(result.counts.merged).toBe(1);
    expect(result.counts.moved).toBe(0);
    expect(result.counts.error).toBe(0);
    expect(core.conceptCount("src")).toBe(0);
    core.close();
  });

  it("per-item error is captured for a deleted id mid-batch without aborting remaining items", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const a = await core.store("Fact A.", { circle: "src" });
    const b = await core.store("Fact B.", { circle: "src", resolution: "forceNew" });

    // Delete concept B directly to simulate a mid-batch missing id.
    // We simulate by including a bogus id in the batch alongside a real one.
    const result = core.batchReassignCircle([a.conceptId, "nonexistent-id", b.conceptId], "dst");

    expect(result.counts.moved).toBe(2); // A and B both moved successfully
    expect(result.counts.error).toBe(1); // the nonexistent-id errored
    // The errored entry carries the id and error message.
    const errEntry = result.results.find((r) => "error" in r && r.action === "error") as { id: string; action: "error"; error: string } | undefined;
    expect(errEntry?.id).toBe("nonexistent-id");
    expect(errEntry?.error).toBeTruthy();
    // Real concepts moved.
    expect(core.circleOf(a.conceptId)).toBe("dst");
    expect(core.circleOf(b.conceptId)).toBe("dst");
    core.close();
  });
});
