/**
 * renderOverview() — the pure terminal renderer: deterministic, color-toggleable (no escape
 * bytes when color:false), width-bounded, and section-omitting (empty sections vanish, never
 * stub). The honesty story depends on the render being faithful and stable.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";
import { renderOverview } from "../render-overview";

const ESC = String.fromCharCode(27);
const stripAnsi = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");

function populated(): MonetCore {
  let seq = 0;
  const c = new MonetCore(":memory:", { idGen: () => `c${seq++}`, tauAttach: 1.1, tauAmbiguous: 1.1 });
  return c;
}

describe("renderOverview", () => {
  it("is pure + deterministic for the same snapshot", async () => {
    const c = populated();
    await c.store("Auth tokens signed with jose in the AuthService.", { kind: "decision" });
    await c.store("The AuthService lives in src/auth/service.ts.", { kind: "fact" });
    const o = c.overview("default");
    expect(renderOverview(o)).toBe(renderOverview(o));
    c.close();
  });

  it("color:false has zero escape bytes; color:true strips to the same text", async () => {
    const c = populated();
    await c.store("Auth tokens signed with jose in the AuthService.", { kind: "decision" });
    await c.store("The AuthService lives in src/auth/service.ts.", { kind: "fact" });
    const o = c.overview("default");
    const plain = renderOverview(o, { color: false });
    const colored = renderOverview(o, { color: true });
    expect(plain).not.toContain(ESC);
    expect(colored).toContain(ESC);
    expect(stripAnsi(colored)).toBe(plain);
    c.close();
  });

  it("never exceeds the requested width (visible characters)", async () => {
    const c = populated();
    for (let i = 0; i < 8; i++) await c.store(`A reasonably long memory number ${i} about the AuthService and src/auth/service.ts.`, { kind: "fact" });
    const width = 84;
    const lines = renderOverview(c.overview("default"), { color: true, width }).split("\n");
    for (const l of lines) expect(stripAnsi(l).length).toBeLessThanOrEqual(width);
    c.close();
  });

  it("renders the knowledge-graph box + worked-together footer when the graph has substance", async () => {
    const c = populated();
    await c.store("AuthService validates requests in src/auth/service.ts.", { kind: "fact" });
    await c.store("AuthService rotates jose keys in src/auth/service.ts.", { kind: "decision" });
    const out = renderOverview(c.overview("default"));
    expect(out).toContain("LIVING MODEL");
    expect(out).toContain("KNOWLEDGE GRAPH");
    expect(out).toContain("worked together");
    c.close();
  });

  it("omits empty sections and renders an empty store without throwing or leaking a body", async () => {
    const c = populated();
    const out = renderOverview(c.overview("default"));
    expect(out).toContain("what your agent knows");
    expect(out).not.toContain("LIVING MODEL"); // nothing stored ⇒ section omitted
    expect(out).not.toContain("KNOWLEDGE GRAPH");
    expect(out).not.toContain("NEEDS ATTENTION");
    expect(out).not.toContain("RESOLUTION"); // no decided writes ⇒ a row of zeros, omitted
    c.close();
  });

  it("RESOLUTION section reports the decided modes and the duplicate-emission rate", async () => {
    // The design's empirical check is "visible in curation", and THIS is the human curation
    // surface — a field on the MCP JSON response does not discharge it.
    const c = populated();
    await c.store("AuthService validates requests in src/auth/service.ts.", { kind: "fact" });
    await c.store("Deploys are gated on a green canary.", { kind: "decision" });
    const out = renderOverview(c.overview("default"));
    expect(out).toContain("RESOLUTION");
    expect(out).toContain("how new evidence landed, last 30d");
    expect(out).toContain("new 2");
    expect(out).toContain("2 decided · 0% surfaced a possible duplicate");
    c.close();
  });

  it("POSSIBLE DUPLICATES section shows 8-char short ids for both concepts in each row", async () => {
    // tauAttach=0.9, tauAmbiguous=0.1 forces the two similar stores into the ambiguous band.
    let seq = 0;
    const c = new MonetCore(":memory:", { idGen: () => `dup${String(seq++).padStart(5, "0")}`, tauAttach: 0.9, tauAmbiguous: 0.1 });
    await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    const r2 = await c.store("Monet Local uses SQLite for its local storage backend.");
    expect(r2.action).toBe("ambiguous");

    const o = c.overview("default");
    expect(o.possibleDuplicates).toHaveLength(1);
    const pd = o.possibleDuplicates[0]!;

    // Render at a generous width so neither id is truncated away from the row.
    const out = stripAnsi(renderOverview(o, { color: false, width: 200 }));
    expect(out).toContain("POSSIBLE DUPLICATES");

    // Both 8-char id prefixes must appear in the output.
    const shortA = pd.conceptAId.slice(0, 8);
    const shortB = pd.conceptBId.slice(0, 8);
    expect(out).toContain(`[${shortA}]`);
    expect(out).toContain(`[${shortB}]`);

    // The row must also still contain the score.
    expect(out).toContain("score:");
    c.close();
  });

  it("GATES section surfaces recognized-lookup activity even with zero mechanical fires IN THE WINDOW (review fix, item 4)", async () => {
    const c = populated();
    const longAgo = Date.now() - 40 * 24 * 60 * 60 * 1000; // outside the default 30-day stats window
    await c.store("Never force-push to a shared branch.", {
      kind: "rule", rule: { stage: "git force push", instance: "Bash:git push --force", scope: "domain" },
    });
    // A mechanical fire OUTSIDE the stats window: verifies the pattern PERMANENTLY (verified is not
    // time-windowed) without contributing to windowTotal (which is), isolating "recognized activity
    // in the window" as the only thing this store has to report — proving the suppression condition
    // needed widening, not just that the new line can render alongside other reasons to show GATES.
    c.gate({ actionContext: "Bash:git push --force", now: longAgo });
    c.stageLookup({ stage: "git force push" });
    c.stageLookup({ stage: "git force push" });
    c.stageLookup({ stage: "no such stage" });

    const gs = c.gateStats();
    expect(gs.windowTotal).toBe(0); // the old mechanical fire falls outside the window
    expect(gs.unverifiedPatterns).toEqual([]); // ...but it verified the pattern permanently
    expect(gs.byMatcher.find((m) => m.matcher === "recognized")?.count).toBe(3);

    const out = renderOverview(c.overview("default"), { color: false });
    expect(out).toContain("GATES");
    expect(out).toContain("3 asked by recognition (stage_lookup)");
    c.close();
  });

  it("GATES section stays suppressed when there is truly nothing to report", async () => {
    const c = populated();
    const out = renderOverview(c.overview("default"), { color: false });
    expect(out).not.toContain("GATES");
    c.close();
  });
});
