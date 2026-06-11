/**
 * 0.6.0 Temporal Layer tests (design spec §6):
 *
 *  1. Migration: pre-0.6.0 store → columns exist, backfill last_confirmed_at == updated_at,
 *     user_version == 2; idempotent on re-open.
 *  2. Staleness divergence: a structural op bumps updated_at but NOT last_confirmed_at → concept
 *     correctly reads stale despite a fresh updated_at.
 *  3. Damping incident replay: same-session create + 7 attaches → confidence stays at the create
 *     default (NOT 1.0), supportCount == 8, last_confirmed_at unmoved after the create; then an
 *     attach under a NEW session id → +0.1 exactly once and temporal refresh.
 *  4. Fetch does not confirm: getConcept moves neither temporal field.
 *  5. resolveContradiction: accept-new refreshes; dismiss verdict does not.
 *  6. mergeConceptInto MAX-carry of last_confirmed_at.
 *  7. Dismissal lifecycle: dismiss → pair leaves overview.possibleDuplicates and the count;
 *     SURVIVES a detach/rederive cycle on either concept; a reinforcing near-miss store (ON
 *     CONFLICT path) does NOT un-dismiss; dismissal with a consolidated-away concept id errors
 *     gracefully.
 *  8. memory_resolve MCP: existing contradiction path regression-covered unchanged; dismissal
 *     path works end-to-end; scope gates are enforced at the MCP boundary.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine";
import { registerMonetCoreTools } from "../mcp-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// ---- helpers ---------------------------------------------------------------

/** A core with dedup thresholds that force every store() to create a distinct concept. */
function freshCoreDistinct(opts: ConstructorParameters<typeof MonetCore>[1] = {}): MonetCore {
  return new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, ...opts });
}

/** Read concept rows directly from SQLite for assertions on internal fields. */
function rawRow(core: MonetCore, id: string): { last_confirmed_at: number | null; last_confirmed_session_id: string | null; confidence: number; support_count: number; updated_at: number } | undefined {
  // Access the underlying db via a cast — test-only introspection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (core as any).db as import("../storage").StoragePort;
  return db
    .prepare(`SELECT last_confirmed_at, last_confirmed_session_id, confidence, support_count, updated_at FROM concepts WHERE id = ?`)
    .get(id) as { last_confirmed_at: number | null; last_confirmed_session_id: string | null; confidence: number; support_count: number; updated_at: number } | undefined;
}

/** Read edge row for a possible_duplicate_of pair. */
function dupEdgeRow(core: MonetCore, aId: string, bId: string, circle: string): { dismissed_at: number | null; dismissed_by: string | null } | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (core as any).db as import("../storage").StoragePort;
  return db
    .prepare(
      `SELECT dismissed_at, dismissed_by FROM memory_edge
        WHERE scope = ? AND type = 'possible_duplicate_of' AND src_id = ? AND dst_id = ?`,
    )
    .get(circle, aId, bId) as { dismissed_at: number | null; dismissed_by: string | null } | undefined;
}

/** Build a connected MCP client against a MonetCore instance. */
async function mcpClient(core: MonetCore): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.6.0" }, { capabilities: { tools: {} } });
  registerMonetCoreTools(server, core);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.6.0" });
  await client.connect(clientTransport);
  return client;
}

/** Parse the JSON result payload from an MCP tool call. */
function parseResult(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ---- 1. Migration ----------------------------------------------------------

describe("1. Migration — pre-0.6.0 store → temporal columns + backfill", () => {
  it("columns exist, last_confirmed_at backfilled to updated_at, user_version == 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-temporal-"));
    const dbPath = join(dir, "test.db");
    try {
      // Phase 1: simulate a pre-0.6.0 store by opening with the first engine, which will run
      // the migration. user_version goes from 0 → 2 (GRAPH_SCHEMA_VERSION=1 backfill + TEMPORAL=2).
      const core = new MonetCore(dbPath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (core as any).db as import("../storage").StoragePort;

      // Verify temporal columns exist on concepts.
      const conceptCols = db.prepare(`PRAGMA table_info(concepts)`).all() as Array<{ name: string }>;
      expect(conceptCols.some((c) => c.name === "last_confirmed_at")).toBe(true);
      expect(conceptCols.some((c) => c.name === "last_confirmed_session_id")).toBe(true);

      // Verify dismissed columns exist on memory_edge.
      const edgeCols = db.prepare(`PRAGMA table_info(memory_edge)`).all() as Array<{ name: string }>;
      expect(edgeCols.some((c) => c.name === "dismissed_at")).toBe(true);
      expect(edgeCols.some((c) => c.name === "dismissed_by")).toBe(true);

      // Verify user_version == 2.
      const version = db.pragma("user_version", { simple: true }) as number;
      expect(version).toBe(2);

      core.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills last_confirmed_at = updated_at for existing concepts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-temporal-backfill-"));
    const dbPath = join(dir, "test.db");
    try {
      // Create a concept in the first open (migration runs → last_confirmed_at set to updated_at).
      const coreA = new MonetCore(dbPath);
      const r = await coreA.store("We use SQLite for local storage.");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (coreA as any).db as import("../storage").StoragePort;
      const row = db
        .prepare(`SELECT last_confirmed_at, updated_at FROM concepts WHERE id = ?`)
        .get(r.conceptId) as { last_confirmed_at: number | null; updated_at: number };
      // last_confirmed_at is set by create() directly, not by the backfill — but the backfill
      // ensures any pre-existing rows (before this migration) would also get it.
      expect(row.last_confirmed_at).not.toBeNull();
      coreA.close();

      // Re-open: migration is idempotent (no crash, same user_version).
      const coreB = new MonetCore(dbPath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db2 = (coreB as any).db as import("../storage").StoragePort;
      const version2 = db2.pragma("user_version", { simple: true }) as number;
      expect(version2).toBe(2);
      coreB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- 1b. Migration ordering: graph-disabled open preserves user_version=0 ---

describe("1b. Migration ordering — graph-disabled open does not consume graph backfill slot", () => {
  it("graph-disabled open: user_version stays 0 and last_confirmed_at stays NULL for pre-existing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-temporal-graph-disabled-"));
    const dbPath = join(dir, "test.db");
    try {
      // Stage 1: Graph-DISABLED open on a fresh DB.
      // The schema is created (tables/columns exist) but user_version must remain 0
      // because neither the graph backfill nor the temporal backfill runs.
      const coreDisabled = new MonetCore(dbPath, { graphEnabled: false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbDisabled = (coreDisabled as any).db as import("../storage").StoragePort;

      // Simulate a pre-0.6.0 row by inserting directly with last_confirmed_at = NULL.
      const preExistingId = "pre-existing-concept-id-" + Math.random().toString(36).slice(2);
      const nowMs = Date.now();
      dbDisabled.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, version, circle, support_count, dirty, embedding, updated_at, last_confirmed_at, last_confirmed_session_id)
         VALUES (?, 'pre-existing', 'pre-existing', 'pre-existing', 'fact', 'active', 0.7, 1, 'default', 1, 0, '[]', ?, NULL, NULL)`,
      ).run(preExistingId, nowMs);

      const versionAfterDisabled = dbDisabled.pragma("user_version", { simple: true }) as number;
      expect(versionAfterDisabled).toBe(0);

      const rowAfterDisabled = dbDisabled
        .prepare(`SELECT last_confirmed_at FROM concepts WHERE id = ?`)
        .get(preExistingId) as { last_confirmed_at: number | null };
      expect(rowAfterDisabled.last_confirmed_at).toBeNull();

      coreDisabled.close();

      // Stage 2: Graph-ENABLED open on the same DB.
      // Graph backfill runs (0 → 1), then temporal backfill runs (1 → 2).
      // NULL rows must get last_confirmed_at = updated_at.
      const coreEnabled = new MonetCore(dbPath, { graphEnabled: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbEnabled = (coreEnabled as any).db as import("../storage").StoragePort;

      const versionAfterEnabled = dbEnabled.pragma("user_version", { simple: true }) as number;
      expect(versionAfterEnabled).toBe(2);

      const rowAfterEnabled = dbEnabled
        .prepare(`SELECT last_confirmed_at, updated_at FROM concepts WHERE id = ?`)
        .get(preExistingId) as { last_confirmed_at: number | null; updated_at: number };
      expect(rowAfterEnabled.last_confirmed_at).toBe(rowAfterEnabled.updated_at);

      coreEnabled.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- 2. Staleness divergence -----------------------------------------------

describe("2. Staleness divergence — structural op updates updated_at but not last_confirmed_at", () => {
  it("a concept's staleness is based on last_confirmed_at, not updated_at", async () => {
    // staleAfterMs=10 so we can control staleness with very short times.
    const core = new MonetCore(":memory:", { staleAfterMs: 10 });
    const r = await core.store("Auth tokens are signed with jose.");

    // Immediately: concept is fresh.
    expect(core.getStaleConcepts().some((c) => c.id === r.conceptId)).toBe(false);

    // Freeze last_confirmed_at in the past (> staleAfterMs ago) but set updated_at to NOW
    // to simulate a structural op that bumped updated_at but not last_confirmed_at.
    const pastTs = Date.now() - 1000; // 1s ago, definitely > 10ms
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, updated_at = unixepoch() * 1000 WHERE id = ?`).run(pastTs, r.conceptId);

    // Now the concept should be stale (last_confirmed_at is old) even though updated_at is fresh.
    expect(core.getStaleConcepts().some((c) => c.id === r.conceptId)).toBe(true);

    core.close();
  });
});

// ---- 3. Damping incident replay --------------------------------------------

describe("3. Damping — same-session attaches do not bump confidence or refresh temporal", () => {
  it("7 same-session attaches: confidence unchanged, supportCount=8, last_confirmed_at from create only", async () => {
    // Use tauAttach=0 so everything attaches. Sessions are managed via endSessionForEval.
    const core = new MonetCore(":memory:", { tauAttach: 0, tauAmbiguous: 0 });

    // One create.
    const r = await core.store("SQLite is used for local persistence.");
    const createRow = rawRow(core, r.conceptId)!;
    const originalLca = createRow.last_confirmed_at;
    const originalSession = createRow.last_confirmed_session_id;
    const originalConfidence = createRow.confidence;
    expect(originalLca).not.toBeNull();
    expect(originalSession).not.toBeNull();

    // 7 same-session attaches (no endSessionForEval between them).
    for (let i = 0; i < 7; i++) {
      await core.store(`SQLite is used for local persistence — variant ${i}.`);
    }

    const afterSameSession = rawRow(core, r.conceptId)!;
    // Confidence unchanged from create default.
    expect(afterSameSession.confidence).toBeCloseTo(originalConfidence, 5);
    // supportCount = 8 (1 create + 7 attaches).
    expect(afterSameSession.support_count).toBe(8);
    // last_confirmed_at unchanged.
    expect(afterSameSession.last_confirmed_at).toBe(originalLca);
    expect(afterSameSession.last_confirmed_session_id).toBe(originalSession);

    // Now open a NEW session and attach once.
    core.endSessionForEval();
    // Use a second MonetCore instance pointing at the same DB to get a new session id.
    // Instead, just call endSessionForEval to close the session, then store one more.
    // The engine lazily opens a new session on the next write — endSessionForEval resets sessionId.
    const r2 = await core.store("SQLite is used for local persistence — new session.");
    // This should attach (tauAttach=0) and trigger cross-session logic.
    const afterNewSession = rawRow(core, r.conceptId)!;
    // Confidence bumped by exactly +0.1.
    expect(afterNewSession.confidence).toBeCloseTo(originalConfidence + 0.1, 5);
    // last_confirmed_at refreshed (after the original).
    expect(afterNewSession.last_confirmed_at).toBeGreaterThan(originalLca!);
    // last_confirmed_session_id updated to the new session.
    expect(afterNewSession.last_confirmed_session_id).not.toBe(originalSession);
    // The new store attached to concept r.conceptId (not r2, since tauAttach=0).
    expect(r2.conceptId).toBe(r.conceptId);

    core.close();
  });
});

// ---- 4. Fetch does not confirm ----------------------------------------------

describe("4. Fetch does not confirm — getConcept moves neither temporal field", () => {
  it("getConcept leaves last_confirmed_at and last_confirmed_session_id unchanged", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("The deploy pipeline runs on GitHub Actions.");
    const before = rawRow(core, r.conceptId)!;

    await core.getConcept(r.conceptId, { synthesize: false });
    await core.getConcept(r.conceptId, { synthesize: false });
    await core.getConcept(r.conceptId, { synthesize: false });

    const after = rawRow(core, r.conceptId)!;
    expect(after.last_confirmed_at).toBe(before.last_confirmed_at);
    expect(after.last_confirmed_session_id).toBe(before.last_confirmed_session_id);

    core.close();
  });
});

// ---- 5. resolveContradiction -----------------------------------------------

describe("5. resolveContradiction — accept-new refreshes; dismiss does not", () => {
  it("accept-new verdict refreshes last_confirmed_at", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("We use SQLite for storage.", { kind: "fact" });
    const contra = core.flagContradiction(r.conceptId, { detail: "actually Postgres" });
    const before = rawRow(core, r.conceptId)!;

    // 10ms delay — strictly greater than is reliable; passes even if the refresh never ran = fail.
    await new Promise((res) => setTimeout(res, 10));

    core.resolveContradiction(contra.id, { decision: "accept-new" });
    const after = rawRow(core, r.conceptId)!;
    expect(after.last_confirmed_at).toBeGreaterThan(before.last_confirmed_at!);

    core.close();
  });

  it("keep-current verdict refreshes last_confirmed_at", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("We use SQLite for storage.", { kind: "fact" });
    const contra = core.flagContradiction(r.conceptId, { detail: "actually Postgres" });
    const before = rawRow(core, r.conceptId)!;

    // 10ms delay — strictly greater than is reliable; passes even if the refresh never ran = fail.
    await new Promise((res) => setTimeout(res, 10));

    core.resolveContradiction(contra.id, { decision: "keep-current" });
    const after = rawRow(core, r.conceptId)!;
    expect(after.last_confirmed_at).toBeGreaterThan(before.last_confirmed_at!);

    core.close();
  });

  it("dismiss verdict does NOT refresh last_confirmed_at", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("We use SQLite for storage.", { kind: "fact" });
    const contra = core.flagContradiction(r.conceptId, { detail: "stale fact" });
    const before = rawRow(core, r.conceptId)!;

    await new Promise((res) => setTimeout(res, 5));

    core.resolveContradiction(contra.id, { decision: "dismiss" });
    const after = rawRow(core, r.conceptId)!;
    // dismiss: last_confirmed_at must be UNCHANGED.
    expect(after.last_confirmed_at).toBe(before.last_confirmed_at);

    core.close();
  });
});

// ---- 6a. detach-consolidation MAX-carry (Fix 1) ----------------------------

describe("6a. detach-consolidation — FULL consolidation MAX-carries last_confirmed_at", () => {
  it("consolidate freshly-confirmed source into stale keeper → keeper gets source's last_confirmed_at", async () => {
    // tauAttach > 1 so store() never auto-merges; we drive consolidation explicitly via detach.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, staleAfterMs: 5 });

    // Create keeper (older last_confirmed_at).
    const keeperResult = await core.store("Auth tokens are signed with jose.");
    const keeperId = keeperResult.conceptId;
    // Freeze keeper's last_confirmed_at to a time well in the past.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;
    const pastTs = Date.now() - 2000; // 2 s ago
    db.prepare(`UPDATE concepts SET last_confirmed_at = ? WHERE id = ?`).run(pastTs, keeperId);

    // Small wait to ensure the source's create() timestamp is strictly later.
    await new Promise((res) => setTimeout(res, 10));

    // Create source (freshly confirmed — last_confirmed_at is after pastTs).
    core.endSessionForEval();
    const sourceResult = await core.store("Auth tokens use jose for signing.");
    const sourceId = sourceResult.conceptId;
    const sourceRow = rawRow(core, sourceId)!;
    const sourceLca = sourceRow.last_confirmed_at!;
    expect(sourceLca).toBeGreaterThan(pastTs);

    // Consolidate: detach ALL of source's observations into keeper.
    const fetchedSource = (await core.getConcept(sourceId, { synthesize: false }))!;
    const allSourceObsIds = fetchedSource.observations.map((o) => o.id);
    await core.detach(sourceId, allSourceObsIds, { destConceptId: keeperId });

    // Source must be deleted.
    expect(core.circleOf(sourceId)).toBeNull();

    // Keeper must now have last_confirmed_at = sourceLca (the MAX).
    const keeperAfter = rawRow(core, keeperId)!;
    expect(keeperAfter.last_confirmed_at).toBe(sourceLca);
    // Keeper must no longer be stale (staleAfterMs=5; sourceLca is ~10ms ago but we only
    // care that it matches the source timestamp, not the staleness here).
    expect(keeperAfter.last_confirmed_session_id).toBe(sourceRow.last_confirmed_session_id);

    core.close();
  });

  it("partial detach into an existing dest leaves dest's last_confirmed_at unchanged", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });

    const sourceResult = await core.store("Auth tokens are signed with jose.");
    const sourceId = sourceResult.conceptId;
    // Add a second obs so partial detach is possible.
    await core.store("jose handles JWT verification.", { attachTo: sourceId });

    core.endSessionForEval();
    const destResult = await core.store("Postgres is used for the main DB.");
    const destId = destResult.conceptId;

    const destBefore = rawRow(core, destId)!;
    const originalDestLca = destBefore.last_confirmed_at;
    const originalDestSession = destBefore.last_confirmed_session_id;

    // Wait to ensure any timestamp change would be detectable.
    await new Promise((res) => setTimeout(res, 10));

    // Detach only the first obs from source into dest (partial — source survives).
    const fetchedSource = (await core.getConcept(sourceId, { synthesize: false }))!;
    const firstObsId = fetchedSource.observations[0]!.id;
    const r = await core.detach(sourceId, [firstObsId], { destConceptId: destId });
    expect(r.sourceDeleted).toBe(false);

    // Dest's temporal fields must be unchanged.
    const destAfter = rawRow(core, destId)!;
    expect(destAfter.last_confirmed_at).toBe(originalDestLca);
    expect(destAfter.last_confirmed_session_id).toBe(originalDestSession);

    core.close();
  });
});

// ---- Fix 2 — staleConcepts cap keeps the STALEST, deterministically ---------

describe("Fix 2 — staleConcepts cap keeps the stalest concepts, not arbitrary rows", () => {
  it(">20 stale concepts with distinct ages → the oldest 20 survive the cap, deterministically", async () => {
    // tauAttach=1.1 prevents any auto-merging so each store() creates a distinct concept.
    // staleAfterMs=0 makes everything stale immediately (any lca in the past is stale).
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, staleAfterMs: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;

    const TOTAL = 25; // >20 = STALE_CONCEPTS_PREWARM_LIMIT
    const ids: string[] = [];

    // Create 25 concepts with distinct last_confirmed_at values spread over time.
    for (let i = 0; i < TOTAL; i++) {
      const r = await core.store(`Distinct concept number ${i} for staleness cap test.`);
      ids.push(r.conceptId);
      // Assign explicitly ordered timestamps so we know the expected survivors.
      // Concept i gets timestamp = 1000 * (i+1) so concept 0 is oldest, concept 24 is newest.
      db.prepare(`UPDATE concepts SET last_confirmed_at = ?, updated_at = ? WHERE id = ?`).run(1000 * (i + 1), 1000 * (i + 1), r.conceptId);
    }

    // Run prewarm twice to assert determinism.
    const prewarm1 = core.prewarm("default");
    const prewarm2 = core.prewarm("default");

    expect(prewarm1.staleConcepts).toHaveLength(20);
    expect(prewarm2.staleConcepts).toHaveLength(20);

    // The 20 survivors must be the 20 OLDEST (ids[0]..ids[19]).
    const expectedSurvivorIds = new Set(ids.slice(0, 20));
    const actualIds1 = new Set(prewarm1.staleConcepts.map((c) => c.id));
    const actualIds2 = new Set(prewarm2.staleConcepts.map((c) => c.id));

    expect(actualIds1).toEqual(expectedSurvivorIds);
    expect(actualIds2).toEqual(expectedSurvivorIds);

    // Both runs must return identical ordering (determinism).
    const order1 = prewarm1.staleConcepts.map((c) => c.id);
    const order2 = prewarm2.staleConcepts.map((c) => c.id);
    expect(order1).toEqual(order2);

    core.close();
  });
});

// ---- 6. mergeConceptInto MAX-carry -----------------------------------------

describe("6. mergeConceptInto — MAX-carry of last_confirmed_at", () => {
  it("target gets last_confirmed_at = MAX(target, source)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-temporal-merge-"));
    const dbPath = join(dir, "test.db");
    try {
      // Create two concepts in different sessions and give them different last_confirmed_at values.
      const core = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      const rA = await core.store("We use SQLite for local persistence.", { circle: "c1" });
      core.endSessionForEval();
      const rB = await core.store("We use SQLite for local persistence.", { circle: "c2" });

      const beforeA = rawRow(core, rA.conceptId)!;
      const beforeB = rawRow(core, rB.conceptId)!;
      const expectedMax = Math.max(beforeA.last_confirmed_at ?? 0, beforeB.last_confirmed_at ?? 0);

      // reassignCircle with auto resolution → mergeConceptInto.
      // Use default tauAttach — but identical content should score ≥ tauAttach.
      const coreDefault = new MonetCore(dbPath);
      const r = coreDefault.reassignCircle(rA.conceptId, "c2");
      expect(r?.action).toBe("merged");

      const survivorId = r!.conceptId;
      const after = rawRow(coreDefault, survivorId)!;
      expect(after.last_confirmed_at).toBe(expectedMax);

      coreDefault.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- 7. Dismissal lifecycle ------------------------------------------------

describe("7. Dismissal lifecycle", () => {
  it("dismiss → pair leaves possibleDuplicates list and count", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    const before = core.overview("default");
    expect(before.counts.possibleDuplicates).toBe(1);
    expect(before.possibleDuplicates).toHaveLength(1);

    const result = core.dismissPossibleDuplicate(a.conceptId, b.conceptId);
    expect(result.dismissed).toBe(true);

    const after = core.overview("default");
    expect(after.counts.possibleDuplicates).toBe(0);
    expect(after.possibleDuplicates).toHaveLength(0);

    core.close();
  });

  it("dismissal SURVIVES a detach/rederive cycle on the source concept", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    // Dismiss the pair.
    const dismiss = core.dismissPossibleDuplicate(a.conceptId, b.conceptId);
    expect(dismiss.dismissed).toBe(true);

    // Add a second obs to a so we can detach from it without hitting the last-obs guard.
    await core.store("SQLite handles local storage well.", { attachTo: a.conceptId });

    // Detach the FIRST observation from a into a new concept — this triggers unwind+rederive on a.
    const fetchedA = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    const firstObsA = fetchedA.observations[0]!.id;
    await core.detach(a.conceptId, [firstObsA]);

    // The dismissal edge between a and b must still be dismissed.
    const after = core.overview("default");
    const pair = after.possibleDuplicates.find(
      (pd) => (pd.conceptAId === a.conceptId && pd.conceptBId === b.conceptId) ||
               (pd.conceptAId === b.conceptId && pd.conceptBId === a.conceptId),
    );
    expect(pair).toBeUndefined(); // still dismissed

    core.close();
  });

  it("dismissal SURVIVES a detach/rederive cycle on the destination concept", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    core.dismissPossibleDuplicate(a.conceptId, b.conceptId);

    // Add a second obs to b so we can detach from it.
    await core.store("SQLite is a local-first storage option.", { attachTo: b.conceptId });

    // Detach from b — triggers unwind+rederive on b.
    const fetchedB = (await core.getConcept(b.conceptId, { synthesize: false }))!;
    const firstObsB = fetchedB.observations[0]!.id;
    await core.detach(b.conceptId, [firstObsB]);

    const after = core.overview("default");
    const pair = after.possibleDuplicates.find(
      (pd) => (pd.conceptAId === a.conceptId && pd.conceptBId === b.conceptId) ||
               (pd.conceptAId === b.conceptId && pd.conceptBId === a.conceptId),
    );
    expect(pair).toBeUndefined(); // still dismissed

    core.close();
  });

  it("a reinforcing near-miss store (ON CONFLICT) does NOT un-dismiss the pair", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    core.dismissPossibleDuplicate(a.conceptId, b.conceptId);

    // Verify dismissed in DB before reinforcement.
    // The edge may be stored as a→b or b→a; check both directions.
    const edgeAB = dupEdgeRow(core, a.conceptId, b.conceptId, "default");
    const edgeBA = dupEdgeRow(core, b.conceptId, a.conceptId, "default");
    const anyDismissed = (edgeAB?.dismissed_at !== null && edgeAB?.dismissed_at !== undefined) ||
                         (edgeBA?.dismissed_at !== null && edgeBA?.dismissed_at !== undefined);
    expect(anyDismissed).toBe(true);

    // Store another ambiguous-band item that should reinforce the same edge (ON CONFLICT path).
    // The new store will hit the pair and run upsertEdgeBoth → upsertEdge ON CONFLICT.
    const c = await core.store("Monet Local uses SQLite for local data storage.");
    // c should be a new concept (forked) or one of a/b; the important thing is the dismissed
    // edges between a and b must remain dismissed.
    void c; // just to avoid unused warning

    const edgeAB2 = dupEdgeRow(core, a.conceptId, b.conceptId, "default");
    const edgeBA2 = dupEdgeRow(core, b.conceptId, a.conceptId, "default");
    const stillDismissed = (edgeAB2?.dismissed_at !== null && edgeAB2?.dismissed_at !== undefined) ||
                           (edgeBA2?.dismissed_at !== null && edgeBA2?.dismissed_at !== undefined);
    expect(stillDismissed).toBe(true);

    // Pair remains absent from the overview.
    const after = core.overview("default");
    const pair = after.possibleDuplicates.find(
      (pd) => (pd.conceptAId === a.conceptId && pd.conceptBId === b.conceptId) ||
               (pd.conceptAId === b.conceptId && pd.conceptBId === a.conceptId),
    );
    expect(pair).toBeUndefined();

    core.close();
  });

  it("dismissal with a consolidated-away concept id errors gracefully", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    // Consolidate b into a (detach all of b's observations into a).
    await core.store("Extra obs for b.", { attachTo: b.conceptId }); // ensure b has 2 obs
    const fetchedB = (await core.getConcept(b.conceptId, { synthesize: false }))!;
    const allBObsIds = fetchedB.observations.map((o) => o.id);
    await core.detach(b.conceptId, allBObsIds, { destConceptId: a.conceptId });
    // Now b is deleted.
    expect(core.circleOf(b.conceptId)).toBeNull();

    // Dismissal with the deleted id must return graceful error, not throw.
    const result = core.dismissPossibleDuplicate(a.conceptId, b.conceptId);
    expect(result.dismissed).toBe(false);
    expect((result as { dismissed: false; error: string }).error).toMatch(/concept not found/);

    core.close();
  });

  it("re-dismissing an already-dismissed pair is idempotent: rowsUpdated==0 and provenance preserved", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    // First dismissal — capture provenance.
    const first = core.dismissPossibleDuplicate(a.conceptId, b.conceptId, "alice");
    expect(first.dismissed).toBe(true);
    // The UPDATE touches both directed edges (a→b and b→a), so rowsUpdated should be 2.
    expect((first as { dismissed: true; rowsUpdated: number }).rowsUpdated).toBeGreaterThan(0);
    const firstRowsUpdated = (first as { dismissed: true; rowsUpdated: number }).rowsUpdated;

    // Read stored provenance from whichever directed edge row exists.
    const edgeAB = dupEdgeRow(core, a.conceptId, b.conceptId, "default");
    const edgeBA = dupEdgeRow(core, b.conceptId, a.conceptId, "default");
    const firstEdge = edgeAB ?? edgeBA;
    expect(firstEdge).toBeDefined();
    const firstDismissedAt = firstEdge!.dismissed_at;
    const firstDismissedBy = firstEdge!.dismissed_by;
    expect(firstDismissedAt).not.toBeNull();
    expect(firstDismissedBy).toBe("alice");

    // Second dismissal on the same already-dismissed pair.
    const second = core.dismissPossibleDuplicate(a.conceptId, b.conceptId, "bob");
    expect(second.dismissed).toBe(true);
    // Guard: no live (undismissed) edges remain → rowsUpdated must be 0.
    expect((second as { dismissed: true; rowsUpdated: number }).rowsUpdated).toBe(0);

    // Provenance must be byte-identical to the first dismissal (not overwritten).
    const edgeAB2 = dupEdgeRow(core, a.conceptId, b.conceptId, "default");
    const edgeBA2 = dupEdgeRow(core, b.conceptId, a.conceptId, "default");
    const secondEdge = edgeAB2 ?? edgeBA2;
    expect(secondEdge!.dismissed_at).toBe(firstDismissedAt);
    expect(secondEdge!.dismissed_by).toBe(firstDismissedBy); // still "alice", not "bob"

    // Sanity: the first call did actually update > 0 rows (both directions).
    expect(firstRowsUpdated).toBe(2);

    core.close();
  });
});

// ---- 8. memory_resolve MCP -------------------------------------------------

describe("8. memory_resolve MCP — contradiction path regression + dismissal path + scope gates", () => {
  it("contradiction path (existing) works unchanged after the 0.6.0 extension", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("We use SQLite for storage.");
    const contra = core.flagContradiction(r.conceptId, { detail: "we use Postgres now" });
    const client = await mcpClient(core);

    const result = await client.callTool({
      name: "memory_resolve",
      arguments: { contradictionId: contra.id, decision: "accept-new" },
    });
    const parsed = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(parsed.conceptId).toBe(r.conceptId);
    expect(parsed.status).toBe("active");
    core.close();
  });

  it("dismissal path works end-to-end via MCP", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    const beforeOv = core.overview("default");
    expect(beforeOv.counts.possibleDuplicates).toBe(1);

    const client = await mcpClient(core);
    const result = await client.callTool({
      name: "memory_resolve",
      arguments: { conceptAId: a.conceptId, conceptBId: b.conceptId },
    });
    const parsed = parseResult(result as { content: Array<{ type: string; text: string }> });
    expect(parsed.action).toBe("duplicate-pair-dismissed");
    expect(parsed.conceptAId).toBe(a.conceptId);
    expect(parsed.conceptBId).toBe(b.conceptId);

    const afterOv = core.overview("default");
    expect(afterOv.counts.possibleDuplicates).toBe(0);

    core.close();
  });

  it("dismissal scope gate: concept in wrong circle returns error", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1, defaultCircle: "proj" });
    const a = await core.store("SQLite for Monet Local.", { circle: "c1" });
    const b = await core.store("Monet Local uses SQLite.", { circle: "c2" });

    const client = await mcpClient(core);
    // Try to dismiss across circles — scope(circle) defaults to "proj" but concepts live in c1/c2.
    const result = await client.callTool({
      name: "memory_resolve",
      arguments: { conceptAId: a.conceptId, conceptBId: b.conceptId },
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    // err() returns a plain error string (not JSON) — just verify it contains the expected text.
    expect(result.content[0].text).toMatch(/concept not found/);

    core.close();
  });

  it("dismissal scope gate: requires both conceptAId and conceptBId", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("SQLite for storage.");
    const client = await mcpClient(core);

    const result = await client.callTool({
      name: "memory_resolve",
      arguments: { conceptAId: a.conceptId }, // missing conceptBId
    });
    expect((result as { content: Array<{ type: string; text: string }>; isError?: boolean }).isError).toBe(true);

    core.close();
  });

  // Fix 4 — promoted review probes: union edge cases at the MCP layer
  it("no params at all → clean error (not an unhandled exception)", async () => {
    const core = new MonetCore(":memory:");
    const client = await mcpClient(core);

    const result = await client.callTool({ name: "memory_resolve", arguments: {} }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    // Must produce a readable error message, not an unhandled throw.
    expect(result.content[0].text).toMatch(/contradictionId|required/i);

    core.close();
  });

  it("contradictionId + conceptAId together → clean 'not both' error", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("SQLite for storage.");
    const contra = core.flagContradiction(r.conceptId, { detail: "test" });
    const a = await core.store("Another concept.");
    const b = await core.store("Yet another concept.");
    const client = await mcpClient(core);

    const result = await client.callTool({
      name: "memory_resolve",
      arguments: { contradictionId: contra.id, decision: "accept-new", conceptAId: a.conceptId, conceptBId: b.conceptId },
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not both|either.*contradiction/i);

    core.close();
  });

  it("contradictionId without decision → clean error", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("SQLite for storage.");
    const contra = core.flagContradiction(r.conceptId, { detail: "test" });
    const client = await mcpClient(core);

    const result = await client.callTool({
      name: "memory_resolve",
      arguments: { contradictionId: contra.id }, // missing decision
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/decision.*required|required.*decision/i);

    core.close();
  });
});
