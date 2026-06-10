/**
 * detach() — split observations out of a concept, either into a new concept or an existing one.
 * Covers: basic detach→new concept; detach→destConceptId; source embedding recompute; last-obs
 * guard; possible_duplicate_of edge removal on consolidation; superseded_by hygiene; dirty mark.
 * Also covers: kind propagation on create (Finding 1); source_refs recompute (Finding 2);
 * contradiction row hygiene (Finding 3).
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";
import { BetterSqlitePort } from "../storage";
import { cosine } from "../embedding";

/** Force all stores into separate concepts (no dedup interference). */
function core(): MonetCore {
  return new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
}

describe("detach — basic split into a new concept", () => {
  it("moves named observations to a new concept; counts and placement are correct", async () => {
    const c = core();
    const a = await c.store("First observation for concept A.");
    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    const obs1Id = fetched.observations[0]!.id;

    // Add a second observation
    const a2 = await c.store("Second observation for concept A.", { attachTo: a.conceptId });
    const fetched2 = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    const obs2Id = fetched2.observations[1]!.id;

    expect(fetched2.supportCount).toBe(2);

    // Detach second observation into a new concept.
    const r = await c.detach(a.conceptId, [obs2Id]);
    expect(r.destAction).toBe("created");
    expect(r.observationsMoved).toBe(1);
    expect(r.sourceConceptId).toBe(a.conceptId);
    expect(r.destConceptId).not.toBe(a.conceptId);

    // Source has 1 obs left
    const srcFetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    expect(srcFetched.supportCount).toBe(1);
    expect(srcFetched.observations).toHaveLength(1);
    expect(srcFetched.observations[0]!.id).toBe(obs1Id);

    // Dest has the detached obs
    const dstFetched = (await c.getConcept(r.destConceptId, { synthesize: false }))!;
    expect(dstFetched.supportCount).toBe(1);
    expect(dstFetched.observations).toHaveLength(1);
    expect(dstFetched.observations[0]!.id).toBe(obs2Id);

    expect(c.conceptCount()).toBe(2);
    c.close();
  });

  it("source is marked dirty after detach", async () => {
    const c = core();
    const a = await c.store("Observation one.");
    const b = await c.store("Observation two.", { attachTo: a.conceptId });
    // Clear dirty first
    await c.getConcept(a.conceptId);
    expect(c.isDirty(a.conceptId)).toBe(false);

    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    const obs2Id = fetched.observations[1]!.id;
    await c.detach(a.conceptId, [obs2Id]);
    expect(c.isDirty(a.conceptId)).toBe(true);
    c.close();
  });
});

describe("detach — to an existing destination concept", () => {
  it("detach→destConceptId folds observation into existing concept without creating a new one", async () => {
    const c = core();
    const conceptB = await c.store("The destination concept.");
    const conceptA = await c.store("Observation for concept A.");
    const a2 = await c.store("Second obs for concept A.", { attachTo: conceptA.conceptId });

    const fetched = (await c.getConcept(conceptA.conceptId, { synthesize: false }))!;
    const obs2Id = fetched.observations[1]!.id;

    const countBefore = c.conceptCount();
    const r = await c.detach(conceptA.conceptId, [obs2Id], { destConceptId: conceptB.conceptId });
    expect(r.destAction).toBe("attached");
    expect(r.destConceptId).toBe(conceptB.conceptId);
    expect(c.conceptCount()).toBe(countBefore); // no new concept

    const dstFetched = (await c.getConcept(conceptB.conceptId, { synthesize: false }))!;
    expect(dstFetched.supportCount).toBe(2);
    expect(dstFetched.observations).toHaveLength(2);
    c.close();
  });
});

describe("detach — source embedding recompute", () => {
  it("single remaining observation: source embedding equals that observation's stored embedding", async () => {
    const c = core();
    const a = await c.store("First observation alpha.");
    const fetched1 = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    const obs1Id = fetched1.observations[0]!.id;

    // Add a second obs
    await c.store("Second observation beta.", { attachTo: a.conceptId });

    const fetched2 = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    const obs2Id = fetched2.observations[1]!.id;

    // Detach obs2, leaving obs1 as the only remaining observation.
    await c.detach(a.conceptId, [obs2Id]);

    // The source concept's embedding should match obs1's stored embedding.
    // We verify by checking cosine similarity == 1 between source concept and itself (the
    // only practical check without direct embedding-column access).
    const srcRow = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    expect(srcRow.observations[0]!.id).toBe(obs1Id);
    // The source concept body should now be just the first observation's content.
    expect(srcRow.body).toContain("First observation alpha");
    c.close();
  });
});

describe("detach — guard rails", () => {
  it("cannot detach the last observation — suggests memory_reassign_circle", async () => {
    const c = core();
    const a = await c.store("Only observation.");
    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    const obsId = fetched.observations[0]!.id;
    await expect(c.detach(a.conceptId, [obsId])).rejects.toThrow(/last observation/);
    c.close();
  });

  it("throws when an observation id does not belong to the source concept", async () => {
    const c = core();
    const a = await c.store("Concept A obs.");
    const b = await c.store("Concept B obs.");
    // Add second obs so detach wouldn't be blocked by last-obs guard
    await c.store("Concept A obs 2.", { attachTo: a.conceptId });

    const fetchedB = (await c.getConcept(b.conceptId, { synthesize: false }))!;
    const obsFromB = fetchedB.observations[0]!.id;
    await expect(c.detach(a.conceptId, [obsFromB])).rejects.toThrow(/does not belong/);
    c.close();
  });

  it("throws when source concept does not exist", async () => {
    const c = core();
    await expect(c.detach("nonexistent-id", ["obs-id"])).rejects.toThrow("concept not found");
    c.close();
  });
});

describe("detach — possible_duplicate_of edge removal on consolidation", () => {
  it("removes the possible_duplicate_of edge between source and dest after detach", async () => {
    // Force ambiguous band: tauAttach=0.9, tauAmbiguous=0.1 so everything in band.
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    // Score ~0.75 — in [0.1, 0.9) → ambiguous fork
    const b = await c.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    // A possible_duplicate_of edge exists
    const before = c.edges({ circle: "default", type: "possible_duplicate_of" });
    expect(before.length).toBeGreaterThan(0);

    // Detach b's observation into a (consolidate by moving b's obs onto a)
    const fetchedB = (await c.getConcept(b.conceptId, { synthesize: false }))!;
    const obsOfB = fetchedB.observations[0]!.id;
    // Add a second obs to b so we can detach one (can't detach the last)
    await c.store("Additional context for concept B.", { attachTo: b.conceptId });
    await c.detach(b.conceptId, [obsOfB], { destConceptId: a.conceptId });

    // The possible_duplicate_of edge between a and b should be gone (unwind+rederive on both)
    const after = c.edges({ circle: "default", type: "possible_duplicate_of" });
    expect(after.some((e) =>
      (e.srcId === a.conceptId && e.dstId === b.conceptId) ||
      (e.srcId === b.conceptId && e.dstId === a.conceptId)
    )).toBe(false);
    c.close();
  });
});

describe("detach — superseded_by hygiene", () => {
  it("clears superseded_by on a detached observation when its superseder stays behind", async () => {
    // Resolve a contradiction so one obs supersedes another, then detach the superseded one.
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await c.store("Old value: timeout 30s.");
    // Attach a correction — this makes both obs live on the same concept
    const b = await c.store("New value: timeout 60s.", { attachTo: a.conceptId, kind: "correction" });
    expect(b.contradiction).toBeDefined();

    // Resolve by accepting new — now the old obs has superseded_by set.
    c.resolveContradiction(b.contradiction!.id, { decision: "accept-new" });
    expect(c.supersededObservationCount()).toBe(1);

    // Now the old obs is superseded by the new obs.
    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    // Add a third obs so we can detach (need at least 2 remaining after detach)
    await c.store("Third obs.", { attachTo: a.conceptId });

    // Detach the superseded (first) obs — its superseder (second) stays in source.
    const supersededObsId = fetched.observations[0]!.id;
    await c.detach(a.conceptId, [supersededObsId]);

    // The superseded_by pointer must be cleared: no cross-concept supersession may exist.
    expect(c.supersededObservationCount()).toBe(0);
    c.close();
  });

  it("preserves superseded_by when both superseded and superseder are detached together (pair moves as a unit)", async () => {
    // Set up: obs A (old) superseded by obs B (new), both on the same concept.
    // Detach BOTH A and B together — the pointer is intra-concept at the destination and must survive.
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await c.store("Old value: cache size 100.");
    const b = await c.store("New value: cache size 200.", { attachTo: a.conceptId, kind: "correction" });
    expect(b.contradiction).toBeDefined();

    // Resolve — obs A.superseded_by = obs B's id.
    c.resolveContradiction(b.contradiction!.id, { decision: "accept-new" });
    expect(c.supersededObservationCount()).toBe(1);

    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    // Add a third obs so source concept keeps at least one observation after detaching A+B.
    await c.store("Third obs stays behind.", { attachTo: a.conceptId });

    // Detach both the superseded obs (A, index 0) and the superseder (B, index 1) together.
    const supersededObsId = fetched.observations[0]!.id;
    const superserObsId = fetched.observations[1]!.id;
    const r = await c.detach(a.conceptId, [supersededObsId, superserObsId]);

    // The supersession pointer must SURVIVE: both observations moved together, pointer is still intra-concept.
    expect(c.supersededObservationCount()).toBe(1);

    // Both observations must be on the destination concept.
    const dst = (await c.getConcept(r.destConceptId, { synthesize: false }))!;
    const dstIds = new Set(dst.observations.map((o) => o.id));
    expect(dstIds.has(supersededObsId)).toBe(true);
    expect(dstIds.has(superserObsId)).toBe(true);

    // Source must have only the third obs remaining.
    const src = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    expect(src.supportCount).toBe(1);
    c.close();
  });

  it("clears superseded_by on a remaining observation when its superseder is moved away (inbound case)", async () => {
    // Set up: obs A (old) is superseded by obs B (new), both on the same concept.
    // Then detach obs B (the superseder). The remaining obs A must have its superseded_by cleared.
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await c.store("Old value: retries 3.");
    const b = await c.store("New value: retries 5.", { attachTo: a.conceptId, kind: "correction" });
    expect(b.contradiction).toBeDefined();

    // Resolve by accepting new — obs A.superseded_by = obs B's id.
    c.resolveContradiction(b.contradiction!.id, { decision: "accept-new" });
    expect(c.supersededObservationCount()).toBe(1);

    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    // obs[0]=old(superseded), obs[1]=new(superseder). Add a third so source keeps 2 after detach.
    await c.store("Third obs.", { attachTo: a.conceptId });

    // Detach the superseder (obs B, index 1) — it moves away, leaving the old obs behind.
    const superserObsId = fetched.observations[1]!.id;
    await c.detach(a.conceptId, [superserObsId]);

    // The remaining obs (formerly superseded by the now-moved obs) must have superseded_by cleared.
    expect(c.supersededObservationCount()).toBe(0);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// Finding 1: kind propagation — detach-to-new must carry the source's kind
// ---------------------------------------------------------------------------
describe("detach — kind propagation to new concept (Finding 1)", () => {
  it("new destination concept inherits the source concept's kind", async () => {
    // Source concept is a "decision"; detaching one of its observations must
    // produce a destination concept that is also a "decision", not a "fact".
    const c = core();
    const a = await c.store("We decided to use TypeScript for all new modules.", { kind: "decision" });
    const a2 = await c.store("We decided to adopt pnpm as the package manager.", {
      attachTo: a.conceptId,
      kind: "decision",
    });

    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    expect(fetched.kind).toBe("decision");
    const obs2Id = fetched.observations[1]!.id;

    const r = await c.detach(a.conceptId, [obs2Id]);
    expect(r.destAction).toBe("created");

    const dest = (await c.getConcept(r.destConceptId, { synthesize: false }))!;
    expect(dest.kind).toBe("decision");
    c.close();
  });

  it("explicit-destination mode keeps the destination's own kind unchanged", async () => {
    // When detaching into an existing concept the destination's kind must not change.
    const c = core();
    const dest = await c.store("A fact-kind destination concept.", { kind: "fact" });
    const src = await c.store("A decision-kind source concept.", { kind: "decision" });
    await c.store("Second obs for source.", { attachTo: src.conceptId, kind: "decision" });

    const fetched = (await c.getConcept(src.conceptId, { synthesize: false }))!;
    const obs2Id = fetched.observations[1]!.id;

    const r = await c.detach(src.conceptId, [obs2Id], { destConceptId: dest.conceptId });
    expect(r.destAction).toBe("attached");

    const destAfter = (await c.getConcept(dest.conceptId, { synthesize: false }))!;
    expect(destAfter.kind).toBe("fact"); // unchanged
    c.close();
  });
});

// ---------------------------------------------------------------------------
// Finding 2: source_refs recompute after detach
// ---------------------------------------------------------------------------
describe("detach — source_refs recompute (Finding 2)", () => {
  it("source_refs are recomputed: source loses refs belonging only to the detached obs", async () => {
    // Use a core with graphEnabled so gather() actually returns results.
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });

    // Store obs1 with ref "file://alpha.md" → creates the concept.
    const a = await c.store("Alpha content for the source concept.", {
      sourceRefs: ["file://alpha.md"],
    });
    // Attach obs2 with ref "file://beta.md".
    await c.store("Beta content attached to source.", {
      attachTo: a.conceptId,
      sourceRefs: ["file://beta.md"],
    });

    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    expect(fetched.observations).toHaveLength(2);
    const obs2Id = fetched.observations[1]!.id;

    // Detach obs2 (the beta one) into a new concept.
    const r = await c.detach(a.conceptId, [obs2Id]);
    expect(r.destAction).toBe("created");

    // Source should now have only "file://alpha.md" in its refs.
    // Destination should have "file://beta.md".
    // Verify via gather() which reads concepts.source_refs for GatherCard.sourceRefs.
    // (ranked is GatherCard[] and includes seeds re-ranked; no need to fall back to seed.)
    const gSrc = await c.gather("Alpha content for the source concept.");
    const srcCard = gSrc.ranked.find((card) => card.id === a.conceptId);
    expect(srcCard?.sourceRefs).toEqual(["file://alpha.md"]);

    const gDst = await c.gather("Beta content attached to source.");
    const dstCard = gDst.ranked.find((card) => card.id === r.destConceptId);
    expect(dstCard?.sourceRefs).toEqual(["file://beta.md"]);

    c.close();
  });

  it("source_refs on attached destination: union of dest's existing refs and moved refs", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });

    // Dest concept with its own ref.
    const dest = await c.store("Destination concept.", { sourceRefs: ["file://dest.md"] });
    // Source concept: obs1 with ref alpha, obs2 with ref beta.
    const src = await c.store("Source obs one.", { sourceRefs: ["file://alpha.md"] });
    await c.store("Source obs two.", { attachTo: src.conceptId, sourceRefs: ["file://beta.md"] });

    const fetched = (await c.getConcept(src.conceptId, { synthesize: false }))!;
    const obs2Id = fetched.observations[1]!.id;

    await c.detach(src.conceptId, [obs2Id], { destConceptId: dest.conceptId });

    // Destination should now have dest.md ∪ beta.md.
    const gDst = await c.gather("Destination concept.");
    const dstCard = gDst.ranked.find((card) => card.id === dest.conceptId);
    const refs = dstCard?.sourceRefs ?? [];
    expect(refs).toContain("file://dest.md");
    expect(refs).toContain("file://beta.md");

    c.close();
  });
});

// ---------------------------------------------------------------------------
// Finding 3: contradiction row hygiene
// ---------------------------------------------------------------------------
describe("detach — contradiction row hygiene (Finding 3)", () => {
  it("(a) detach the correcting observation alone → contradiction dismissed, source restored, no superseded_by", async () => {
    // Set up: base concept with one observation, a correction opens a contradiction.
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const base = await c.store("Old decision: use Redis for caching.");
    const corr = await c.store("New decision: use Memcached instead of Redis.", {
      attachTo: base.conceptId,
      kind: "correction",
    });
    expect(corr.contradiction).toBeDefined();
    const contradictionId = corr.contradiction!.id;

    // Add a third uninvolved observation so we can detach the correction without triggering
    // the last-obs guard (source must keep at least one observation).
    await c.store("Context: caching layer decision made in Q2.", { attachTo: base.conceptId });

    // Pre-condition: source MUST still be 'disputed' after the guard obs was attached.
    // (Before the attach() root fix, attaching any evidence cleared 'disputed' to 'active',
    // making this check vacuous and the restore assertion below tautologically true.)
    const before = (await c.getConcept(base.conceptId, { synthesize: false }))!;
    expect(before.status).toBe("disputed"); // genuine pre-condition, not vacuous

    // Detach only the correcting observation (obs[1]) — leave original (obs[0]) and context (obs[2]).
    const fetched = (await c.getConcept(base.conceptId, { synthesize: false }))!;
    const corrObsId = fetched.observations[1]!.id; // the correction
    await c.detach(base.conceptId, [corrObsId]);

    // The contradiction must no longer be open on the source.
    const openContradictions = c.getOpenContradictions();
    expect(openContradictions.some((k) => k.id === contradictionId)).toBe(false);

    // Source must be restored to active (no remaining open contradictions).
    const srcAfter = (await c.getConcept(base.conceptId, { synthesize: false }))!;
    expect(srcAfter.status).toBe("active");

    // No observations must have been superseded (dismiss must not call accept-new logic).
    expect(c.supersededObservationCount()).toBe(0);

    c.close();
  });

  it("(b) detach ALL dispute observations together → contradiction travels to dest, dest disputed, source restored", async () => {
    // Set up: base obs A + correction obs B + uninvolved guard obs C.
    // Detach A + B together: the entire dispute moves to dest; C stays.
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const base = await c.store("Old plan: deploy to bare metal.");
    const corr = await c.store("New plan: deploy to Kubernetes instead.", {
      attachTo: base.conceptId,
      kind: "correction",
    });
    expect(corr.contradiction).toBeDefined();
    const contradictionId = corr.contradiction!.id;

    // Add guard obs C so source retains at least one observation after A+B are detached.
    await c.store("Context note: infrastructure decision.", { attachTo: base.conceptId });

    const fetched = (await c.getConcept(base.conceptId, { synthesize: false }))!;
    expect(fetched.observations).toHaveLength(3); // A, B, C
    const obsAId = fetched.observations[0]!.id; // original
    const obsBId = fetched.observations[1]!.id; // correction

    // Detach A and B together (the entire dispute).
    const r = await c.detach(base.conceptId, [obsAId, obsBId]);
    expect(r.destAction).toBe("created");

    // The contradiction row must now be on the destination, not the source.
    const srcContradictions = c.getOpenContradictions();
    // (getOpenContradictions returns all circles; check by id)
    expect(srcContradictions.some((k) => k.id === contradictionId && k.conceptId === base.conceptId)).toBe(false);
    expect(srcContradictions.some((k) => k.id === contradictionId && k.conceptId === r.destConceptId)).toBe(true);

    // Destination must be disputed.
    const destAfter = (await c.getConcept(r.destConceptId, { synthesize: false }))!;
    expect(destAfter.status).toBe("disputed");

    // Source must be restored to active.
    const srcAfter = (await c.getConcept(base.conceptId, { synthesize: false }))!;
    expect(srcAfter.status).toBe("active");

    c.close();
  });

  it("(c) entire dispute travels to an EXISTING destination → dest disputed, src restored, no clobber", async () => {
    // This tests F1 from the root-cause analysis: when detach() step 3.7 re-points the
    // contradiction and marks the destination 'disputed', step 5's attach() loop must NOT
    // clobber 'disputed' back to 'active'.  The attach() fix handles this automatically.
    const c = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });

    // Create an independent existing destination concept to receive the dispute.
    const dest = await c.store("Existing destination concept: infrastructure overview.");

    // Create source: base obs A + correction obs B + uninvolved guard obs C.
    const base = await c.store("Old plan: migrate to AWS.");
    const corr = await c.store("New plan: stay on-prem instead of AWS.", {
      attachTo: base.conceptId,
      kind: "correction",
    });
    expect(corr.contradiction).toBeDefined();
    const contradictionId = corr.contradiction!.id;

    // Guard obs C so source retains at least one observation after A+B are detached.
    await c.store("Context note: cost analysis is pending.", { attachTo: base.conceptId });

    // Pre-condition: source is genuinely 'disputed' after adding the guard obs.
    // (Proves the fix: attach() no longer demotes 'disputed' → 'active'.)
    const srcBefore = (await c.getConcept(base.conceptId, { synthesize: false }))!;
    expect(srcBefore.status).toBe("disputed");
    expect(srcBefore.observations).toHaveLength(3); // A, B, C

    const obsAId = srcBefore.observations[0]!.id; // original
    const obsBId = srcBefore.observations[1]!.id; // correction

    // Detach A + B into the EXISTING destination.
    const r = await c.detach(base.conceptId, [obsAId, obsBId], { destConceptId: dest.conceptId });
    expect(r.destAction).toBe("attached");
    expect(r.destConceptId).toBe(dest.conceptId);

    // The contradiction row must be re-pointed to the destination.
    const allOpen = c.getOpenContradictions();
    expect(allOpen.some((k) => k.id === contradictionId && k.conceptId === base.conceptId)).toBe(false);
    expect(allOpen.some((k) => k.id === contradictionId && k.conceptId === dest.conceptId)).toBe(true);

    // Destination must be 'disputed' — attach() in step 5 must NOT have clobbered it back to 'active'.
    const destAfter = (await c.getConcept(dest.conceptId, { synthesize: false }))!;
    expect(destAfter.status).toBe("disputed");

    // Source must be restored to active (no remaining open contradictions on source).
    const srcAfter = (await c.getConcept(base.conceptId, { synthesize: false }))!;
    expect(srcAfter.status).toBe("active");
    expect(allOpen.some((k) => k.conceptId === base.conceptId)).toBe(false);

    c.close();
  });
});

// ---------------------------------------------------------------------------
// F1 — consolidation path allows detaching ALL observations when destConceptId is provided
// ---------------------------------------------------------------------------
describe("detach — F1: one-observation consolidation into destConceptId", () => {
  it("detaches the only observation into destConceptId → observation on dest, source deleted", async () => {
    // Simulate the common output of an ambiguous fork: one-observation source.
    const db = new BetterSqlitePort(":memory:");
    const c = new MonetCore(db, { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const keeper = await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    const fork = await c.store("Monet Local uses SQLite for its local storage backend.");
    expect(fork.action).toBe("ambiguous");

    // Fork has exactly one observation — this is the common state to consolidate.
    const forkFetched = (await c.getConcept(fork.conceptId, { synthesize: false }))!;
    expect(forkFetched.observations).toHaveLength(1);
    const forkObsId = forkFetched.observations[0]!.id;

    const r = await c.detach(fork.conceptId, [forkObsId], { destConceptId: keeper.conceptId });

    // The detached observation must now be on the keeper.
    const keeperAfter = (await c.getConcept(keeper.conceptId, { synthesize: false }))!;
    expect(keeperAfter.observations.map((o) => o.id)).toContain(forkObsId);

    // Source must be deleted.
    expect(r.sourceDeleted).toBe(true);
    expect(await c.getConcept(fork.conceptId, { synthesize: false })).toBeNull();

    // Raw assertion: no contradiction row may outlive the deleted source concept.
    const orphaned = db
      .prepare(`SELECT COUNT(*) AS n FROM contradictions WHERE concept_id = ?`)
      .get(fork.conceptId) as { n: number };
    expect(orphaned.n).toBe(0);

    c.close();
  });

  it("possible_duplicate_of edge is gone and overview.possibleDuplicates is empty after consolidation", async () => {
    const db = new BetterSqlitePort(":memory:");
    const c = new MonetCore(db, { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const keeper = await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    const fork = await c.store("Monet Local uses SQLite for its local storage backend.");
    expect(fork.action).toBe("ambiguous");

    const before = c.edges({ circle: "default", type: "possible_duplicate_of" });
    expect(before.length).toBeGreaterThan(0);

    const forkFetched = (await c.getConcept(fork.conceptId, { synthesize: false }))!;
    const forkObsId = forkFetched.observations[0]!.id;

    await c.detach(fork.conceptId, [forkObsId], { destConceptId: keeper.conceptId });

    const after = c.edges({ circle: "default", type: "possible_duplicate_of" });
    expect(after.some((e) =>
      (e.srcId === keeper.conceptId && e.dstId === fork.conceptId) ||
      (e.srcId === fork.conceptId && e.dstId === keeper.conceptId),
    )).toBe(false);

    const overview = c.overview("default");
    expect(overview.possibleDuplicates).toHaveLength(0);

    // Raw assertion: no contradiction row may outlive the deleted source concept.
    const orphaned = db
      .prepare(`SELECT COUNT(*) AS n FROM contradictions WHERE concept_id = ?`)
      .get(fork.conceptId) as { n: number };
    expect(orphaned.n).toBe(0);

    c.close();
  });

  it("detach-all-to-new (no destConceptId) still throws the last-observation error", async () => {
    const c = core();
    const a = await c.store("Only observation.");
    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    const obsId = fetched.observations[0]!.id;
    await expect(c.detach(a.conceptId, [obsId])).rejects.toThrow(/last observation/);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// F2 — title/slug recomputed after detaching the first (title-bearing) observation
// ---------------------------------------------------------------------------
describe("detach — F2: title/slug recompute after detaching first observation", () => {
  it("source title derives from the first REMAINING observation when the original title obs is detached", async () => {
    const c = core();
    const a = await c.store("First observation: the title-bearing content.");
    await c.store("Second observation: the remaining content.", { attachTo: a.conceptId });

    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    const obs1Id = fetched.observations[0]!.id; // the title-bearing one

    await c.detach(a.conceptId, [obs1Id]);

    const srcAfter = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    // Title must now derive from the second observation, not the detached one.
    expect(srcAfter.title).toContain("Second observation");
    expect(srcAfter.title).not.toContain("First observation");
    c.close();
  });
});

// ---------------------------------------------------------------------------
// F3 — mirror contradiction case: correcting obs stays, all prior evidence moves
// ---------------------------------------------------------------------------
describe("detach — F3: mirror contradiction hygiene (prior moves, correction stays)", () => {
  it("(a) detach all prior evidence, correction stays → contradiction dismissed, source active", async () => {
    const db = new BetterSqlitePort(":memory:");
    const c = new MonetCore(db, { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const base = await c.store("Old setting: timeout 30s.");
    const corr = await c.store("New setting: timeout 60s.", {
      attachTo: base.conceptId,
      kind: "correction",
    });
    expect(corr.contradiction).toBeDefined();
    const contradictionId = corr.contradiction!.id;

    // Add a guard obs so we can detach the prior without hitting last-obs.
    await c.store("Guard observation.", { attachTo: base.conceptId });

    const fetched = (await c.getConcept(base.conceptId, { synthesize: false }))!;
    // obs[0]=base(prior), obs[1]=correction, obs[2]=guard(post-correction, not party to dispute)
    expect(fetched.observations).toHaveLength(3);
    const priorObsId = fetched.observations[0]!.id; // prior (to be detached)
    const corrObsId = fetched.observations[1]!.id;  // correction (stays)
    const guardObsId = fetched.observations[2]!.id; // guard (stays)

    // Sanity: source is disputed.
    expect(fetched.status).toBe("disputed");

    // Detach only the prior — correction stays.
    await c.detach(base.conceptId, [priorObsId]);

    // The contradiction must be dismissed (all prior evidence moved, correction stays).
    const openContras = c.getOpenContradictions();
    expect(openContras.some((k) => k.id === contradictionId)).toBe(false);

    // Raw assertion: the row must be present with status='dismissed', not absent.
    // Distinguishes a proper dismiss (row survives with dismissed status) from accidental deletion.
    const rawRow = db
      .prepare(`SELECT status FROM contradictions WHERE id = ?`)
      .get(contradictionId) as { status: string } | undefined;
    expect(rawRow).toBeDefined();
    expect(rawRow!.status).toBe("dismissed");

    // Source must be restored to active.
    const srcAfter = (await c.getConcept(base.conceptId, { synthesize: false }))!;
    expect(srcAfter.status).toBe("active");
    expect(srcAfter.observations.map((o) => o.id)).toContain(corrObsId);
    expect(srcAfter.observations.map((o) => o.id)).toContain(guardObsId);

    c.close();
  });

  it("(b) detach SOME prior evidence, correction stays → contradiction still open, source still disputed", async () => {
    const db = new BetterSqlitePort(":memory:");
    const c = new MonetCore(db, { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const base = await c.store("Old setting: cache size 100.");
    // Add a second prior obs before the correction so there are 2 prior observations.
    await c.store("Additional prior: was already low.", { attachTo: base.conceptId });
    const corr = await c.store("New setting: cache size 200.", {
      attachTo: base.conceptId,
      kind: "correction",
    });
    expect(corr.contradiction).toBeDefined();
    const contradictionId = corr.contradiction!.id;
    // Add a guard obs so we can detach one prior without hitting last-obs.
    await c.store("Guard obs.", { attachTo: base.conceptId });

    const fetched = (await c.getConcept(base.conceptId, { synthesize: false }))!;
    // obs[0]=base(prior1), obs[1]=additional(prior2), obs[2]=correction, obs[3]=guard
    expect(fetched.observations).toHaveLength(4);
    const prior1Id = fetched.observations[0]!.id;

    // Source is disputed.
    expect(fetched.status).toBe("disputed");

    // Detach only obs[0] (one of two priors) — one prior and correction stay.
    await c.detach(base.conceptId, [prior1Id]);

    // Contradiction must still be open.
    const openContras = c.getOpenContradictions();
    expect(openContras.some((k) => k.id === contradictionId)).toBe(true);

    // Raw assertion: the row must be present with status='open', not absent.
    const rawRow = db
      .prepare(`SELECT status FROM contradictions WHERE id = ?`)
      .get(contradictionId) as { status: string } | undefined;
    expect(rawRow).toBeDefined();
    expect(rawRow!.status).toBe("open");

    // Source must still be disputed.
    const srcAfter = (await c.getConcept(base.conceptId, { synthesize: false }))!;
    expect(srcAfter.status).toBe("disputed");

    c.close();
  });
});

// ---------------------------------------------------------------------------
// F4 — workstream concept guard on store(attachTo), detach(source), detach(destConceptId)
// ---------------------------------------------------------------------------
describe("detach — F4: workstream concept rejection", () => {
  it("store({ attachTo: workstreamId }) throws 'cannot attach to a workstream concept'", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const ws = await c.saveWorkstream({ status: "active", openQuestions: ["q1"] });
    await expect(
      c.store("Some new observation.", { attachTo: ws.id }),
    ).rejects.toThrow(/cannot attach to a workstream concept/);
    c.close();
  });

  it("detach({ destConceptId: workstreamId }) throws 'cannot attach to a workstream concept'", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const ws = await c.saveWorkstream({ status: "active" });
    const a = await c.store("Obs one.");
    await c.store("Obs two.", { attachTo: a.conceptId });
    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    const obs2Id = fetched.observations[1]!.id;
    await expect(
      c.detach(a.conceptId, [obs2Id], { destConceptId: ws.id }),
    ).rejects.toThrow(/cannot attach to a workstream concept/);
    c.close();
  });

  it("detach(workstreamId as source) throws 'cannot detach from a workstream concept'", async () => {
    const c = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const ws = await c.saveWorkstream({ status: "active" });
    await expect(
      c.detach(ws.id, ["any-obs-id"]),
    ).rejects.toThrow(/cannot detach from a workstream concept/);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// F7 — destConceptId === sourceConceptId rejected
// ---------------------------------------------------------------------------
describe("detach — F7: self-consolidation rejected", () => {
  it("throws when destConceptId equals sourceConceptId", async () => {
    const c = core();
    const a = await c.store("Some observation.");
    await c.store("Second observation.", { attachTo: a.conceptId });
    const fetched = (await c.getConcept(a.conceptId, { synthesize: false }))!;
    const obs2Id = fetched.observations[1]!.id;
    await expect(
      c.detach(a.conceptId, [obs2Id], { destConceptId: a.conceptId }),
    ).rejects.toThrow(/destConceptId must differ from the source concept/);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// NULL-observation contradiction survives consolidation (orphan-row bug fix)
// ---------------------------------------------------------------------------
describe("detach — NULL-observation contradiction travels on consolidation", () => {
  it("open contradiction with observation_id=NULL travels to dest; no orphaned row on deleted source", async () => {
    // Setup: one-observation source concept with a NULL-observation contradiction
    // (flagContradiction without observationId — the publicly reachable path).
    const db = new BetterSqlitePort(":memory:");
    const c = new MonetCore(db, { tauAttach: 0.9, tauAmbiguous: 0.1 });

    const keeper = await c.store("We decided to use SQLite as the storage backend for Monet Local.");
    const source = await c.store("Monet Local uses SQLite for its local storage backend.");
    // source is ambiguous (one observation, one-obs ambiguous fork).
    expect(source.action).toBe("ambiguous");

    // Flag a NULL-observation contradiction on the source — no observationId supplied.
    const contra = c.flagContradiction(source.conceptId, {
      detail: "a reviewer questions whether SQLite is correct here",
    });
    expect(contra.status).toBe("open");
    // Verify the observation_id is NULL at the raw row level.
    const rawBefore = db
      .prepare(`SELECT observation_id FROM contradictions WHERE id = ?`)
      .get(contra.id) as { observation_id: string | null };
    expect(rawBefore.observation_id).toBeNull();

    // Source is now disputed.
    const srcBefore = (await c.getConcept(source.conceptId, { synthesize: false }))!;
    expect(srcBefore.status).toBe("disputed");

    // Consolidate: detach the only observation into keeper → source is deleted.
    const forkFetched = (await c.getConcept(source.conceptId, { synthesize: false }))!;
    const forkObsId = forkFetched.observations[0]!.id;
    const r = await c.detach(source.conceptId, [forkObsId], { destConceptId: keeper.conceptId });
    expect(r.sourceDeleted).toBe(true);

    // Raw assertion: ZERO contradiction rows pointing at the now-deleted source.
    const orphaned = db
      .prepare(`SELECT COUNT(*) AS n FROM contradictions WHERE concept_id = ?`)
      .get(source.conceptId) as { n: number };
    expect(orphaned.n).toBe(0);

    // The contradiction row must now live on the destination with status='open'.
    const movedRow = db
      .prepare(`SELECT concept_id, status FROM contradictions WHERE id = ?`)
      .get(contra.id) as { concept_id: string; status: string } | undefined;
    expect(movedRow).toBeDefined();
    expect(movedRow!.concept_id).toBe(keeper.conceptId);
    expect(movedRow!.status).toBe("open");

    // Destination must be marked disputed (open contradiction landed there).
    const destAfter = (await c.getConcept(keeper.conceptId, { synthesize: false }))!;
    expect(destAfter.status).toBe("disputed");

    c.close();
  });
});
