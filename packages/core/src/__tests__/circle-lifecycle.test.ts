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
 *   - mergeCircle: work threads move losslessly; inbox histories item-merge
 *   - archiveCircle/unarchiveCircle: store-wide search excludes archived (includeArchived restores)
 *   - archiveCircle/unarchiveCircle: listCircles flags, explicit access still works, store-to-archived allowed
 *   - store-to-archived DISCLOSES (#55): every resolution branch, aliased destinations, and a
 *     circle archived mid-write; memory_store's acknowledgement carries the sentence
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";

/** Dedup-off core for exercising moves without accidental merges. */
function freshCore(defaultCircle = "default"): MonetCore {
  return new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, defaultCircle });
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A file-backed store, for the tests that need a real SECOND connection to it. */
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "monet-circle-lifecycle-"));
  tmpDirs.push(dir);
  return join(dir, "race.db");
}

/** Boot an in-process MCP server+client pair sharing a MonetCore (same shape as mcp-roster's). */
async function makeMcpPair(core: MonetCore): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "monet-core-test", version: "0.6.0" }, { capabilities: { tools: {} } });
  registerMonetCoreTools(server, core, { autoPrewarm: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return { client, cleanup: async () => { await client.close(); core.close(); } };
}

/** Call memory_store over the wire and parse the acknowledgement envelope. */
async function storeOverMcp(client: Client, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await client.callTool({ name: "memory_store", arguments: args }) as
    { content: Array<{ type: string; text: string }> };
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
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
    await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "step one" }] }, { circle: "proj-old" });

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

  it("moves source work threads losslessly and counts them as moved", async () => {
    const core = new MonetCore(":memory:");
    const ws = await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "continue work" }] }, { circle: "src" });
    await core.store("Real fact in src.", { circle: "src", resolution: "forceNew" });
    await core.store("Real fact in dst.", { circle: "dst", resolution: "forceNew" });

    const result = await core.mergeCircle("src", "dst");
    expect(core.circleOf(ws!.id)).toBe("dst");
    expect(result.counts.moved + result.counts.merged).toBe(2);
    expect(result.conceptResults).toContainEqual(expect.objectContaining({
      action: "moved",
      conceptId: ws!.id,
      fromCircle: "src",
      toCircle: "dst",
    }));
    expect(core.conceptCount("src")).toBe(0);
    expect(core.getActiveWorkstreams("dst").map((row) => row.id)).toContain(ws!.id);

    core.close();
  });

  it("moves colliding named and unnamed threads and item-merges inboxes with pinned counts", async () => {
    const core = new MonetCore(":memory:");
    const srcUnnamed = (await core.saveWorkstream({ status: "active" }, { circle: "src" }))!;
    const dstUnnamed = (await core.saveWorkstream({ status: "active" }, { circle: "dst" }))!;
    const srcNamed = (await core.saveWorkstream({ title: "Auth", status: "active" }, { circle: "src" }))!;
    const dstNamed = (await core.saveWorkstream({ title: "Auth", status: "active" }, { circle: "dst" }))!;
    const srcInbox = await core.captureFind("source find", { circle: "src" });
    const dstInbox = await core.captureFind("destination find", { circle: "dst" });

    const result = await core.mergeCircle("src", "dst");

    expect(result.counts).toEqual({ moved: 2, merged: 1, noop: 0, error: 0 });
    expect(result.conceptResults.filter((row) => row.action === "moved").map((row) => row.conceptId).sort())
      .toEqual([srcUnnamed.id, srcNamed.id].sort());
    expect(result.conceptResults).toContainEqual(expect.objectContaining({
      action: "merged",
      conceptId: srcInbox.row.id,
      mergedIntoId: dstInbox.row.id,
    }));
    expect(core.getActiveWorkstreams("dst").map((row) => row.id).sort())
      .toEqual([srcUnnamed.id, dstUnnamed.id, srcNamed.id, dstNamed.id].sort());
    expect(core.getWorkstreamInbox("dst")?.payload.items.map((item) => item.text).sort())
      .toEqual(["destination find", "source find"]);
    core.close();
  });

  it("a self-merge is a no-op and leaves the entity index intact", async () => {
    const core = freshCore();
    await core.store("We split AuthService into modules.", { circle: "solo", resolution: "forceNew" });
    const entitiesBefore = core.overview("solo").counts.entities;
    expect(entitiesBefore).toBeGreaterThan(0);

    // Unconditional whole-circle relocation made a self-merge destructive (entity df doubling,
    // then full index deletion for the scope) — refuse it before the helper runs.
    const result = await core.mergeCircle("solo", "solo");
    expect(result.counts).toEqual({ moved: 0, merged: 0, noop: 0, error: 0 });
    expect(result.conceptResults).toEqual([]);
    expect(core.overview("solo").counts.entities).toBe(entitiesBefore);
    expect(core.conceptCount("solo")).toBe(1);
    core.close();
  });

  it("relocates the normative substrate even when the source holds no workstream", async () => {
    const core = freshCore();
    const src = await core.store("Substrate source concept.", { circle: "src", resolution: "forceNew" });
    const dst = await core.store("Destination concept.", { circle: "dst", resolution: "forceNew" });
    const db = (core as unknown as { db: import("../storage").StoragePort }).db;
    db.prepare(
      `INSERT INTO lifecycle_edges (id, family, src_concept_id, dst_concept_id, born_of, event_ref, circle, created_at, sync_updated_at)
       VALUES ('merge-substrate-edge','derivation',?,?,'ratification','r-merge','src',1,1)`,
    ).run(src.conceptId, dst.conceptId);
    db.prepare(
      `INSERT INTO ratifications (id, subject_concept_id, verdict, packet, ratified_by, circle, created_at, sync_updated_at)
       VALUES ('merge-substrate-rat',?,'approve',NULL,'fixture','src',1,1)`,
    ).run(src.conceptId);

    await core.mergeCircle("src", "dst");

    // A merge moves the whole circle: normative rows must not stay behind naming a dead
    // circle, and the relocation must not depend on the source having held a workstream.
    expect(db.prepare(`SELECT circle FROM lifecycle_edges WHERE id='merge-substrate-edge'`).get())
      .toEqual({ circle: "dst" });
    expect(db.prepare(`SELECT circle FROM ratifications WHERE id='merge-substrate-rat'`).get())
      .toEqual({ circle: "dst" });
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

  it("archived circle remains excluded from store-wide search by default", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const r = await core.store("JWT token expiry configuration.", { circle: "archived-proj" });
    await core.store("JWT token expiry configuration.", { circle: "active-proj", resolution: "forceNew" });

    core.archiveCircle("archived-proj");

    const result = await core.search("JWT token expiry");
    const ids = result.map((x) => x.id);
    expect(ids).not.toContain(r.conceptId);

    core.close();
  });

  it("includeArchived continues to restore archived circle in store-wide search", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("JWT token expiry configuration.", { circle: "archived-proj" });
    core.archiveCircle("archived-proj");

    const result = await core.search("JWT token expiry", { includeArchived: true });
    expect(result.map((x) => x.id)).toContain(r.conceptId);

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

  /**
   * ISSUE #55 — THE DISCLOSURE, NOT A REFUSAL. The write is legitimate (the test above is the
   * contract: archived = hidden by default, not sealed), so what was broken was the SILENCE: the
   * acknowledgement let a caller walk away believing it had made something store-wide recallable
   * when the destination is outside search, the overview and the default circle list.
   *
   * ALL THREE RESOLUTION BRANCHES, because all three land somewhere. An attach, a fork and a
   * creation are equally invisible in an archived circle, and a disclosure that fired on only one
   * of them would go quiet exactly where the caller had least reason to look. Each branch gets its
   * own circle — resolution scans per circle, so the three cases cannot contaminate each other —
   * and the two that need something to resolve against are seeded BEFORE the archive, which is the
   * realistic shape: a circle that was worked in and later shelved.
   */
  it("discloses the archived destination on every resolution branch — created, attached and ambiguous", async () => {
    const core = new MonetCore(":memory:");
    const seedPhrase = "We decided to use SQLite as the storage backend for Monet Local.";
    const seedAttach = await core.store(seedPhrase, { circle: "attic-attach" });
    const seedFork = await core.store(seedPhrase, { circle: "attic-fork" });
    // A LIVE circle answers the question too, and answers it `false`: the destination was asked
    // about and is fine, which is a verdict — not the silence the old acknowledgement gave.
    expect(seedAttach.landedInArchivedCircle).toBe(false);

    core.archiveCircle("attic-new");
    core.archiveCircle("attic-attach");
    core.archiveCircle("attic-fork");

    const created = await core.store("Redis backs the rate limiter.", { circle: "attic-new" });
    expect(created.action).toBe("created");
    expect(created.landedInArchivedCircle).toBe(true);

    // Scores ~0.75 against the seed with the hashing embedder — robustly above tauAttach (0.55).
    const attached = await core.store("Monet Local uses SQLite for its local storage backend.", { circle: "attic-attach" });
    expect(attached.action).toBe("attached");
    expect(attached.conceptId).toBe(seedAttach.conceptId);
    expect(attached.landedInArchivedCircle).toBe(true);

    // Scores ~0.46 — robustly inside the ambiguous band [0.4, 0.55), so this forks.
    const ambiguous = await core.store("The app uses SQLite for persistence.", { circle: "attic-fork" });
    expect(ambiguous.action).toBe("ambiguous");
    expect(ambiguous.conceptId).not.toBe(seedFork.conceptId);
    expect(ambiguous.landedInArchivedCircle).toBe(true);

    // AND THE CONTRACT IS UNTOUCHED: every one of them is stored, in the circle that was asked for.
    expect(core.circleOf(created.conceptId)).toBe("attic-new");
    expect(core.circleOf(attached.conceptId)).toBe("attic-attach");
    expect(core.circleOf(ambiguous.conceptId)).toBe("attic-fork");

    core.close();
  });

  /**
   * THE ALIASED DESTINATION. The caller names a circle that looks perfectly live — it has no
   * archived row of its own — and the rename alias lands the write in the attic anyway. Keying the
   * disclosure on the RESOLVED circle is what covers this; keying it on the caller's own string
   * would be silent on precisely the case where the caller cannot see the problem coming.
   */
  it("discloses when an ACTIVE alias resolves onto an archived circle", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    await core.store("Deployment runbook for the billing service.", { circle: "old-project" });
    core.renameCircle("old-project", "new-project");
    core.archiveCircle("new-project");

    const r = await core.store("Runbook step two for billing.", { circle: "old-project" });
    expect(core.circleOf(r.conceptId)).toBe("new-project");
    expect(r.landedInArchivedCircle).toBe(true);

    core.close();
  });

  /**
   * THE MIDDLE CASE, against a REAL second connection rather than by inspecting the code shape —
   * the same discipline gates.test.ts uses for reassignCircle's own archived-destination guard.
   * `storeInternal` resolves the circle, then awaits an embed and a segmentation pass before it
   * opens `BEGIN IMMEDIATE`, and one `.monet` file shared by the MCP server and a `monet` CLI call
   * is a supported topology (storage.ts) — so "the destination was live when we resolved it" is a
   * fact with a shelf life. Asking before the embed would reproduce #55's own silence through a
   * narrower window: the write lands in an archived circle and says nothing about it.
   */
  it("answers the archived question INSIDE the write reservation, against a second connection archiving mid-write", async () => {
    const dbPath = tmpDbPath();
    const a = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const b = new MonetCore(dbPath); // the competing writer: its own connection to the same file

    // Not archived when this one runs, which is the premise of the test.
    const before = await a.store("The billing service retries failed webhooks.", { circle: "shelf" });
    expect(before.landedInArchivedCircle).toBe(false);

    type Embedder = { checkedEmbed(text: string, domain: string): Promise<Float32Array> };
    const original = (Object.getPrototypeOf(a) as Embedder).checkedEmbed;
    let raced = false;
    const spy = vi.spyOn(a as unknown as Embedder, "checkedEmbed").mockImplementation(async (text: string, domain: string) => {
      const emb = await original.call(a as unknown as Embedder, text, domain);
      if (!raced) {
        raced = true;
        b.archiveCircle("shelf"); // a real commit, on a real second connection, mid-window
      }
      return emb;
    });

    const during = await a.store("Webhook retries use exponential backoff.", { circle: "shelf", resolution: "forceNew" });
    spy.mockRestore();

    // The archive necessarily happened after the resolution above and before the mutation, so only
    // a read taken under the reservation can be reporting it.
    expect(raced).toBe(true);
    expect(during.landedInArchivedCircle).toBe(true);
    expect(a.circleOf(during.conceptId)).toBe("shelf");

    a.close();
    b.close();
  });

  /**
   * THE REPLAY. `operationId` promises that a retry is indistinguishable from the original call, so
   * the disclosure has to survive one — a caller told "archived" on the first call and given silence
   * on the retry would have to guess which answer counts. Rebuilt from the concept's own circle
   * rather than stored a second time, the same way `resolutionMode` is.
   */
  it("keeps the disclosure on an idempotent retry, which returns the original receipt", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    core.archiveCircle("shelved");

    const first = await core.store("The invoice job runs on Sundays.", { circle: "shelved", operationId: "op-55" });
    expect(first.landedInArchivedCircle).toBe(true);

    const retry = await core.store("a completely different body", { circle: "shelved", operationId: "op-55" });
    expect(retry).toEqual(first);
    expect(retry.landedInArchivedCircle).toBe(true);

    core.close();
  });

  /**
   * THE VERDICT SURVIVES A LATER ARCHIVE — BOTH DIRECTIONS (Codex round 1 on #55, finding 1). The
   * first cut rebuilt this at replay time from `circle_aliases`, on the theory that `resolutionMode`
   * is rebuilt the same way. The analogy breaks on mutability: a resolution event is immutable once
   * written, so rebuilding it reproduces the original answer by construction, while archive state is
   * a flag anyone can flip afterwards — so the retry answered "is this circle archived NOW" while
   * the first call had answered "was it archived when the write landed". Measured before the fix:
   * false→true across an archiveCircle, true→false across an unarchiveCircle.
   */
  it("keeps the WRITE-TIME verdict on a retry, across a later archive and a later unarchive", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });

    // Written into a LIVE circle, archived afterwards: the retry must still say the destination was
    // live, because that is what this operation did.
    const live = await core.store("The invoice job runs on Sundays.", { circle: "proj", operationId: "op-A" });
    expect(live.landedInArchivedCircle).toBe(false);
    core.archiveCircle("proj");
    const retryAfterArchive = await core.store("a completely different body", { circle: "proj", operationId: "op-A" });
    expect(retryAfterArchive.landedInArchivedCircle).toBe(false);
    expect(retryAfterArchive).toEqual(live);

    // And the inverse, which is the direction that would have gone QUIET about a real disclosure.
    core.archiveCircle("shelf");
    const shelved = await core.store("Quarterly close checklist.", { circle: "shelf", operationId: "op-B" });
    expect(shelved.landedInArchivedCircle).toBe(true);
    core.unarchiveCircle("shelf");
    const retryAfterUnarchive = await core.store("something else entirely", { circle: "shelf", operationId: "op-B" });
    expect(retryAfterUnarchive.landedInArchivedCircle).toBe(true);
    expect(retryAfterUnarchive).toEqual(shelved);

    core.close();
  });

  /**
   * A RECEIPT FROM BEFORE THE COLUMN RECORDED NO VERDICT, and must say so by staying absent. `false`
   * would be the reassuring answer — "your write went somewhere recallable" — invented for a write
   * nobody asked the question about, which is the one direction this disclosure must never fail in.
   */
  it("reports no verdict at all — not `false` — replaying a receipt that predates the stored column", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    core.archiveCircle("shelf");
    const first = await core.store("Retention policy draft.", { circle: "shelf", operationId: "op-old" });
    expect(first.landedInArchivedCircle).toBe(true);

    // Exactly the row shape an older build would have left behind: every other receipt column
    // present, this one never written.
    const db = (core as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    db.prepare(`UPDATE ingest_operations SET landed_in_archived_circle = NULL WHERE operation_id = ?`).run("op-old");

    const replay = await core.store("anything at all", { circle: "shelf", operationId: "op-old" });
    expect(replay.conceptId).toBe(first.conceptId);
    expect(replay).not.toHaveProperty("landedInArchivedCircle");

    core.close();
  });

  /**
   * THE ACKNOWLEDGEMENT NAMES THE CIRCLE THE WRITE REACHED (Codex round 1 on #55, finding 2). The
   * envelope used to re-resolve the caller's own circle argument through LIVE alias state, so a
   * rename committed between the write's commit and the envelope's construction renamed the circle
   * out from under the sentence. It is sharpest here because renaming an archived circle also clears
   * its archived flag: the old code printed "ARCHIVED CIRCLE: 'proj-renamed' is archived" about a
   * circle that was, at that very moment, not archived at all — a frozen verdict wearing a live
   * name. The boolean and the name it speaks of have to come from one instant.
   */
  it("names the circle the write reached, not a rename committed while the write was in flight", async () => {
    const dbPath = tmpDbPath();
    const a = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const b = new MonetCore(dbPath); // the competing writer: its own connection to the same file
    await a.store("Deployment runbook for the billing service.", { circle: "proj" });
    a.archiveCircle("proj");

    type Storer = { store(content: string, opts: Record<string, unknown>): Promise<{ concept: { circle: string } }> };
    const original = (Object.getPrototypeOf(a) as Storer).store;
    let raced = false;
    const spy = vi.spyOn(a as unknown as Storer, "store").mockImplementation(async (content, opts) => {
      const result = await original.call(a as unknown as Storer, content, opts);
      if (!raced) {
        raced = true;
        b.renameCircle("proj", "proj-renamed"); // a real commit, after the write, before the envelope
      }
      return result;
    });

    const { client, cleanup } = await makeMcpPair(a);
    try {
      const ack = await storeOverMcp(client, { content: "Runbook step two for billing.", circle: "proj" });
      expect(raced).toBe(true);
      // Frozen: the write landed in 'proj'. `scope('proj')` would now answer 'proj-renamed'.
      expect(a.resolveCircleName("proj")).toBe("proj-renamed");
      expect(ack.circle).toBe("proj");
      expect(ack.guidance).toContain("'proj'");
      expect(ack.guidance).not.toContain("proj-renamed");
    } finally {
      spy.mockRestore();
      await cleanup();
      b.close();
    }
  });

  /**
   * THE WIRE. The engine flag exists to reach the storing agent on the turn it stores, so the
   * acknowledgement is where the fix is actually delivered — and it stays absent on the ordinary
   * write, because a key repeating "not archived" forever is payload with no reader.
   */
  it("memory_store's acknowledgement carries the archived-circle guidance, and stays silent for a live circle", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    core.archiveCircle("shelved");
    const { client, cleanup } = await makeMcpPair(core);
    try {
      const archived = await storeOverMcp(client, { content: "The nightly export runs at 02:00.", circle: "shelved" });
      expect(archived.conceptId).toBeDefined();
      expect(archived.circle).toBe("shelved");
      expect(archived.guidance).toContain("ARCHIVED CIRCLE");
      expect(archived.guidance).toContain("shelved");
      expect(archived.guidance).toContain("memory_circle_manage");

      const live = await storeOverMcp(client, { content: "The nightly export writes to S3.", circle: "current" });
      expect(live.conceptId).toBeDefined();
      expect(live).not.toHaveProperty("guidance");
    } finally {
      await cleanup();
    }
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
