/**
 * overview() — the "what your agent knows" snapshot: living-model/thread/contradiction composition,
 * the read-only invariant (inspecting never mutates), no-answer-leak (§4.5), and
 * scope isolation.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

function core(): MonetCore {
  let seq = 0;
  return new MonetCore(":memory:", { idGen: () => `c${seq++}`, tauAttach: 1.1, tauAmbiguous: 1.1 });
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
    expect(full.livingModel).toHaveLength(6);
    expect(limited.livingModel).toHaveLength(3);
    expect(limited.livingModel).toEqual(full.livingModel.slice(0, 3));
    expect(limited.activeThreads).toEqual(full.activeThreads);
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
});
