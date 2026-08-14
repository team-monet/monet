/**
 * Alias resolution tests (v0.5.0): circle_aliases lookup layer.
 *
 * Coverage:
 *   - store()-to-alias-name: observation rows record the canonical circle name
 *   - MCP-layer: fetch with circle='old-alias' resolves (scope enforcement passes)
 *   - collision (two aliases → one canonical): both write correctly to the canonical circle
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

describe("alias resolution — store-to-alias lands canonical", () => {
  it("store() to an alias name writes the concept to the canonical circle", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    // Populate the "old" circle, then rename it to "new".
    await core.store("Original fact.", { circle: "old-name" });
    core.renameCircle("old-name", "new-name");

    // Writing to "old-name" now resolves via the alias.
    const r = await core.store("New fact after rename.", { circle: "old-name", resolution: "forceNew" });
    expect(core.circleOf(r.conceptId)).toBe("new-name");

    // Observation row: circle column must carry the CANONICAL name, not the alias.
    const concept = await core.getConcept(r.conceptId, { synthesize: false });
    expect(concept!.circle).toBe("new-name");

    core.close();
  });

  it("resolveCircleName returns identity when no alias exists", () => {
    const core = new MonetCore(":memory:");
    expect(core.resolveCircleName("no-alias")).toBe("no-alias");
    core.close();
  });
});

describe("alias resolution — explicit circle fetch after rename", () => {
  it("fetch with circle='old-alias' resolves to the correct canonical concept", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("Fact in proj.", { circle: "proj-v1" });
    core.renameCircle("proj-v1", "proj-v2");

    // circleOf should return the canonical name.
    const home = core.circleOf(r.conceptId);
    expect(home).toBe("proj-v2");

    // The MCP fetch gate uses: homeCircle !== scope(circle).
    // scope() now calls resolveCircleName, so "proj-v1" resolves to "proj-v2".
    // homeCircle === resolvedCircle ⇒ gate passes.
    const resolvedCaller = core.resolveCircleName("proj-v1");
    expect(resolvedCaller).toBe("proj-v2");
    expect(home).toBe(resolvedCaller); // gate passes

    core.close();
  });
});

describe("alias resolution — collision: two aliases → one canonical", () => {
  it("two aliased names both write to the same canonical circle", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await core.store("Fact in A.", { circle: "circle-a" });
    await core.store("Fact in B.", { circle: "circle-b" });

    // Rename both to the same canonical.
    core.renameCircle("circle-a", "canonical");
    core.renameCircle("circle-b", "canonical");

    // Both aliases resolve to "canonical".
    expect(core.resolveCircleName("circle-a")).toBe("canonical");
    expect(core.resolveCircleName("circle-b")).toBe("canonical");

    // Writing through either alias lands in "canonical".
    const rA = await core.store("Through A alias.", { circle: "circle-a", resolution: "forceNew" });
    const rB = await core.store("Through B alias.", { circle: "circle-b", resolution: "forceNew" });
    expect(core.circleOf(rA.conceptId)).toBe("canonical");
    expect(core.circleOf(rB.conceptId)).toBe("canonical");

    core.close();
  });
});
