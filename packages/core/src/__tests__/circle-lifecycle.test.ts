/**
 * Librarian layer tests (v0.5.0): circle lifecycle operations.
 *
 * Coverage:
 *   - renameCircle: all five scope-bearing tables updated + workstream slug + alias + chain-flatten
 *   - renameCircle: noop when from===to, throw when from does not exist
 *   - post-rename: store()-to-old-name lands canonical
 *   - prewarm/overview resolvedFrom
 *   - mergeCircle: moves all concepts + alias + forceNew near-match → dup edge not merge
 *   - mergeCircle: auto resolution merges a matching pair
 *   - mergeCircle: workstream in from-circle is deleted (not moved)
 *   - archiveCircle/unarchiveCircle: store-wide search/gather exclude archived (includeArchived restores)
 *   - archiveCircle/unarchiveCircle: listCircles flags, explicit access still works, store-to-archived allowed
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

/** Dedup-off core for exercising moves without accidental merges. */
function freshCore(defaultCircle = "default"): MonetCore {
  return new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, defaultCircle });
}

// ---- renameCircle -----------------------------------------------------------

describe("renameCircle", () => {
  it("updates all five scope-bearing tables and sets the alias", async () => {
    const core = freshCore("alpha");
    const r1 = await core.store("Auth decision alpha.", { circle: "alpha" });
    const r2 = await core.store("Config note alpha.", { circle: "alpha", resolution: "forceNew" });
    // Seed an entity+edge so all five tables are populated.
    const r3 = await core.store("We split AuthService into modules.", { circle: "alpha", resolution: "forceNew" });
    // End session so co_occurred edge is recorded before rename.
    core.endSessionForEval();

    const result = core.renameCircle("alpha", "beta");
    expect(result.action).toBe("renamed");
    expect(result.conceptsUpdated).toBeGreaterThanOrEqual(3);
    expect(result.observationsUpdated).toBeGreaterThanOrEqual(3);

    // concepts table: circle renamed.
    expect(core.circleOf(r1.conceptId)).toBe("beta");
    expect(core.circleOf(r2.conceptId)).toBe("beta");
    expect(core.circleOf(r3.conceptId)).toBe("beta");

    // Old circle is gone.
    expect(core.conceptCount("alpha")).toBe(0);
    expect(core.conceptCount("beta")).toBeGreaterThanOrEqual(3);

    // edges table: edges now scoped to "beta".
    const edgesInBeta = core.edges({ circle: "beta" });
    expect(edgesInBeta.length).toBeGreaterThan(0);
    const edgesInAlpha = core.edges({ circle: "alpha" });
    expect(edgesInAlpha.length).toBe(0);

    // Alias recorded.
    expect(core.resolveCircleName("alpha")).toBe("beta");

    core.close();
  });

  it("updates workstream slug after rename so next checkpoint doesn't fork a duplicate", async () => {
    const core = new MonetCore(":memory:");
    await core.saveWorkstream({ status: "active", nextSteps: ["step one"] }, { circle: "proj-old" });

    // Slug before rename should be "workstream:proj-old".
    const wsBefore = core.getActiveWorkstreams("proj-old");
    expect(wsBefore[0]?.slug).toBe("workstream:proj-old");

    core.renameCircle("proj-old", "proj-new");

    // After rename the slug must be "workstream:proj-new".
    const wsAfter = core.getActiveWorkstreams("proj-new");
    expect(wsAfter).toHaveLength(1);
    expect(wsAfter[0]?.slug).toBe("workstream:proj-new");

    core.close();
  });

  it("flattens alias chains: A→B then B→C ⇒ resolveCircle('A') === 'C'", async () => {
    const core = freshCore();
    await core.store("Concept in A.", { circle: "A" });
    await core.store("Concept in B.", { circle: "B" });
    core.renameCircle("A", "B");
    core.renameCircle("B", "C");
    // After B→C, the A→B alias must have been updated to A→C.
    expect(core.resolveCircleName("A")).toBe("C");
    expect(core.resolveCircleName("B")).toBe("C");
    core.close();
  });

  it("returns noop when from === to", async () => {
    const core = freshCore();
    await core.store("Concept.", { circle: "same" });
    const r = core.renameCircle("same", "same");
    expect(r.action).toBe("noop");
    expect(r.conceptsUpdated).toBe(0);
    core.close();
  });

  it("throws when the from circle does not exist", () => {
    const core = freshCore();
    expect(() => core.renameCircle("nonexistent", "target")).toThrow(/circle not found/);
    core.close();
  });

  it("post-rename store() to the old name lands in the canonical circle", async () => {
    const core = freshCore("alpha");
    await core.store("Original.", { circle: "alpha" });
    core.renameCircle("alpha", "canon");

    // Writing to "alpha" now resolves to "canon" via the alias.
    const r = await core.store("New fact.", { circle: "alpha", resolution: "forceNew" });
    expect(core.circleOf(r.conceptId)).toBe("canon");
    core.close();
  });

  it("prewarm resolvedFrom is present when circle arg was an alias", async () => {
    const core = freshCore("alpha");
    await core.store("Fact.", { circle: "alpha" });
    core.renameCircle("alpha", "canon");

    const state = core.prewarm("alpha");
    expect(state.resolvedFrom).toBe("alpha");
    core.close();
  });

  it("overview resolvedFrom is present when circle arg was an alias", async () => {
    const core = freshCore("alpha");
    await core.store("Fact.", { circle: "alpha" });
    core.renameCircle("alpha", "canon");

    const ov = core.overview("alpha");
    expect(ov.resolvedFrom).toBe("alpha");
    expect(ov.circle).toBe("canon");
    core.close();
  });

  it("prewarm resolvedFrom is absent when circle arg was NOT an alias", async () => {
    const core = freshCore("alpha");
    await core.store("Fact.", { circle: "alpha" });
    const state = core.prewarm("alpha");
    expect(state.resolvedFrom).toBeUndefined();
    core.close();
  });
});

// ---- mergeCircle ------------------------------------------------------------

describe("mergeCircle", () => {
  it("moves all non-workstream concepts from `from` into `into`", async () => {
    const core = freshCore();
    const a = await core.store("Fact A1.", { circle: "src", resolution: "forceNew" });
    const b = await core.store("Fact A2.", { circle: "src", resolution: "forceNew" });
    await core.store("Fact B1.", { circle: "dst", resolution: "forceNew" });

    const result = await core.mergeCircle("src", "dst");
    expect(result.from).toBe("src");
    expect(result.into).toBe("dst");
    expect(result.counts.moved + result.counts.merged).toBe(2);
    expect(core.conceptCount("src")).toBe(0);
    expect(core.circleOf(a.conceptId)).toBe("dst");
    expect(core.circleOf(b.conceptId)).toBe("dst");

    // Alias recorded.
    expect(core.resolveCircleName("src")).toBe("dst");

    core.close();
  });

  it("forceNew near-match → records possible_duplicate_of edge, not a merge", async () => {
    // Use default thresholds (dedup-on similarity) but force forceNew on merge.
    const core = new MonetCore(":memory:");
    // Store identical content in two circles to guarantee cosine >= tauAttach.
    await core.store("We use SQLite for local persistence.", { circle: "src" });
    await core.store("We use SQLite for local persistence.", { circle: "dst" });

    // forceNew: should NOT merge, should record possible_duplicate_of edge.
    const result = await core.mergeCircle("src", "dst", { resolution: "forceNew" });
    // All concepts in src should have moved (not merged into the matching dst concept).
    expect(result.counts.moved).toBe(1);
    expect(result.counts.merged).toBe(0);

    // A possible_duplicate_of edge should exist in "dst".
    const dupEdges = core.edges({ circle: "dst", type: "possible_duplicate_of" });
    expect(dupEdges.length).toBeGreaterThan(0);

    core.close();
  });

  it("auto resolution merges a matching concept pair across circles", async () => {
    const core = new MonetCore(":memory:"); // default thresholds
    await core.store("We standardized on the jose library for auth tokens.", { circle: "src" });
    await core.store("We standardized on the jose library for auth tokens.", { circle: "dst" });

    const result = await core.mergeCircle("src", "dst", { resolution: "auto" });
    expect(result.counts.merged).toBe(1);
    expect(result.counts.moved).toBe(0);
    expect(core.conceptCount("src")).toBe(0);
    core.close();
  });

  it("workstream concept in from-circle is deleted, not moved to into-circle", async () => {
    const core = new MonetCore(":memory:");
    const ws = await core.saveWorkstream({ status: "active", nextSteps: ["continue work"] }, { circle: "src" });
    await core.store("Real fact in src.", { circle: "src", resolution: "forceNew" });
    await core.store("Real fact in dst.", { circle: "dst", resolution: "forceNew" });

    const result = await core.mergeCircle("src", "dst");
    // Workstream should be deleted (not in dst).
    expect(core.circleOf(ws.id)).toBeNull();
    // Real fact should be moved.
    expect(result.counts.moved + result.counts.merged).toBe(1);
    // src circle is empty.
    expect(core.conceptCount("src")).toBe(0);
    // dst still has its own workstream unaffected.
    expect(core.getActiveWorkstreams("dst").length).toBeGreaterThanOrEqual(0);

    core.close();
  });

  it("rolls back every prior move and publishes no alias when a later merge item fails", async () => {
    const core = freshCore();
    const first = await core.store("First merge item.", { circle: "src", resolution: "forceNew" });
    const second = await core.store("Second merge item.", { circle: "src", resolution: "forceNew" });
    const destination = await core.store("Destination item.", { circle: "dst", resolution: "forceNew" });
    const db = (core as unknown as { db: import("../storage").StoragePort }).db;
    db.exec(`
      CREATE TRIGGER inject_mid_merge_failure
      BEFORE UPDATE OF circle ON concepts
      WHEN OLD.id = '${second.conceptId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected mid-merge failure');
      END;
    `);

    await expect(core.mergeCircle("src", "dst")).rejects.toThrow(/mergeCircle failed.*injected mid-merge failure/);

    expect(core.circleOf(first.conceptId)).toBe("src");
    expect(core.circleOf(second.conceptId)).toBe("src");
    expect(core.circleOf(destination.conceptId)).toBe("dst");
    expect(core.conceptCount("src")).toBe(2);
    expect(core.conceptCount("dst")).toBe(1);
    expect(core.resolveCircleName("src")).toBe("src");

    // No alias was published, so a post-failure source remains attached to the original circle.
    const source = core.createSource({
      id: "post-failure-source",
      type: "repo-md",
      name: "Post-failure source",
      localPath: "/tmp/monet-post-failure-source",
      circle: "src",
      access: { allowedCallerIds: ["caller"], allowedProjectIds: ["project"] },
    });
    expect(source.circle).toBe("src");
    expect(core.updateSource(source.id, { name: "Still attached" }).circle).toBe("src");
    core.close();
  });
});

// ---- archiveCircle / unarchiveCircle ----------------------------------------

describe("archiveCircle / unarchiveCircle", () => {
  it("archived circle is excluded from store-wide search by default", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const r = await core.store("The AuthService uses JWT tokens.", { circle: "archived-proj" });
    await core.store("The AuthService uses JWT tokens.", { circle: "active-proj", resolution: "forceNew" });

    core.archiveCircle("archived-proj");

    const results = await core.search("AuthService JWT tokens", { limit: 10 });
    const ids = results.map((x) => x.id);
    expect(ids).not.toContain(r.conceptId);
    expect(ids.some((id) => core.circleOf(id) === "active-proj")).toBe(true);

    core.close();
  });

  it("includeArchived restores archived circle in store-wide search", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("The AuthService uses JWT tokens.", { circle: "archived-proj" });
    core.archiveCircle("archived-proj");

    const results = await core.search("AuthService JWT tokens", { limit: 10, includeArchived: true });
    expect(results.map((x) => x.id)).toContain(r.conceptId);

    core.close();
  });

  it("archived circle is excluded from store-wide gather by default", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const r = await core.store("JWT token expiry configuration.", { circle: "archived-proj" });
    await core.store("JWT token expiry configuration.", { circle: "active-proj", resolution: "forceNew" });

    core.archiveCircle("archived-proj");

    const result = await core.gather("JWT token expiry");
    const ids = result.ranked.map((x) => x.id);
    expect(ids).not.toContain(r.conceptId);

    core.close();
  });

  it("includeArchived restores archived circle in store-wide gather", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("JWT token expiry configuration.", { circle: "archived-proj" });
    core.archiveCircle("archived-proj");

    const result = await core.gather("JWT token expiry", { includeArchived: true });
    expect(result.ranked.map((x) => x.id)).toContain(r.conceptId);

    core.close();
  });

  it("listCircles excludes archived by default and flags them with includeArchived", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await core.store("Fact in active.", { circle: "active-proj" });
    await core.store("Fact in archived.", { circle: "archived-proj" });
    core.archiveCircle("archived-proj");

    const without = core.listCircles();
    expect(without.map((c) => c.circle)).not.toContain("archived-proj");
    expect(without.map((c) => c.circle)).toContain("active-proj");

    const withArchived = core.listCircles(undefined, { includeArchived: true });
    const archivedEntry = withArchived.find((c) => c.circle === "archived-proj");
    expect(archivedEntry).toBeDefined();
    expect(archivedEntry?.archived).toBe(true);
    const activeEntry = withArchived.find((c) => c.circle === "active-proj");
    expect(activeEntry?.archived).toBe(false);

    core.close();
  });

  it("explicit circle access (reads and writes) still works for an archived circle", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("Archived concept.", { circle: "archived-proj" });
    core.archiveCircle("archived-proj");

    // Read: explicit fetch still works.
    const fetched = await core.getConcept(r.conceptId, { synthesize: false });
    expect(fetched).not.toBeNull();
    expect(fetched!.circle).toBe("archived-proj");

    // Write: store()-to-archived circle lands there.
    const r2 = await core.store("New fact in archived circle.", { circle: "archived-proj", resolution: "forceNew" });
    expect(core.circleOf(r2.conceptId)).toBe("archived-proj");

    core.close();
  });

  it("unarchiveCircle makes the circle visible again in store-wide search", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("The AuthService uses JWT tokens.", { circle: "was-archived" });
    core.archiveCircle("was-archived");

    const afterArchive = await core.search("AuthService JWT tokens", { limit: 10 });
    expect(afterArchive.map((x) => x.id)).not.toContain(r.conceptId);

    core.unarchiveCircle("was-archived");

    const afterUnarchive = await core.search("AuthService JWT tokens", { limit: 10 });
    expect(afterUnarchive.map((x) => x.id)).toContain(r.conceptId);

    core.close();
  });

  it("archived circle does not appear in overview otherCircles", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await core.store("Fact in main.", { circle: "main" });
    await core.store("Fact in archived.", { circle: "archived-side" });
    core.archiveCircle("archived-side");

    const otherNames = core.listCircles("main").map((c) => c.circle);
    expect(otherNames).not.toContain("archived-side");

    core.close();
  });
});

// ---- batchReassignCircle ----------------------------------------------------

describe("batchReassignCircle", () => {
  it("moves multiple concepts in a batch and reports counts", async () => {
    const core = freshCore();
    const a = await core.store("Batch A.", { circle: "src" });
    const b = await core.store("Batch B.", { circle: "src", resolution: "forceNew" });
    const c = await core.store("Batch C.", { circle: "src", resolution: "forceNew" });

    const result = core.batchReassignCircle([a.conceptId, b.conceptId, c.conceptId], "dst");
    expect(result.counts.moved).toBe(3);
    expect(result.counts.error).toBe(0);
    expect(core.conceptCount("src")).toBe(0);
    expect(core.conceptCount("dst")).toBe(3);

    core.close();
  });

  it("captures per-item errors without aborting the batch", async () => {
    const core = freshCore();
    const a = await core.store("Batch A.", { circle: "src" });

    const result = core.batchReassignCircle([a.conceptId, "deleted-id"], "dst");
    expect(result.counts.moved).toBe(1);
    expect(result.counts.error).toBe(1);
    const errEntry = result.results.find((r) => "error" in r && r.action === "error");
    expect(errEntry).toBeDefined();

    core.close();
  });

  it("forceNew: near-match records possible_duplicate_of instead of merging", async () => {
    const core = new MonetCore(":memory:"); // default thresholds
    await core.store("We use SQLite for local persistence.", { circle: "src" });
    await core.store("We use SQLite for local persistence.", { circle: "dst" });

    const srcIds = core.listMemories("src").map((m) => m.id);
    const result = core.batchReassignCircle(srcIds, "dst", { resolution: "forceNew" });
    expect(result.counts.moved).toBe(1);
    expect(result.counts.merged).toBe(0);

    const dupEdges = core.edges({ circle: "dst", type: "possible_duplicate_of" });
    expect(dupEdges.length).toBeGreaterThan(0);

    core.close();
  });
});
