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
});
