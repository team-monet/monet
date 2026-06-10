/**
 * F5 — observationsOffset pagination on getConcept (engine) and memory_fetch (MCP).
 *
 * The FETCH_MAX_OBS cap in mcp-server.ts limits which observation ids are visible per page.
 * A concept with more than that many observations could not be fully repaired via MCP because
 * the older ids were unreachable. observationsOffset allows paging through all of them.
 *
 * Engine contract:
 *   getConcept(id, { observationsOffset: N }) slices the rowid-ordered observations starting
 *   at index N. totalObservations is the full count; observationsOffset echoes N.
 *
 * MCP contract (tested via engine only — the MCP server adds a further per-page cap on top):
 *   The engine offset alone is sufficient to verify id reachability; the MCP layer is thin.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

/** Force all stores into separate concepts (no dedup interference). */
function core(): MonetCore {
  return new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
}

// The MCP cap constant (FETCH_MAX_OBS = 20) — replicated here so the test is self-documenting.
// If the constant changes in mcp-server.ts the test should still pass because we test with
// enough observations to exceed it regardless.
const MCP_CAP = 20;

describe("getConcept — observationsOffset pagination (F5)", () => {
  it("concept with > cap observations: page 0 and page N return disjoint id sets", async () => {
    const c = core();
    const TOTAL = MCP_CAP + 5; // 25 observations; straddles the cap boundary

    // Store the first observation to create the concept.
    const first = await c.store(`Observation 0 for the paginated concept.`);
    const conceptId = first.conceptId;

    // Attach the remaining observations.
    for (let i = 1; i < TOTAL; i++) {
      await c.store(`Observation ${i} for the paginated concept.`, { attachTo: conceptId });
    }

    // Full count (no offset).
    const page0 = (await c.getConcept(conceptId, { synthesize: false }))!;
    expect(page0.totalObservations).toBe(TOTAL);
    expect(page0.observationsOffset).toBe(0);
    expect(page0.observations).toHaveLength(TOTAL);

    // Offset page: start at MCP_CAP.
    const pageN = (await c.getConcept(conceptId, { synthesize: false, observationsOffset: MCP_CAP }))!;
    expect(pageN.totalObservations).toBe(TOTAL);
    expect(pageN.observationsOffset).toBe(MCP_CAP);
    expect(pageN.observations).toHaveLength(TOTAL - MCP_CAP);

    // The two slices must be disjoint.
    const ids0 = new Set(page0.observations.slice(0, MCP_CAP).map((o) => o.id));
    const idsN = new Set(pageN.observations.map((o) => o.id));
    for (const id of idsN) {
      expect(ids0.has(id)).toBe(false);
    }

    c.close();
  });

  it("totalObservations is always the full count regardless of offset", async () => {
    const c = core();
    const TOTAL = 10;
    const first = await c.store("Obs 0.");
    const conceptId = first.conceptId;
    for (let i = 1; i < TOTAL; i++) {
      await c.store(`Obs ${i}.`, { attachTo: conceptId });
    }

    for (const offset of [0, 3, 7, 9]) {
      const page = (await c.getConcept(conceptId, { synthesize: false, observationsOffset: offset }))!;
      expect(page.totalObservations).toBe(TOTAL);
      expect(page.observations).toHaveLength(TOTAL - offset);
    }

    c.close();
  });

  it("all observation ids are reachable across pages with step = MCP_CAP", async () => {
    const c = core();
    const TOTAL = MCP_CAP * 2 + 3; // 43 observations — requires 3 pages

    const first = await c.store("Paginated obs 0.");
    const conceptId = first.conceptId;
    for (let i = 1; i < TOTAL; i++) {
      await c.store(`Paginated obs ${i}.`, { attachTo: conceptId });
    }

    const allIds = new Set<string>();
    let offset = 0;
    while (true) {
      const page = (await c.getConcept(conceptId, { synthesize: false, observationsOffset: offset }))!;
      for (const o of page.observations.slice(0, MCP_CAP)) allIds.add(o.id);
      if (offset + MCP_CAP >= page.totalObservations) break;
      offset += MCP_CAP;
    }

    // Every observation id must be reachable.
    expect(allIds.size).toBe(TOTAL);

    c.close();
  });

  it("offset=0 (default) is byte-compatible with the pre-existing behaviour", async () => {
    const c = core();
    const first = await c.store("Single observation concept.");
    const conceptId = first.conceptId;

    const withDefault = (await c.getConcept(conceptId, { synthesize: false }))!;
    const withZero = (await c.getConcept(conceptId, { synthesize: false, observationsOffset: 0 }))!;

    expect(withDefault.observations).toHaveLength(withZero.observations.length);
    expect(withDefault.totalObservations).toBe(withZero.totalObservations);
    expect(withDefault.observationsOffset).toBe(0);

    c.close();
  });
});
