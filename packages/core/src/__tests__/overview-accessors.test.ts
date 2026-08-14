/**
 * The honesty backbone of the "what your agent knows" graph panel. Two regressions verified
 * against the real engine during design: (1) entity hubs must be GATED (members≥2 + df/n≤0.5,
 * structural-first) or stopword-grade nouns outrank real symbols; (2) "most connected" must use
 * THREAD edges only or `related` similarity edges float near-duplicate filler to the top.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

function core(): MonetCore {
  let seq = 0;
  return new MonetCore(":memory:", { idGen: () => `c${seq++}`, tauAttach: 1.1, tauAmbiguous: 1.1 });
}

describe("topEntityHubs — gated for honesty", () => {
  it("ranks a real shared symbol above high-frequency filler nouns", async () => {
    const c = core();
    for (let i = 0; i < 12; i++) {
      await c.store(`Filler topic Kappa${i} concerns widget${i} only.`);
      c.endSessionForEval();
    }
    await c.store("The AuthService validates requests in src/auth/service.ts.");
    await c.store("AuthService session checks moved into src/auth/service.ts.");
    await c.store("AuthService now rotates keys; still in src/auth/service.ts.");
    const hubs = c.topEntityHubs("default");
    expect(hubs[0].key).toBe("id:AuthService");
    expect(hubs.some((h) => h.key === "path:src/auth/service.ts")).toBe(true);
    // The df=12 filler nouns (topic/concern/filler) are excluded by the df/n ≤ 0.5 gate.
    expect(hubs.some((h) => /topic|concern|filler/.test(h.key))).toBe(false);
    c.close();
  });
});

describe("topConnectedConcepts — thread edges only", () => {
  it("ranks worked-together concepts and excludes similarity-only filler", async () => {
    const c = core();
    // Filler near-dupes (own sessions): high `related` similarity, ZERO thread edges.
    for (let i = 0; i < 4; i++) {
      await c.store("The widget pipeline runs a nightly batch job on schedule.");
      c.endSessionForEval();
    }
    // Auth cluster in ONE session: connected by co_occurred (a thread edge).
    await c.store("AuthService alpha handles login.");
    await c.store("AuthService beta handles logout.");
    await c.store("AuthService gamma handles refresh.");
    const connected = c.topConnectedConcepts("default");
    expect(connected.length).toBe(3);
    expect(connected.every((cc) => cc.title.includes("AuthService"))).toBe(true);
    // The filler IS connected — just by similarity, not thread edges (so it's excluded above).
    expect(c.edges({ type: "related" }).length).toBeGreaterThan(0);
    c.close();
  });
});

describe("edgeCountsByType — undirected", () => {
  it("counts a symmetric edge once per pair, not once per stored direction", async () => {
    const c = core();
    await c.store("The AuthService validates requests.");
    await c.store("AuthService also issues tokens."); // same session → co_occurred + shared about
    const counts = Object.fromEntries(c.edgeCountsByType("default").map((e) => [e.type, e.count]));
    expect(counts.co_occurred).toBe(1); // one undirected pair, though stored both directions
    if (counts.about) expect(counts.about).toBe(1);
    c.close();
  });
});

describe("topThread — the largest worked-together cluster", () => {
  it("is session-scoped and null when there is no co-occurrence", async () => {
    const c = core();
    await c.store("Thread member one about AuthService.");
    await c.store("Thread member two about AuthService."); // same session ⇒ a 2-member thread
    c.endSessionForEval();
    await c.store("A lone fact in its own later session.");
    const t = c.topThread("default");
    expect(t).not.toBeNull();
    expect(t!.size).toBe(2);
    expect(t!.members.length).toBe(2);

    const solo = core();
    await solo.store("Just one memory, no co-occurrence at all.");
    expect(solo.topThread("default")).toBeNull();
    solo.close();
    c.close();
  });
});
