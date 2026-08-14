/**
 * F1 — memory_fetch observationsOffset pagination.
 *
 * Pagination is newest-first: offset 0 = the newest PAGE_SIZE observations,
 * offset PAGE_SIZE = the next-older PAGE_SIZE, etc. PAGE_SIZE == FETCH_MAX_OBS (20).
 *
 * Engine contract:
 *   getConcept(id, { observationsOffset: N, pageSize: P }) returns exactly the
 *   window [total-P-N, total-N) from the oldest-first observation list, clamped to
 *   valid bounds. totalObservations is the full count; observationsOffset echoes N.
 *
 *   getConcept(id, { pageSize: 0 }) (or omitting pageSize) returns all observations —
 *   used by internal callers that don't page.
 *
 * MCP contract:
 *   The MCP layer passes pageSize=FETCH_MAX_OBS so the engine returns exactly one
 *   page; no secondary slice is applied by the MCP layer. offset=0 and omitted offset
 *   are identical (offset 0 IS the first/newest page).
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

/** Force all stores into separate concepts (no dedup interference). */
function core(): MonetCore {
  return new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
}

// Matches FETCH_MAX_OBS in mcp-server.ts — replicated here so the test is self-documenting.
// If the constant changes, the test is still valid because we use TOTAL > 2*PAGE and check structure.
const PAGE = 20;

describe("getConcept — observationsOffset pagination (F1)", () => {
  it("offset=0 (explicit) and omitted offset produce byte-identical results", async () => {
    const c = core();
    const TOTAL = 5;
    const first = await c.store("Single observation concept.");
    const cid = first.conceptId;
    for (let i = 1; i < TOTAL; i++) await c.store(`Obs ${i}.`, { attachTo: cid });

    const withDefault = (await c.getConcept(cid, { synthesize: false }))!;
    const withZero = (await c.getConcept(cid, { synthesize: false, observationsOffset: 0 }))!;

    expect(withDefault.observations.map((o) => o.id)).toEqual(withZero.observations.map((o) => o.id));
    expect(withDefault.totalObservations).toBe(withZero.totalObservations);
    expect(withDefault.observationsOffset).toBe(0);
    expect(withZero.observationsOffset).toBe(0);
    c.close();
  });

  it("pageSize=0 returns all observations (internal caller, no paging)", async () => {
    const c = core();
    const TOTAL = PAGE + 5;
    const first = await c.store("Obs 0.");
    const cid = first.conceptId;
    for (let i = 1; i < TOTAL; i++) await c.store(`Obs ${i}.`, { attachTo: cid });

    const all = (await c.getConcept(cid, { synthesize: false, pageSize: 0 }))!;
    expect(all.observations).toHaveLength(TOTAL);
    expect(all.totalObservations).toBe(TOTAL);
    c.close();
  });

  it("totalObservations is always the full count regardless of offset", async () => {
    const c = core();
    const TOTAL = PAGE + 3;
    const first = await c.store("Obs 0.");
    const cid = first.conceptId;
    for (let i = 1; i < TOTAL; i++) await c.store(`Obs ${i}.`, { attachTo: cid });

    for (const offset of [0, PAGE, PAGE + 2, PAGE + 3, PAGE + 100]) {
      const page = (await c.getConcept(cid, { synthesize: false, observationsOffset: offset, pageSize: PAGE }))!;
      expect(page.totalObservations).toBe(TOTAL);
      expect(page.observationsOffset).toBe(offset);
    }
    c.close();
  });

  it("successive pages are disjoint and their union is exactly all observation ids", async () => {
    const c = core();
    const TOTAL = PAGE * 2 + 3; // 43 — requires 3 pages

    const first = await c.store("Paginated obs 0.");
    const cid = first.conceptId;
    for (let i = 1; i < TOTAL; i++) await c.store(`Paginated obs ${i}.`, { attachTo: cid });

    const allIds = new Set<string>();
    let offset = 0;
    let pageCount = 0;
    while (true) {
      const page = (await c.getConcept(cid, { synthesize: false, observationsOffset: offset, pageSize: PAGE }))!;
      expect(page.totalObservations).toBe(TOTAL);

      // Every id on this page must not already be in the union (disjoint).
      for (const o of page.observations) {
        expect(allIds.has(o.id)).toBe(false);
        allIds.add(o.id);
      }
      pageCount++;
      if (page.observations.length < PAGE) break; // last page (partial or exact boundary)
      offset += PAGE;
      if (offset >= TOTAL) break;
    }

    // Union must equal all observations.
    expect(allIds.size).toBe(TOTAL);
    // Should have taken ceil(43/20)=3 pages.
    expect(pageCount).toBe(3);
    c.close();
  });

  it("page 0 (newest) contains the same ids as the pre-pagination legacy default window", async () => {
    // Legacy behaviour: getConcept returned all obs; the MCP applied slice(-FETCH_MAX_OBS) to
    // get the newest 20. The new page 0 must contain exactly those same 20 ids.
    const c = core();
    const TOTAL = PAGE + 5; // 25; last 20 = obs[5..24] (0-indexed)

    const first = await c.store("Legacy obs 0.");
    const cid = first.conceptId;
    for (let i = 1; i < TOTAL; i++) await c.store(`Legacy obs ${i}.`, { attachTo: cid });

    // Legacy: get all obs, then take the newest PAGE.
    const allObs = (await c.getConcept(cid, { synthesize: false, pageSize: 0 }))!.observations;
    const legacyWindow = allObs.slice(allObs.length - PAGE).map((o) => o.id);

    // New page 0 with pageSize=PAGE.
    const page0 = (await c.getConcept(cid, { synthesize: false, observationsOffset: 0, pageSize: PAGE }))!;
    const page0Ids = page0.observations.map((o) => o.id);

    expect(page0Ids).toEqual(legacyWindow);
    c.close();
  });

  it("out-of-range offset returns an empty observations array, totalObservations still correct", async () => {
    const c = core();
    const TOTAL = 5;
    const first = await c.store("Out-of-range test.");
    const cid = first.conceptId;
    for (let i = 1; i < TOTAL; i++) await c.store(`Obs ${i}.`, { attachTo: cid });

    const page = (await c.getConcept(cid, { synthesize: false, observationsOffset: TOTAL + 10, pageSize: PAGE }))!;
    expect(page.observations).toHaveLength(0);
    expect(page.totalObservations).toBe(TOTAL);
    c.close();
  });
});
