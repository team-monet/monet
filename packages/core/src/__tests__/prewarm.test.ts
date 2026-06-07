import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

/**
 * Prewarm (#242, ADR §4.2): query-independent session-start state — active workstreams,
 * the living model (ranked top concepts), open contradictions. No query supplied; bounded;
 * structural only (never concept bodies).
 */
describe("prewarm — query-independent session start (#242)", () => {
  it("returns the three tiers with NO query, contradictions stubbed", async () => {
    const core = new MonetCore(":memory:");
    await core.store("We decided to use SQLite as the storage backend for Monet Local.", { kind: "decision" });

    const state = core.prewarm(); // <- no query argument at all
    expect(Array.isArray(state.activeWorkstreams)).toBe(true);
    expect(state.topConcepts.length).toBe(1);
    expect(state.openContradictions).toEqual([]); // pending #240
    core.close();
  });

  it("ranks the living model by confidence × usefulness × recency", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    await core.store("The team prefers pytest with httpx for Python testing.");

    // Fetching A twice marks it useful (each fetch is a touch); B is never touched.
    await core.getConcept(a.conceptId);
    await core.getConcept(a.conceptId);

    const top = core.prewarm().topConcepts;
    expect(top[0].id).toBe(a.conceptId); // the used concept leads the living model
    core.close();
  });

  it("is bounded by conceptLimit and ranked", async () => {
    const core = new MonetCore(":memory:");
    await core.store("Alpha: use SQLite locally.");
    await core.store("Bravo: prefer pytest for tests.");
    await core.store("Charlie: deploy via GitHub Actions.");

    const top = core.prewarm("default", { conceptLimit: 2 }).topConcepts;
    expect(top).toHaveLength(2); // capped
    core.close();
  });

  it("carries identity + shape, never the concept body (no-answer-leak, §4.5)", async () => {
    const core = new MonetCore(":memory:");
    await core.store("We decided to use SQLite as the storage backend for Monet Local.", { kind: "decision" });

    const card = core.prewarm().topConcepts[0] as unknown as Record<string, unknown>;
    expect(card.body).toBeUndefined();
    expect(card.summary).toBeUndefined();
    expect(card.kind).toBe("decision");
    expect(typeof card.confidence).toBe("number");
    core.close();
  });

  it("separates workstreams (activeWorkstreams) from knowledge (topConcepts)", async () => {
    const core = new MonetCore(":memory:");
    const ws = await core.saveWorkstream({ status: "active", nextSteps: ["resume prewarm"] });
    const c = await core.store("We use SQLite for Monet Local storage.");

    const state = core.prewarm();
    expect(state.activeWorkstreams.map((w) => w.id)).toContain(ws.id);
    expect(state.topConcepts.map((t) => t.id)).toContain(c.conceptId);
    expect(state.topConcepts.map((t) => t.id)).not.toContain(ws.id); // workstream never in the living model
    core.close();
  });
});
