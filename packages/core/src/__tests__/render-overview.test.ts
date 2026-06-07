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
    c.close();
  });
});
