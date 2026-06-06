import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine.js";

describe("resolve-or-create ingest (#239 keystone)", () => {
  it("merges similar evidence into ONE concept, keeping every observation", async () => {
    const core = new MonetCore(":memory:");

    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    expect(a.action).toBe("created");

    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(["attached", "ambiguous"]).toContain(b.action);
    expect(b.conceptId).toBe(a.conceptId);

    const c = await core.store("For Monet Local persistence we went with a SQLite database file.");
    expect(c.conceptId).toBe(a.conceptId);

    expect(core.conceptCount()).toBe(1); // one deduplicated concept...
    expect(core.observationCount()).toBe(3); // ...all evidence preserved (append-only ledger)

    const merged = (await core.getConcept(a.conceptId))!;
    expect(merged.supportCount).toBe(3);
    expect(merged.version).toBe(2); // bumped on each of the 2 merges
    expect(merged.observations).toHaveLength(3);

    core.close();
  });

  it("creates a SEPARATE concept for unrelated content", async () => {
    const core = new MonetCore(":memory:");
    await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    const d = await core.store("The team prefers pytest with httpx for Python testing.");
    expect(d.action).toBe("created");
    expect(core.conceptCount()).toBe(2);
    core.close();
  });

  it("keeps circles isolated", async () => {
    const core = new MonetCore(":memory:");
    await core.store("I prefer 2-space indentation.", { circle: "coding" });
    await core.store("Dentist appointment is on Fridays.", { circle: "personal" });
    expect(core.conceptCount("coding")).toBe(1);
    expect(core.conceptCount("personal")).toBe(1);
    expect((await core.search("indentation", { circle: "coding" }))[0]?.slug).toContain("indentation");
    core.close();
  });
});

describe("search returns a card, never the answer (#232 — no answer-leak)", () => {
  it("ranks the right concept first but carries NO content", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.", {
      kind: "decision",
    });
    await core.store("The team prefers pytest with httpx for Python testing.");

    const hits = await core.search("what does monet local use for storage");
    expect(hits[0]?.id).toBe(a.conceptId); // relevance: right concept on top

    const card = hits[0] as unknown as Record<string, unknown>;
    expect(card.body).toBeUndefined(); // ...but the card cannot leak the answer
    expect(card.summary).toBeUndefined(); // (there is no summary field at all)
    expect(hits[0]?.fetchHint).toMatch(/fetch/); // it nudges toward a fetch
    expect(hits[0]?.kind).toBe("decision");
    expect(hits[0]?.supportCount).toBe(1);

    // the content is reachable only by fetching
    const full = (await core.getConcept(hits[0].id))!;
    expect(full.body.toLowerCase()).toContain("sqlite");
    core.close();
  });
});

describe("lazy enrichment (Sift inline, Sieve deferred — §4.6)", () => {
  it("store is cheap: leaves the concept dirty with NO synthesis", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(core.isDirty(a.conceptId)).toBe(true);
    core.close();
  });

  it("a TOUCH (fetch) synthesizes on demand and clears dirty", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    await core.store("Monet Local uses SQLite for its local storage backend.");

    const first = (await core.getConcept(a.conceptId))!;
    expect(first.synthesizedNow).toBe(true);
    expect(first.dirty).toBe(false);
    expect(first.revisions).toBe(1);

    const second = (await core.getConcept(a.conceptId))!;
    expect(second.synthesizedNow).toBe(false); // already clean → no re-synthesis
    expect(second.revisions).toBe(1);

    core.close();
  });

  it("a new observation re-dirties the concept; next touch re-synthesizes", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    await core.getConcept(a.conceptId); // synthesize → clean
    expect(core.isDirty(a.conceptId)).toBe(false);

    await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(core.isDirty(a.conceptId)).toBe(true);

    const re = (await core.getConcept(a.conceptId))!;
    expect(re.synthesizedNow).toBe(true);
    expect(re.revisions).toBe(2);
    core.close();
  });

  it("checkpoint synthesizes all dirty concepts in one batch", async () => {
    const core = new MonetCore(":memory:");
    await core.store("We use SQLite for Monet Local storage.");
    await core.store("The team prefers pytest with httpx for testing.");
    expect(await core.checkpoint()).toBe(2);
    expect(await core.checkpoint()).toBe(0);
    core.close();
  });
});
