import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";
import { HashingEmbeddingProvider } from "../embedding";
import { OnnxEmbeddingProvider } from "../embedding-onnx";

describe("resolve-or-create ingest (#239 keystone)", () => {
  // Test A: phrases that score ≥ tauAttach (0.72) → must attach to the same concept.
  it("attaches evidence that scores above tauAttach into ONE concept", async () => {
    const core = new MonetCore(":memory:");

    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    expect(a.action).toBe("created");

    // Score ~0.75 with base — robustly above tauAttach (0.55).
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("attached");
    expect(b.conceptId).toBe(a.conceptId);

    expect(core.conceptCount()).toBe(1); // one deduplicated concept...
    expect(core.observationCount()).toBe(2); // ...all evidence preserved (append-only ledger)

    const merged = (await core.getConcept(a.conceptId))!;
    expect(merged.supportCount).toBe(2);
    expect(merged.version).toBe(1); // bumped on the merge
    expect(merged.observations).toHaveLength(2);

    core.close();
  });

  // Test B: phrases that score in [tauAmbiguous, tauAttach) → ambiguous fork with possible_duplicate_of edge.
  it("forks evidence in the ambiguous band and records a possible_duplicate_of edge", async () => {
    const core = new MonetCore(":memory:");

    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    expect(a.action).toBe("created");

    // Score ~0.46 with base — robustly in ambiguous band [0.4, 0.55).
    const b = await core.store("The app uses SQLite for persistence.");
    expect(b.action).toBe("ambiguous");
    expect(b.conceptId).not.toBe(a.conceptId); // forked: distinct concept
    expect(b.nearMatchId).toBe(a.conceptId);
    expect(b.nearMatchScore).toBeGreaterThanOrEqual(0.4);
    expect(b.nearMatchScore).toBeLessThan(0.55);

    expect(core.conceptCount()).toBe(2); // two concepts (forked)
    // possible_duplicate_of edge between them
    const dupEdges = core.edges({ circle: "default", type: "possible_duplicate_of" });
    expect(dupEdges.length).toBeGreaterThan(0);
    expect(dupEdges.some((e) =>
      (e.srcId === a.conceptId && e.dstId === b.conceptId) ||
      (e.srcId === b.conceptId && e.dstId === a.conceptId)
    )).toBe(true);

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

describe("per-call resolution control (Change 1)", () => {
  it("forceNew always creates a new concept even for similar content", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("We use SQLite for Monet Local storage.");
    // Score ~0.87 — robustly above tauAttach (0.55); would attach, but forceNew bypasses dedup.
    const b = await core.store("Monet Local uses SQLite for storage.", { resolution: "forceNew" });
    expect(b.action).toBe("created");
    expect(b.conceptId).not.toBe(a.conceptId);
    expect(core.conceptCount()).toBe(2); // distinct concepts
    // Score reflects nearest neighbor (informational)
    expect(b.score).toBeGreaterThan(0);
    core.close();
  });

  it("attachTo directs attach onto the named concept, ignoring similarity", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const a = await core.store("PostgreSQL is used for the reporting database.");
    // Completely unrelated content, but directed to attach onto a.
    const b = await core.store("Deployment uses Kubernetes on AWS.", { attachTo: a.conceptId });
    expect(b.action).toBe("attached");
    expect(b.conceptId).toBe(a.conceptId);
    expect(core.conceptCount()).toBe(1); // still one concept
    const fetched = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    expect(fetched.supportCount).toBe(2);
    core.close();
  });

  it("attachTo with kind=correction opens a contradiction", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const a = await core.store("The timeout is 30 seconds.");
    const b = await core.store("The timeout was changed to 60 seconds.", { attachTo: a.conceptId, kind: "correction" });
    expect(b.contradiction).toBeDefined();
    expect(b.contradiction!.status).toBe("open");
    const fetched = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    expect(fetched.status).toBe("disputed");
    core.close();
  });

  it("forceNew + attachTo throws a validation error", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("Some concept.");
    await expect(
      core.store("Something.", { resolution: "forceNew", attachTo: a.conceptId })
    ).rejects.toThrow("resolution 'forceNew' and attachTo are mutually exclusive");
    core.close();
  });

  it("attachTo with unknown id throws", async () => {
    const core = new MonetCore(":memory:");
    await expect(
      core.store("Something.", { attachTo: "nonexistent-id-xyz" })
    ).rejects.toThrow("attachTo concept not found");
    core.close();
  });

  it("threshold pinning: hashing is 0.55 / 0.4, and the ONNX bands come from the MODEL, not the class", () => {
    // Lexical (hashing) provider — looser thresholds, lexical overlap saturates lower.
    const hashing = new HashingEmbeddingProvider();
    expect(hashing.recommendedThresholds.tauAttach).toBe(0.55);
    expect(hashing.recommendedThresholds.tauAmbiguous).toBe(0.4);

    // Semantic (ONNX) provider — recommendedThresholds is a plain readonly property; reading it does
    // NOT trigger a model load (load() is only called from embed()).
    //
    // PER MODEL (#155). Each band below was derived by replaying the live corpus through the real
    // nomination decision in that model's own space. The default is 0.70, not the 0.72 this test
    // used to pin: 0.72 was never measured on this checkpoint at all — it was inherited from
    // all-MiniLM-L6-v2 and left in place across the multilingual swap.
    // The DEFAULT space carries its own measured band. It is MULTILINGUAL and therefore declares no
    // script restriction — pinned here as an assertion about the default, since a store that adopts
    // it accepts non-Latin content permanently and that is the property most worth catching a silent
    // change to. The English-only checkpoint it replaced is asserted below, band and restriction
    // together, so both directions stay covered.
    const onnx = new OnnxEmbeddingProvider();
    expect(onnx.recommendedThresholds.tauAttach).toBe(0.70);
    expect(onnx.recommendedThresholds.tauAmbiguous).toBe(0.5);
    expect(onnx.readsOnlyLatinScript).toBeUndefined();

    const english = new OnnxEmbeddingProvider({ model: "Xenova/bge-small-en-v1.5" });
    expect(english.recommendedThresholds.tauAttach).toBe(0.78);
    expect(english.readsOnlyLatinScript).toBe(true);

    // The multilingual checkpoint it replaced has a DIFFERENT measured band (its space runs lower)
    // and no script restriction. Carrying either model's number to the other is the mistake #155
    // documents; the 0.72 that used to sit here was never derived on either of them.
    const multilingual = new OnnxEmbeddingProvider({ model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2" });
    expect(multilingual.recommendedThresholds.tauAttach).toBe(0.70);
    expect(multilingual.readsOnlyLatinScript).toBeUndefined();

    // An unmeasured checkpoint falls back to the labelled legacy guess rather than to another
    // model's measured band, and is not script-gated on an assumption.
    const unknown = new OnnxEmbeddingProvider({ model: "Xenova/some-unmeasured-model" });
    expect(unknown.recommendedThresholds.tauAttach).toBe(0.72);
    expect(unknown.readsOnlyLatinScript).toBeUndefined();
  });
});

describe("ambiguous band fork (Change 2)", () => {
  it("ambiguous fork: controlled thresholds produce action=ambiguous, distinct ids, edge, nearMatchId/Score", async () => {
    // tauAttach 0.9 (nothing attaches), tauAmbiguous 0.1 (everything in band) to force ambiguous.
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    // Score ~0.75 — in [0.1, 0.9) with these overridden thresholds, so ambiguous.
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");
    expect(b.conceptId).not.toBe(a.conceptId);
    expect(b.nearMatchId).toBe(a.conceptId);
    expect(b.nearMatchScore).toBeDefined();
    expect(b.nearMatchScore!).toBeGreaterThan(0.1);
    expect(b.nearMatchScore!).toBeLessThan(0.9);
    expect(core.conceptCount()).toBe(2);
    const dupEdges = core.edges({ circle: "default", type: "possible_duplicate_of" });
    expect(dupEdges.some((e) =>
      (e.srcId === a.conceptId && e.dstId === b.conceptId) ||
      (e.srcId === b.conceptId && e.dstId === a.conceptId)
    )).toBe(true);
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

// ---------------------------------------------------------------------------
// F6 — ambiguous-band corrections fork like everything else (#52)
//
// This block used to pin the OPPOSITE: an ambiguous-band correction attached to its near match on
// the premise that "this overrides existing memory" disambiguated the write. It does not — intent
// disambiguates what a correction asserts, not which concept a weak evidence cosine points at — and
// in the field that exemption absorbed a correction into an unrelated concept at 0.556 and flipped
// that innocent concept to `disputed`. The exemption is retired; the two tests below are now the
// same assertion twice, which is the point.
// ---------------------------------------------------------------------------
describe("F6 — ambiguous-band corrections fork like everything else (#52)", () => {
  it("ambiguous-band correction forks, opens NO contradiction, and records possible_duplicate_of", async () => {
    // tauAttach=0.9 (nothing attaches on score), tauAmbiguous=0.1 (everything in band) —
    // same setup as the existing ambiguous-fork test so scores are in the ambiguous band.
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await c.store("We decided to use SQLite as the storage backend for Monet Local.");

    // Ambiguous-band score with kind=correction → forks, exactly as a non-correction would.
    const b = await c.store("Monet Local uses SQLite for its local storage backend.", { kind: "correction" });

    expect(b.action).toBe("ambiguous");
    expect(b.conceptId).not.toBe(a.conceptId);
    expect(c.conceptCount()).toBe(2);

    // Nothing landed on the existing concept, so nothing may dispute it.
    expect(b.contradiction).toBeUndefined();
    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    expect(fetched.status).toBe("active");

    // The pair is surfaced instead — recoverable by merge, which a wrong attach never was.
    const dupEdges = c.edges({ circle: "default", type: "possible_duplicate_of" });
    expect(dupEdges.some((e) =>
      (e.srcId === a.conceptId && e.dstId === b.conceptId) ||
      (e.srcId === b.conceptId && e.dstId === a.conceptId),
    )).toBe(true);

    c.close();
  });

  it("ambiguous-band NON-correction still forks and records possible_duplicate_of (existing behaviour)", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await c.store("Monet Local uses SQLite for its local storage backend."); // no kind=correction

    expect(b.action).toBe("ambiguous");
    expect(b.conceptId).not.toBe(a.conceptId); // forked
    expect(c.conceptCount()).toBe(2);

    const dupEdges = c.edges({ circle: "default", type: "possible_duplicate_of" });
    expect(dupEdges.some((e) =>
      (e.srcId === a.conceptId && e.dstId === b.conceptId) ||
      (e.srcId === b.conceptId && e.dstId === a.conceptId),
    )).toBe(true);

    c.close();
  });
});
