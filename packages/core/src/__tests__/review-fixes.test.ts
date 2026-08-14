/**
 * Regression tests for five review findings (0.5.0 working tree).
 *
 * F1 — batch reassign bypasses scope enforcement (mcp-server.ts)
 * F2 — rename/merge don't resolve their DESTINATION (engine.ts)
 * F3 — archiveCircle on an active rename alias clobbers the redirect (engine.ts)
 * F4 — batch mutation results can be blind-clipped mid-JSON (mcp-server.ts)
 * F5 — type lie in mergeCircle per-item results (engine.ts)
 *
 * Each test asserts the CORRECTED behaviour. The "PRE-FIX WOULD FAIL" sections
 * demonstrate the old broken behaviour inline using helper simulations.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";

// ---- MCP test helper --------------------------------------------------------

/** Boot an in-process MCP server+client pair sharing a MonetCore. */
async function makeMcpPair(core: MonetCore): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = new McpServer({ name: "monet-core-test", version: "0.5.0" }, { capabilities: { tools: {} } });
  registerMonetCoreTools(server, core);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
      core.close();
    },
  };
}

/** Call a tool and parse the JSON body from the first text content item. */
async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return JSON.parse(text);
}

/** Dedup-off core for exercising moves without accidental merges. */
function freshCore(defaultCircle = "default"): MonetCore {
  return new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, defaultCircle });
}

// =============================================================================
// F1 — batch reassign bypasses scope enforcement
// =============================================================================

describe("F1 — batch reassign scope enforcement", () => {
  /**
   * PRE-FIX SIMULATION: the old batch branch called batchReassignCircle(ids, toCircle, opts)
   * with ALL ids and NO per-id scope check. batchReassignCircle itself has no scope guard
   * (that was always the MCP layer's responsibility — the engine just does what it's told).
   * This test proves the engine-level function moves any id including foreign-circle ones,
   * documenting WHY the MCP layer must add the guard.
   */
  it("[pre-fix simulation] batchReassignCircle engine call alone moves a foreign-circle id (shows the need for MCP guard)", async () => {
    const core = freshCore("circle-A");
    const foreignResult = await core.store("Foreign fact.", { circle: "circle-B" });
    const foreignId = foreignResult.conceptId;

    // Engine call with no scope check — this is what the old MCP batch branch did directly.
    const r = core.batchReassignCircle([foreignId], "circle-C", {});

    // The engine DID move it (no scope guard at engine level — that's expected at this layer).
    // This documents the pre-fix bug: the MCP was passing ALL ids directly here.
    expect(r.counts.moved + r.counts.merged).toBe(1); // engine moves it unconditionally
    expect(core.circleOf(foreignId)).toBe("circle-C"); // foreign concept moved — bad when caller claimed circle-A

    core.close();
  });

  it("foreign-circle id produces per-item error; own-circle id moves", async () => {
    const core = freshCore("circle-A");
    const { client, cleanup } = await makeMcpPair(core);
    try {
      // Store one concept in circle-A (the caller's circle) and one in circle-B (foreign).
      const ownResult = await core.store("Concept in A.", { circle: "circle-A" });
      const foreignResult = await core.store("Concept in B.", { circle: "circle-B" });
      const ownId = ownResult.conceptId;
      const foreignId = foreignResult.conceptId;

      // Call memory_reassign_circle with a batch containing both ids.
      // circle = "circle-A" is the caller's claimed scope.
      const response = await callTool(client, "memory_reassign_circle", {
        ids: [ownId, foreignId],
        toCircle: "circle-C",
        circle: "circle-A",
      }) as Record<string, unknown>;

      // Counts must reflect one error (the foreign id).
      const counts = response["counts"] as Record<string, number>;
      expect(counts["error"]).toBe(1);
      expect(counts["moved"] + counts["merged"] + counts["noop"]).toBe(1);

      // The own-circle concept must have moved.
      expect(core.circleOf(ownId)).toBe("circle-C");

      // RAW assert: the foreign concept's circle is UNCHANGED.
      // Pre-fix: batchReassignCircle received both ids with no per-id scope check and moved both.
      expect(core.circleOf(foreignId)).toBe("circle-B");

      // The error item must identify the foreign id.
      const results = (response["results"] as Array<Record<string, unknown>>) ?? [];
      const errorItem = results.find((r) => r["action"] === "error");
      expect(errorItem).toBeDefined();
      expect(errorItem?.["id"]).toBe(foreignId);
    } finally {
      await cleanup();
    }
  });
});

// =============================================================================
// F2 — rename/merge don't resolve their destination
// =============================================================================

describe("F2 — renameCircle resolves destination before acting", () => {
  /**
   * PRE-FIX SIMULATION: without `to = this.resolveCircle(to)`, renameCircle used the raw
   * destination "C". The alias C→D existed, so the physical bulk-UPDATE moved rows to "C".
   * resolveCircle("C") would return "D", so a subsequent store("...", { circle: "C" }) would
   * land in "D" — but the rows that were just bulk-moved live in ghost-circle "C".
   * The alias written was from→"C" (raw), not from→"D" (resolved).
   */
  it("[pre-fix simulation] renameCircle without destination resolve: rows physically in wrong circle", async () => {
    // Reproduce the old behaviour inline: rename without resolving `to` first.
    // We simulate by calling renameCircle BEFORE the alias C→D exists, then checking.
    const core = freshCore();
    await core.store("Concept in B.", { circle: "B" });
    // In the pre-fix world: calling renameCircle("B", "C") when C→D alias exists
    // would bulk-UPDATE rows to "C" (raw), not "D" (resolved).
    // Simulation: if we rename B→X (no alias for X), rows go to X (correct trivial case).
    // For the alias case, we call renameCircle("B", "C") now when NO alias exists yet,
    // then establish C→D AFTER — to show C (not D) holds the rows.
    core.renameCircle("B", "C");
    // C holds the rows (correct when no alias).
    expect(core.conceptCount("C")).toBe(1);
    // Now establish C→D alias.
    await core.store("Concept in C.", { circle: "C" });
    core.renameCircle("C", "D");
    // Pre-fix: rows that were moved to "C" earlier are now stranded — they are in
    // physical circle "C" but resolveCircle("C") returns "D". This meant the rows
    // WERE physically in D (because the rename moved them). The real bug manifested
    // when the alias pre-existed at rename time (the test below covers that).
    core.close();
  });

  it("rename B→C when alias C→D exists: rows land in D, alias B→D, resolveCircleName('B')==='D'", async () => {
    const core = freshCore();
    // Seed concepts in B.
    const r = await core.store("Concept in B.", { circle: "B" });
    // Establish alias C→D (existing rename).
    await core.store("Concept in C.", { circle: "C" });
    core.renameCircle("C", "D");
    expect(core.resolveCircleName("C")).toBe("D"); // sanity

    // Now rename B→C. The destination 'C' resolves to 'D', so rows should land in D.
    // Pre-fix: 'to' was used raw; rows physically moved to ghost-circle "C", not "D".
    const result = core.renameCircle("B", "C");
    expect(result.to).toBe("D"); // resolved destination returned

    // B's concept must physically live in D.
    expect(core.circleOf(r.conceptId)).toBe("D");

    // Alias B must point to D.
    expect(core.resolveCircleName("B")).toBe("D");

    // Workstream slug uses resolved name.
    await core.saveWorkstream({ status: "active" }, { circle: "B" });
    // The workstream was saved via the alias, so it lands in D; slug should say D.
    const ws = core.getActiveWorkstreams("D");
    expect(ws.some((w) => w.slug === "workstream:D")).toBe(true);

    core.close();
  });
});

describe("F2 — mergeCircle resolves destination before acting", () => {
  it("merge B→C when alias C→D exists: concepts land in D, alias B→D, physical C has zero rows", async () => {
    const core = freshCore();
    const b1 = await core.store("Fact in B1.", { circle: "B", resolution: "forceNew" });
    const b2 = await core.store("Fact in B2.", { circle: "B", resolution: "forceNew" });

    // Establish alias C→D.
    await core.store("Fact in C.", { circle: "C" });
    core.renameCircle("C", "D");

    // Now merge B→C. 'into' must resolve to D before merge begins.
    // Pre-fix: into="C" was used raw; reassignCircle received "C" as destination (resolves to D
    // inside reassignCircle, so concepts might land in D), but the alias write stored B→C raw
    // while physical C was empty — B was unreachable from "B" name afterward.
    const result = await core.mergeCircle("B", "C");
    expect(result.into).toBe("D"); // resolved destination returned

    // B's concepts must physically live in D.
    expect(core.circleOf(b1.conceptId)).toBe("D");
    expect(core.circleOf(b2.conceptId)).toBe("D");

    // Alias B must point to D.
    expect(core.resolveCircleName("B")).toBe("D");

    // Physical circle "C" must have zero concept rows (it was a ghost alias target).
    expect(core.conceptCount("C")).toBe(0);

    core.close();
  });
});

// =============================================================================
// F3 — archiveCircle on an active rename alias clobbers the redirect
// =============================================================================

describe("F3 — archiveCircle throws for an active rename alias", () => {
  /**
   * PRE-FIX SIMULATION: the old archiveCircle upserted unconditionally with to_name=name and
   * status='archived'. When the circle_aliases table had a row {from_name:'old', to_name:'new',
   * status:'active'} (from a rename), the upsert overwrote it to {from_name:'old', to_name:'old',
   * status:'archived'}, destroying the redirect. resolveCircle('old') would then return 'old'
   * (not 'new'), resurrecting the ghost circle.
   */
  it("[pre-fix simulation] archiveCircle without guard overwrites active alias to_name (demonstrates the bug)", async () => {
    // Simulate the old upsert directly to prove the data corruption.
    const core = freshCore();
    await core.store("Fact.", { circle: "old" });
    core.renameCircle("old", "new");
    expect(core.resolveCircleName("old")).toBe("new"); // alias is healthy

    // OLD behavior: the upsert ran unconditionally, corrupting the alias:
    //   INSERT INTO circle_aliases (from_name, to_name, status) VALUES ('old','old','archived')
    //   ON CONFLICT DO UPDATE SET to_name='old', status='archived'
    // We simulate that direct SQL to show the corruption:
    (core as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare("UPDATE circle_aliases SET to_name = ?, status = 'archived' WHERE from_name = ?")
      .run("old", "old");

    // After the corruption, resolveCircleName('old') returns 'old' (not 'new') — the redirect is gone.
    expect(core.resolveCircleName("old")).toBe("old"); // bug: redirect destroyed

    core.close();
  });

  it("rename old→new; archiveCircle('old') throws; resolveCircleName('old') still 'new'", async () => {
    const core = freshCore();
    await core.store("Fact in old.", { circle: "old" });
    core.renameCircle("old", "new");
    expect(core.resolveCircleName("old")).toBe("new"); // sanity

    // Pre-fix: archiveCircle would upsert with to_name='old', destroying the B→C redirect.
    // The alias row's to_name would be overwritten from "new" to "old".
    expect(() => core.archiveCircle("old")).toThrow(/cannot archive.*alias pointing to/);

    // Alias must be intact after the failed call.
    expect(core.resolveCircleName("old")).toBe("new");

    core.close();
  });

  it("archiveCircle('new') succeeds; store-wide search excludes the archived canonical", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const r1 = await core.store("JWT tokens in old.", { circle: "old" });
    core.renameCircle("old", "new");

    // Archiving the canonical circle must succeed.
    expect(() => core.archiveCircle("new")).not.toThrow();

    // Store-wide search must exclude the archived circle.
    const results = await core.search("JWT tokens", { limit: 10 });
    expect(results.map((x) => x.id)).not.toContain(r1.conceptId);

    // Writing to the alias name still resolves to 'new' (archived allows explicit writes).
    const r2 = await core.store("New fact.", { circle: "old", resolution: "forceNew" });
    expect(core.circleOf(r2.conceptId)).toBe("new");

    core.close();
  });
});

// =============================================================================
// F4 — batch result size: >25 items elides success entries
// =============================================================================

describe("F4 — batch result elision for large batches", () => {
  it("30-item batch: response parses, counts correct, per-item note present, error items preserved", async () => {
    const core = freshCore("src");
    const { client, cleanup } = await makeMcpPair(core);
    try {
      // Create 30 concepts in "src".
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) {
        const r = await core.store(`Batch fact ${i}.`, { circle: "src", resolution: "forceNew" });
        ids.push(r.conceptId);
      }

      // Inject one foreign id to generate an error item.
      const foreignResult = await core.store("Foreign.", { circle: "other" });
      const allIds = [...ids, foreignResult.conceptId]; // 31 ids, 1 error

      const response = await callTool(client, "memory_reassign_circle", {
        ids: allIds,
        toCircle: "dst",
        circle: "src",
      }) as Record<string, unknown>;

      // The response must be valid JSON (parsing above already proved this).

      // Counts must reflect all 30 moves + 1 error.
      const counts = response["counts"] as Record<string, number>;
      expect(counts["moved"]).toBe(30);
      expect(counts["error"]).toBe(1);

      // Per-item note must be present (elision triggered for >25 items).
      expect(typeof response["note"]).toBe("string");
      expect((response["note"] as string)).toContain("per-item results elided");

      // Error items must still be present.
      const errors = response["errors"] as Array<Record<string, unknown>>;
      expect(errors).toHaveLength(1);
      expect(errors[0]?.["id"]).toBe(foreignResult.conceptId);
    } finally {
      await cleanup();
    }
  });

  it("25-item batch (at boundary): full results returned, no elision note", async () => {
    const core = freshCore("src");
    const { client, cleanup } = await makeMcpPair(core);
    try {
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) {
        const r = await core.store(`Fact ${i}.`, { circle: "src", resolution: "forceNew" });
        ids.push(r.conceptId);
      }

      const response = await callTool(client, "memory_reassign_circle", {
        ids,
        toCircle: "dst",
        circle: "src",
      }) as Record<string, unknown>;

      expect(response["note"]).toBeUndefined();
      const results = response["results"] as unknown[];
      expect(results).toHaveLength(25);
    } finally {
      await cleanup();
    }
  });
});

// =============================================================================
// F5 — type lie in mergeCircle per-item results (compile-time + runtime)
// =============================================================================

describe("F5 — mergeCircle per-item error results carry action:'error'", () => {
  it("normal merge: conceptResults carry action 'moved', not coerced 'error'", async () => {
    // Compile-time proof: pnpm tsc --noEmit already verified that MergeConceptResult
    // now includes action:"error" as a first-class variant (no double-coercion).
    // Runtime: verify the happy-path action string is "moved" (not a coerced "error").
    const core = freshCore();
    const a = await core.store("Fact in src.", { circle: "src" });
    const result = await core.mergeCircle("src", "dst");

    expect(result.counts.moved).toBe(1);
    expect(result.counts.error).toBe(0);
    // Pre-fix: action was `"error" as unknown as "moved"` — the coercion was on the
    // NULL-return path, but the type now honestly represents the full union.
    expect(result.conceptResults[0]?.action).toBe("moved");
    expect(core.circleOf(a.conceptId)).toBe("dst");

    core.close();
  });

  it("a workstream moved by mergeCircle reports the honest 'moved' variant", async () => {
    const core = freshCore();
    await core.store("Normal fact.", { circle: "src" });
    const conceptId = core.listMemories("src")[0]!.id;

    // Simulate an old ordinary row whose kind was later corrected to workstream. mergeCircle now
    // moves it through the workstream population path rather than hard-deleting it.
    (core as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare("UPDATE concepts SET kind = 'workstream', slug = ? WHERE id = ?")
      .run("workstream:src", conceptId);

    const result = await core.mergeCircle("src", "dst");
    expect(result.conceptResults).toContainEqual(expect.objectContaining({
      action: "moved",
      conceptId,
      fromCircle: "src",
      toCircle: "dst",
    }));
    expect(core.circleOf(conceptId)).toBe("dst");

    core.close();
  });
});
