/**
 * possible_duplicate_of pairs in overview() — surfaced when ambiguous-band evidence forks.
 * Covers: pair appears with ids + score; counts.possibleDuplicates; pair gone after consolidation.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

describe("overview possibleDuplicates", () => {
  it("surfaces a possible-duplicate pair with ids and score when an ambiguous fork occurs", async () => {
    // Force everything into the ambiguous band: tauAttach=0.9, tauAmbiguous=0.1
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    // Score ~0.75 → in [0.1, 0.9) → ambiguous fork
    const b = await c.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    const o = c.overview("default");
    expect(o.counts.possibleDuplicates).toBe(1);
    expect(o.possibleDuplicates).toHaveLength(1);

    const pd = o.possibleDuplicates[0]!;
    const ids = [pd.conceptAId, pd.conceptBId];
    expect(ids).toContain(a.conceptId);
    expect(ids).toContain(b.conceptId);
    expect(pd.score).toBeGreaterThan(0.1);
    expect(pd.score).toBeLessThan(0.9);
    c.close();
  });

  it("counts.possibleDuplicates increments correctly with multiple pairs", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    await c.store("Monet Local uses SQLite for its local storage backend.");
    // A different topic — won't match first two, creates its own concept.
    await c.store("The deployment pipeline runs on GitHub Actions with Docker.");
    // Slightly variant: in band with previous CI/CD concept.
    await c.store("GitHub Actions pipeline runs Docker containers for deployment.");

    const o = c.overview("default");
    expect(o.counts.possibleDuplicates).toBeGreaterThanOrEqual(1);
    c.close();
  });

  it("pair disappears from possibleDuplicates after consolidation via detach", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await c.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    // Confirm pair is present
    const before = c.overview("default");
    expect(before.possibleDuplicates.some((pd) =>
      [pd.conceptAId, pd.conceptBId].includes(a.conceptId) &&
      [pd.conceptAId, pd.conceptBId].includes(b.conceptId)
    )).toBe(true);

    // Add a second obs to b so detach isn't blocked.
    await c.store("More context for concept B.", { attachTo: b.conceptId });

    // Detach b's first obs into a — this triggers unwind+rederive on both, removing the
    // possible_duplicate_of edge.
    const fetchedB = (await c.getConcept(b.conceptId, { synthesize: false }))!;
    const bFirstObs = fetchedB.observations[0]!.id;
    await c.detach(b.conceptId, [bFirstObs], { destConceptId: a.conceptId });

    const after = c.overview("default");
    expect(after.possibleDuplicates.some((pd) =>
      [pd.conceptAId, pd.conceptBId].includes(a.conceptId) &&
      [pd.conceptAId, pd.conceptBId].includes(b.conceptId)
    )).toBe(false);
    c.close();
  });
});
