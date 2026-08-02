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

  it("omits empty sections and renders an empty store without throwing or leaking a body", async () => {
    const c = populated();
    const out = renderOverview(c.overview("default"));
    expect(out).toContain("curation workbench");
    expect(out).not.toContain("LIVING MODEL");
    expect(out).not.toContain("OPEN CONTRADICTIONS");
    expect(out).toContain("no curation work queued");
    c.close();
  });

  it("renders legacy-star migration debt instead of claiming the workbench is empty", async () => {
    const c = populated();
    await c.store("Migrated memory awaiting filing.", { circle: "legacy-star", resolution: "forceNew" });
    const out = renderOverview(c.overview("ordinary"), { color: false });
    expect(out).toContain("LEGACY-STAR FILING");
    expect(out).toContain("1 migrated memories still need a human filing decision");
    expect(out).not.toContain("no curation work queued");
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

    expect(out).toContain(pd.score.toFixed(3));
    c.close();
  });

  it("GATES section stays suppressed when there is truly nothing to report", async () => {
    const c = populated();
    const out = renderOverview(c.overview("default"), { color: false });
    expect(out).not.toContain("GATES");
    c.close();
  });
});
