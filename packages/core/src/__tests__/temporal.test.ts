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
import { describe, it, expect, vi } from "vitest";
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
  it("columns exist, last_confirmed_at backfilled to updated_at, user_version == 3 (AROUSAL_SCHEMA_VERSION)", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-temporal-"));
    const dbPath = join(dir, "test.db");
    try {
      // Phase 1: simulate a pre-0.6.0 store by opening with the first engine, which will run
      // the migration. user_version goes from 0 → 3 (GRAPH=1 backfill + TEMPORAL=2 + AROUSAL=3).
      const core = new MonetCore(dbPath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (core as any).db as import("../storage").StoragePort;

      // Verify temporal columns exist on concepts.
      const conceptCols = db.prepare(`PRAGMA table_info(concepts)`).all() as Array<{ name: string }>;
      expect(conceptCols.some((c) => c.name === "last_confirmed_at")).toBe(true);
      expect(conceptCols.some((c) => c.name === "last_confirmed_session_id")).toBe(true);

      // Verify arousal columns exist on concepts (slice 2). arousal_peak was dropped (M-1 fix).
      expect(conceptCols.some((c) => c.name === "usefulness_last_fetched_at")).toBe(true);
      expect(conceptCols.some((c) => c.name === "arousal_score")).toBe(true);
      expect(conceptCols.some((c) => c.name === "arousal_last_updated_at")).toBe(true);
      expect(conceptCols.some((c) => c.name === "arousal_peak")).toBe(false);

      // Verify dismissed columns exist on memory_edge.
      const edgeCols = db.prepare(`PRAGMA table_info(memory_edge)`).all() as Array<{ name: string }>;
      expect(edgeCols.some((c) => c.name === "dismissed_at")).toBe(true);
      expect(edgeCols.some((c) => c.name === "dismissed_by")).toBe(true);

      // Verify user_version == SOURCE_FILE_CONCEPT_SCHEMA_VERSION (10) — fully migrated through all versions.
      const version = db.pragma("user_version", { simple: true }) as number;
      expect(version).toBe(10);

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
      expect(version2).toBe(10); // SOURCE_FILE_CONCEPT_SCHEMA_VERSION — fully migrated
      coreB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- 1b. Migration ordering: graph-disabled open preserves user_version=0 ---

describe("1b. Migration ordering — graph-disabled open does not consume graph backfill slot", () => {
  it("graph-disabled open: user_version stays 0 but last_confirmed_at is backfilled immediately (Fix B atomic backfill)", () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-temporal-graph-disabled-"));
    const dbPath = join(dir, "test.db");
    try {
      // Stage 1: Graph-DISABLED open on a fresh DB.
      // The schema is created (tables/columns exist). user_version must remain 0
      // (graph-disabled means the graph backfill slot is preserved for the next graph-enabled open).
      // Fix B: the temporal backfill now runs ATOMICALLY in the column-guard branch — independent
      // of graphEnabled and user_version — so last_confirmed_at is non-NULL immediately.
      const coreDisabled = new MonetCore(dbPath, { graphEnabled: false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbDisabled = (coreDisabled as any).db as import("../storage").StoragePort;

      // Simulate a pre-0.6.0 row by inserting directly with last_confirmed_at = NULL.
      // Insert AFTER the migrate() has already run so the column exists; the row itself
      // has NULL to simulate a pre-existing record that the column-guard backfill missed
      // (will be caught by the WHERE-NULL catch-up pass on the next open).
      const preExistingId = "pre-existing-concept-id-" + Math.random().toString(36).slice(2);
      const nowMs = Date.now();
      dbDisabled.prepare(
        `INSERT INTO concepts (id, slug, title, body, kind, status, confidence, version, circle, support_count, dirty, embedding, updated_at, last_confirmed_at, last_confirmed_session_id)
         VALUES (?, 'pre-existing', 'pre-existing', 'pre-existing', 'fact', 'active', 0.7, 1, 'default', 1, 0, '[]', ?, NULL, NULL)`,
      ).run(preExistingId, nowMs);

      // user_version must still be 0 (graph-disabled, slot preserved for graph-enabled open).
      const versionAfterDisabled = dbDisabled.pragma("user_version", { simple: true }) as number;
      expect(versionAfterDisabled).toBe(0);

      coreDisabled.close();

      // Stage 2: Re-open (graph-disabled again). The WHERE-NULL catch-up pass fires and
      // backfills the row we inserted in Stage 1 with last_confirmed_at = NULL.
      const coreDisabled2 = new MonetCore(dbPath, { graphEnabled: false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbDisabled2 = (coreDisabled2 as any).db as import("../storage").StoragePort;

      const rowAfterCatchUp = dbDisabled2
        .prepare(`SELECT last_confirmed_at, updated_at FROM concepts WHERE id = ?`)
        .get(preExistingId) as { last_confirmed_at: number | null; updated_at: number };
      // Fix B: WHERE-NULL catch-up runs → value is now backfilled (non-NULL, equals updated_at).
      expect(rowAfterCatchUp.last_confirmed_at).not.toBeNull();
      expect(rowAfterCatchUp.last_confirmed_at).toBe(rowAfterCatchUp.updated_at);

      coreDisabled2.close();

      // Stage 3: Graph-ENABLED open on the same DB.
      // Graph backfill runs (0 → 1), temporal version-gate bump runs (1 → 2), arousal bump (2 → 3).
      // Temporal values must be byte-unchanged (WHERE-NULL pass updates 0 rows; rows already filled).
      const coreEnabled = new MonetCore(dbPath, { graphEnabled: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbEnabled = (coreEnabled as any).db as import("../storage").StoragePort;

      const versionAfterEnabled = dbEnabled.pragma("user_version", { simple: true }) as number;
      expect(versionAfterEnabled).toBe(10); // SOURCE_FILE_CONCEPT_SCHEMA_VERSION

      const rowAfterEnabled = dbEnabled
        .prepare(`SELECT last_confirmed_at FROM concepts WHERE id = ?`)
        .get(preExistingId) as { last_confirmed_at: number | null };
      // Temporal value must be byte-unchanged from the catch-up pass — NOT overwritten.
      expect(rowAfterEnabled.last_confirmed_at).toBe(rowAfterCatchUp.last_confirmed_at);

      coreEnabled.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- 2. Staleness divergence -----------------------------------------------

describe("2. Staleness divergence — structural op updates updated_at but not last_confirmed_at", () => {
  it("a concept's staleness is based on last_confirmed_at, not updated_at", async () => {
    // Use a large staleAfterMs (10 min) so "fresh" timestamps never race the window on any runner.
    // The concept's last_confirmed_at is set by store() to ~now; with a 10-minute window it will
    // never appear stale before we deliberately age it below.
    const STALE_AFTER_MS = 600_000; // 10 minutes
    const core = new MonetCore(":memory:", { staleAfterMs: STALE_AFTER_MS });
    const r = await core.store("Auth tokens are signed with jose.");

    // Immediately: concept is fresh (last_confirmed_at ≈ now, window = 10 min).
    // No wall-clock race: even on the slowest CI runner, test setup cannot consume 10 minutes.
    expect(core.getStaleConcepts().some((c) => c.id === r.conceptId)).toBe(false);

    // Pin last_confirmed_at to 2× the stale window in the past, set updated_at to NOW —
    // simulates a structural op that bumped updated_at but not last_confirmed_at.
    // Using 2× ensures staleness regardless of runner speed.
    const pastTs = Date.now() - STALE_AFTER_MS * 2;
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
    // 10ms delay before the new-session attach so the new last_confirmed_at is strictly greater
    // than originalLca — guards against sub-millisecond flakes (mirrors contradiction tests).
    await new Promise((res) => setTimeout(res, 10));
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

    const dismissAt = before.last_confirmed_at! + 5000;
    vi.useFakeTimers();
    vi.setSystemTime(dismissAt);
    try {
      core.resolveContradiction(contra.id, { decision: "dismiss" });
    } finally {
      vi.useRealTimers();
    }
    const after = rawRow(core, r.conceptId)!;
    // dismiss: last_confirmed_at must be UNCHANGED.
    expect(after.last_confirmed_at).toBe(before.last_confirmed_at);
    const dismissedAt = ((core as any).db.prepare(`SELECT resolved_at FROM contradictions WHERE id = ?`).get(contra.id) as { resolved_at: number }).resolved_at;
    expect(dismissedAt).toBe(dismissAt);
    expect(dismissedAt).toBeGreaterThan(before.last_confirmed_at!);

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

// ---- Fix 1 — detach-to-NEW inherits source's temporal fields ----------------

describe("Fix 1 — detach-to-NEW: new concept inherits source last_confirmed_at/session", () => {
  it("splitting a stale-aged source into a NEW concept: new concept carries source's old last_confirmed_at (not now)", async () => {
    // tauAttach=1.1 prevents auto-merging; staleAfterMs=5 so old timestamps read stale.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, staleAfterMs: 5 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;

    // Create source concept.
    const sourceResult = await core.store("Auth tokens are signed with jose.");
    const sourceId = sourceResult.conceptId;

    // Add a second observation so we can detach the first without hitting the last-obs guard.
    await core.store("jose handles JWT signing and verification.", { attachTo: sourceId });

    // Freeze source's last_confirmed_at to a stale-aged timestamp (well in the past).
    const staleTs = Date.now() - 2000; // 2 seconds ago — definitely > staleAfterMs=5ms
    const staleSessionId = "stale-session-id-frozen";
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, last_confirmed_session_id = ? WHERE id = ?`).run(staleTs, staleSessionId, sourceId);

    // Sanity: source reads stale before detach.
    expect(core.getStaleConcepts().some((c) => c.id === sourceId)).toBe(true);

    // Detach the first observation into a NEW concept (no destConceptId).
    const fetchedSource = (await core.getConcept(sourceId, { synthesize: false }))!;
    const firstObsId = fetchedSource.observations[0]!.id;
    const detachResult = await core.detach(sourceId, [firstObsId]);
    expect(detachResult.sourceDeleted).toBe(false);

    // New concept must carry the source's OLD last_confirmed_at (not Date.now()).
    // Under P2: last_confirmed_at = min(source_pre_split_lca, max(moved obs created_at)).
    // The source's last_confirmed_at is staleTs (2s ago); the moved obs created_at is ~now;
    // min(staleTs, ~now) = staleTs — the new concept correctly inherits the stale stamp.
    const newConceptId = detachResult.destConceptId;
    const newRow = rawRow(core, newConceptId)!;
    expect(newRow.last_confirmed_at).toBe(staleTs);
    // Under P2, last_confirmed_session_id comes from the moved observation's session_id,
    // not from the source concept's last_confirmed_session_id (which is a concept-level field
    // not directly tied to observation provenance). The moved obs carries its own session id.
    // We verify it is non-null (a real session was recorded) rather than asserting the exact
    // source concept's forced session id (which belongs to a different provenance chain).
    expect(newRow.last_confirmed_session_id).not.toBeNull();

    // New concept must read stale (not evade staleness detection).
    expect(core.getStaleConcepts().some((c) => c.id === newConceptId)).toBe(true);

    core.close();
  });
});

// ---- Fix 2 — resolveContradiction must open a session before stamping -------

describe("Fix 2 — resolveContradiction: ensureSession before stamping last_confirmed_session_id", () => {
  it("accept-new as the FIRST write of a session: subsequent same-session store() must be damped (not cross-session-bumped)", async () => {
    // tauAttach=0 forces every store to attach; tauAmbiguous=0 forces ambiguous band.
    const core = new MonetCore(":memory:", { tauAttach: 0, tauAmbiguous: 0 });

    // Create a concept and flag a contradiction in the SAME session.
    const r = await core.store("We use SQLite for storage.");
    const contra = core.flagContradiction(r.conceptId, { detail: "actually Postgres" });

    // End the session explicitly — next write is a new session.
    core.endSessionForEval();

    // resolveContradiction as the FIRST write of the new MCP session (no store() before this).
    // Pre-fix: sessionId is null at this point → stamps last_confirmed_session_id = null.
    core.resolveContradiction(contra.id, { decision: "accept-new" });

    // After resolve: last_confirmed_session_id must be NON-null (a real session was opened).
    const afterResolve = rawRow(core, r.conceptId)!;
    expect(afterResolve.last_confirmed_session_id).not.toBeNull();

    // Now store() an attaching observation in the SAME instance (same session as the resolve).
    // Pre-fix: sessionId was null when stamped on the concept → store() sees null ≠ current-session
    //          → treats it as cross-session → bumps confidence +0.1 and refreshes last_confirmed_at.
    // Post-fix: sessionId was properly set by ensureSession() in resolveContradiction → store()
    //           sees same-session → is damped (no confidence bump, no refresh).
    const confidenceBefore = afterResolve.confidence;
    const lcaBefore = afterResolve.last_confirmed_at;

    // Wait a tick so any timestamp refresh would be detectable.
    await new Promise((res) => setTimeout(res, 5));

    await core.store("We use SQLite for storage — attaching obs.");
    const afterStore = rawRow(core, r.conceptId)!;

    // Confidence must NOT be bumped (same-session damping).
    expect(afterStore.confidence).toBeCloseTo(confidenceBefore, 5);
    // last_confirmed_at must NOT be refreshed (same-session damping).
    expect(afterStore.last_confirmed_at).toBe(lcaBefore);

    core.close();
  });
});

// ---- P2 fix — evidence-attributed temporal state on both sides of a split ----
//
// Four-quadrant scenario: a source concept with an OLD observation (created_at aged,
// session A) and a FRESH observation (created_at recent, session B), with
// source.last_confirmed_at = the fresh cross-session attach time.
//
// Q1: Move the FRESH observation to NEW → dest carries fresh stamp; source falls back
//     to old obs's created_at (reads stale).
// Q2: Move the OLD observation to NEW → dest carries the OLD timestamp (reads stale);
//     source keeps its fresh stamp.
// Q3: Move one observation to an EXISTING dest (partial) → dest temporal fields
//     unchanged; source recomputes per Q1's logic.
// Q4: Full consolidation regression → keeper MAX-carries (unchanged).

describe("P2 fix — evidence-attributed temporal state on both sides of a detach split", () => {
  /** Helper: returns { last_confirmed_at, last_confirmed_session_id } for a concept row. */
  function rawTemporalRow(core: MonetCore, id: string): { last_confirmed_at: number | null; last_confirmed_session_id: string | null } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;
    return db
      .prepare(`SELECT last_confirmed_at, last_confirmed_session_id FROM concepts WHERE id = ?`)
      .get(id) as { last_confirmed_at: number | null; last_confirmed_session_id: string | null };
  }

  /** Helper: returns { created_at, session_id } for an observation row. */
  function rawObsRow(core: MonetCore, obsId: string): { created_at: number; session_id: string | null } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;
    return db
      .prepare(`SELECT created_at, session_id FROM observations WHERE id = ?`)
      .get(obsId) as { created_at: number; session_id: string | null };
  }

  /**
   * Set up a source concept with two observations whose temporal evidence is spread:
   *   obs1 (OLD):   created_at = Date.now() - 2000 ms, session_id = "session-old"
   *   obs2 (FRESH): created_at = Date.now()           (recent), session_id = "session-fresh"
   * Source concept's last_confirmed_at is set to obs2.created_at (the fresh attach time),
   * last_confirmed_session_id = "session-fresh".
   *
   * Returns { core, db, sourceId, obs1Id, obs2Id, oldCreatedAt, freshCreatedAt }.
   */
  async function buildSourceWithOldAndFreshObs(staleAfterMs = 600_000): Promise<{
    core: MonetCore;
    db: import("../storage").StoragePort;
    sourceId: string;
    obs1Id: string; // OLD observation
    obs2Id: string; // FRESH observation
    oldCreatedAt: number;
    freshCreatedAt: number;
  }> {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, staleAfterMs });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;

    // Session A creates the first observation on a new concept.
    const r1 = await core.store("Old fact: the original evidence for this concept.");
    const sourceId = r1.conceptId;
    const fetched1 = (await core.getConcept(sourceId, { synthesize: false }))!;
    const obs1Id = fetched1.observations[0]!.id;

    // Age obs1's created_at to 2× staleAfterMs in the past — deterministically stale regardless
    // of runner speed. With staleAfterMs=600_000 (10 min) this is 20 minutes ago.
    const oldCreatedAt = Date.now() - staleAfterMs * 2;
    db.prepare(`UPDATE observations SET created_at = ?, session_id = ? WHERE id = ?`).run(oldCreatedAt, "session-old", obs1Id);

    // Session B attaches a cross-session observation. end the current session first.
    core.endSessionForEval();
    await core.store("Fresh fact: newer evidence attached in a different session.", { attachTo: sourceId });
    const fetched2 = (await core.getConcept(sourceId, { synthesize: false }))!;
    const obs2Id = fetched2.observations[1]!.id;

    // Record fresh obs metadata before any manipulation.
    const freshObsRow = rawObsRow(core, obs2Id);
    const freshCreatedAt = freshObsRow.created_at;
    const freshSessionId = freshObsRow.session_id ?? "session-fresh";

    // Ensure the session_id on obs2 is stable and well-labelled.
    db.prepare(`UPDATE observations SET session_id = ? WHERE id = ?`).run(freshSessionId, obs2Id);

    // Set source.last_confirmed_at = freshCreatedAt and source.last_confirmed_session_id = freshSessionId.
    // This is the state after a cross-session attach: source appears freshly confirmed.
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, last_confirmed_session_id = ? WHERE id = ?`).run(
      freshCreatedAt, freshSessionId, sourceId,
    );

    return { core, db, sourceId, obs1Id, obs2Id, oldCreatedAt, freshCreatedAt };
  }

  it("Q1: move FRESH obs to NEW → dest carries fresh stamp; source falls back to old obs created_at (reads stale)", async () => {
    // staleAfterMs=600_000 (10 min): oldCreatedAt = now - 20 min is always stale;
    // freshCreatedAt ≈ now will never age past 10 min on any CI runner — deterministic on both sides.
    const { core, sourceId, obs2Id, obs1Id, oldCreatedAt, freshCreatedAt } =
      await buildSourceWithOldAndFreshObs();

    // Verify source currently reads fresh (last_confirmed_at = freshCreatedAt, not stale).
    expect(core.getStaleConcepts().some((c) => c.id === sourceId)).toBe(false);

    // Detach the FRESH observation (obs2) to a NEW concept (no destConceptId).
    const r = await core.detach(sourceId, [obs2Id]);
    expect(r.destAction).toBe("created");
    expect(r.sourceDeleted).toBe(false);

    const destId = r.destConceptId;

    // DESTINATION must carry the fresh stamp.
    const destRow = rawTemporalRow(core, destId);
    // The destination's last_confirmed_at must equal freshCreatedAt (from the moved observation).
    expect(destRow.last_confirmed_at).toBe(freshCreatedAt);

    // SOURCE must fall back: last_confirmed_at must now be <= oldCreatedAt (the only remaining obs).
    // Specifically: min(source_pre_split_lca, max(created_at of remaining obs)) = min(freshCreatedAt, oldCreatedAt) = oldCreatedAt.
    const srcRow = rawTemporalRow(core, sourceId);
    expect(srcRow.last_confirmed_at).toBeLessThanOrEqual(oldCreatedAt);

    // Source must now read STALE (the remaining evidence is old).
    expect(core.getStaleConcepts().some((c) => c.id === sourceId)).toBe(true);

    core.close();
  });

  it("Q2: move OLD obs to NEW → dest carries old timestamp (reads stale); source keeps fresh stamp", async () => {
    // staleAfterMs=600_000 (10 min): oldCreatedAt = now - 20 min is always stale;
    // freshCreatedAt ≈ now will never age past 10 min — no wall-clock race on either verdict.
    const { core, sourceId, obs1Id, obs2Id, oldCreatedAt, freshCreatedAt } =
      await buildSourceWithOldAndFreshObs();

    // Detach the OLD observation (obs1) to a NEW concept.
    const r = await core.detach(sourceId, [obs1Id]);
    expect(r.destAction).toBe("created");
    expect(r.sourceDeleted).toBe(false);

    const destId = r.destConceptId;

    // DESTINATION must carry the OLD timestamp — it only has old evidence.
    // last_confirmed_at = min(source_pre_split_lca, max(created_at of moved obs)) = min(freshCreatedAt, oldCreatedAt) = oldCreatedAt.
    const destRow = rawTemporalRow(core, destId);
    expect(destRow.last_confirmed_at).toBeLessThanOrEqual(oldCreatedAt);

    // Destination must read STALE.
    expect(core.getStaleConcepts().some((c) => c.id === destId)).toBe(true);

    // SOURCE must keep its fresh stamp (remaining obs is the fresh one; freshCreatedAt <= source_pre_split_lca).
    // min(freshCreatedAt, max(created_at of remaining=fresh obs)) = min(freshCreatedAt, freshCreatedAt) = freshCreatedAt.
    const srcRow = rawTemporalRow(core, sourceId);
    expect(srcRow.last_confirmed_at).toBe(freshCreatedAt);

    // Source must still read FRESH.
    expect(core.getStaleConcepts().some((c) => c.id === sourceId)).toBe(false);

    core.close();
  });

  it("Q3: move obs into EXISTING dest (partial) → dest temporal fields unchanged; source recomputes correctly", async () => {
    // staleAfterMs=600_000 (10 min): oldCreatedAt = now - 20 min is always stale;
    // freshCreatedAt ≈ now will never age past 10 min — deterministic, no wall-clock race.
    const { core, db, sourceId, obs2Id, obs1Id, oldCreatedAt, freshCreatedAt } =
      await buildSourceWithOldAndFreshObs();

    // Create an independent destination concept with a known last_confirmed_at.
    const destResult = await core.store("Existing destination concept with its own evidence.");
    const destId = destResult.conceptId;
    const existingDestLca = freshCreatedAt + 5000; // future-dated to ensure it doesn't change
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, last_confirmed_session_id = ? WHERE id = ?`).run(
      existingDestLca, "session-dest", destId,
    );

    // Detach the FRESH observation (obs2) into the EXISTING destination (partial — source keeps obs1).
    const r = await core.detach(sourceId, [obs2Id], { destConceptId: destId });
    expect(r.destAction).toBe("attached");
    expect(r.sourceDeleted).toBe(false);

    // DEST temporal fields must be UNCHANGED (absorbed evidence never refreshes existing concept).
    const destRow = rawTemporalRow(core, destId);
    expect(destRow.last_confirmed_at).toBe(existingDestLca);
    expect(destRow.last_confirmed_session_id).toBe("session-dest");

    // SOURCE must fall back: only obs1 (old) remains.
    // min(source_pre_split_lca=freshCreatedAt, max(created_at of remaining=oldCreatedAt)) = oldCreatedAt.
    const srcRow = rawTemporalRow(core, sourceId);
    expect(srcRow.last_confirmed_at).toBeLessThanOrEqual(oldCreatedAt);

    // Source reads stale.
    expect(core.getStaleConcepts().some((c) => c.id === sourceId)).toBe(true);

    core.close();
  });

  it("Q4: full consolidation regression — fresh source absorbed into stale keeper → keeper MAX-carries (unchanged)", async () => {
    // Verify the existing full-consolidation MAX-carry behavior is unaffected by the P2 fix.
    // staleAfterMs=5 so pastTs is stale.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, staleAfterMs: 5 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;

    // Keeper: stale-aged last_confirmed_at.
    const keeperResult = await core.store("Keeper concept — the target for full consolidation.");
    const keeperId = keeperResult.conceptId;
    const pastTs = Date.now() - 2000;
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, last_confirmed_session_id = ? WHERE id = ?`).run(
      pastTs, "session-stale-keeper", keeperId,
    );

    // Small wait so the source's create timestamp is strictly after pastTs.
    await new Promise((res) => setTimeout(res, 10));

    // Source: freshly confirmed.
    core.endSessionForEval();
    const sourceResult = await core.store("Source concept — will be fully consolidated into keeper.");
    const sourceId = sourceResult.conceptId;
    const sourceRow = rawRow(core, sourceId)!;
    const sourceLca = sourceRow.last_confirmed_at!;
    expect(sourceLca).toBeGreaterThan(pastTs);

    // Full consolidation: detach ALL observations from source into keeper.
    const fetchedSource = (await core.getConcept(sourceId, { synthesize: false }))!;
    const allSourceObsIds = fetchedSource.observations.map((o) => o.id);
    const r = await core.detach(sourceId, allSourceObsIds, { destConceptId: keeperId });

    // Source must be deleted.
    expect(r.sourceDeleted).toBe(true);

    // Keeper must carry the MAX of (keeper_lca=pastTs, source_lca=sourceLca) = sourceLca.
    const keeperAfter = rawRow(core, keeperId)!;
    expect(keeperAfter.last_confirmed_at).toBe(sourceLca);
    expect(keeperAfter.last_confirmed_session_id).toBe(sourceRow.last_confirmed_session_id);

    core.close();
  });
});

// ---- Fix A — closed contradictions are inert on retry -----------------------

describe("Fix A — resolveContradiction is a no-op when contradiction is already closed", () => {
  it("accept-new twice: second call returns alreadyClosed, last_confirmed_at byte-unchanged", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("We use SQLite for storage.", { kind: "fact" });
    const contra = core.flagContradiction(r.conceptId, { detail: "actually Postgres" });

    // First resolve — open contradiction; must mutate.
    await new Promise((res) => setTimeout(res, 10));
    const first = core.resolveContradiction(contra.id, { decision: "accept-new" });
    expect(first).not.toBeNull();
    expect("alreadyClosed" in first!).toBe(false);
    const afterFirst = rawRow(core, r.conceptId)!;
    const lcaAfterFirst = afterFirst.last_confirmed_at;
    expect(lcaAfterFirst).not.toBeNull();

    // Age the DB timestamp so any re-stamp would produce a strictly different value.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;
    db.prepare(`UPDATE concepts SET last_confirmed_at = last_confirmed_at - 5000 WHERE id = ?`).run(r.conceptId);
    const aged = rawRow(core, r.conceptId)!.last_confirmed_at;
    expect(aged).not.toBe(lcaAfterFirst); // verify the age is detectable

    // Second resolve on the same (now closed) contradiction.
    await new Promise((res) => setTimeout(res, 10));
    const second = core.resolveContradiction(contra.id, { decision: "accept-new" });
    expect(second).not.toBeNull();
    expect("alreadyClosed" in second!).toBe(true);
    expect((second as { alreadyClosed: true; contradictionStatus: string }).contradictionStatus).toBe("resolved");

    // last_confirmed_at must be byte-identical to the aged value — zero mutations.
    const afterSecond = rawRow(core, r.conceptId)!;
    expect(afterSecond.last_confirmed_at).toBe(aged);

    core.close();
  });

  it("dismiss-then-resolve: resolve on already-dismissed contradiction returns alreadyClosed, no mutations", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("We use SQLite for storage.", { kind: "fact" });
    const contra = core.flagContradiction(r.conceptId, { detail: "not a real conflict" });

    // Dismiss first.
    core.resolveContradiction(contra.id, { decision: "dismiss" });
    const afterDismiss = rawRow(core, r.conceptId)!;
    const lcaAfterDismiss = afterDismiss.last_confirmed_at;

    // Age so any re-stamp is detectable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;
    db.prepare(`UPDATE concepts SET last_confirmed_at = last_confirmed_at - 5000 WHERE id = ?`).run(r.conceptId);
    const aged = rawRow(core, r.conceptId)!.last_confirmed_at;
    expect(aged).not.toBe(lcaAfterDismiss);

    // Now attempt resolve on the dismissed contradiction.
    await new Promise((res) => setTimeout(res, 10));
    const retry = core.resolveContradiction(contra.id, { decision: "accept-new" });
    expect(retry).not.toBeNull();
    expect("alreadyClosed" in retry!).toBe(true);
    expect((retry as { alreadyClosed: true; contradictionStatus: string }).contradictionStatus).toBe("dismissed");

    // Temporal field must be byte-unchanged.
    const afterRetry = rawRow(core, r.conceptId)!;
    expect(afterRetry.last_confirmed_at).toBe(aged);

    core.close();
  });

  it("resolve-then-dismiss: dismiss on already-resolved contradiction returns alreadyClosed, no mutations", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("We use SQLite for storage.", { kind: "fact" });
    const contra = core.flagContradiction(r.conceptId, { detail: "another conflict" });

    // Resolve first.
    core.resolveContradiction(contra.id, { decision: "keep-current" });
    const afterResolve = rawRow(core, r.conceptId)!;

    // Age so re-stamp is detectable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;
    db.prepare(`UPDATE concepts SET last_confirmed_at = last_confirmed_at - 5000 WHERE id = ?`).run(r.conceptId);
    const aged = rawRow(core, r.conceptId)!.last_confirmed_at;
    expect(aged).not.toBe(afterResolve.last_confirmed_at);

    // Now attempt dismiss on the already-resolved contradiction.
    await new Promise((res) => setTimeout(res, 10));
    const retry = core.resolveContradiction(contra.id, { decision: "dismiss" });
    expect(retry).not.toBeNull();
    expect("alreadyClosed" in retry!).toBe(true);
    expect((retry as { alreadyClosed: true; contradictionStatus: string }).contradictionStatus).toBe("resolved");

    // Temporal field must be byte-unchanged.
    const afterRetry = rawRow(core, r.conceptId)!;
    expect(afterRetry.last_confirmed_at).toBe(aged);

    core.close();
  });

  it("alreadyClosed result is surfaced coherently at the MCP layer", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("We use SQLite for storage.");
    const contra = core.flagContradiction(r.conceptId, { detail: "test" });

    // Resolve once successfully.
    core.resolveContradiction(contra.id, { decision: "accept-new" });

    // Retry via MCP — must return a success response (not an error) with alreadyClosed:true.
    const client = await mcpClient(core);
    const result = await client.callTool({
      name: "memory_resolve",
      arguments: { contradictionId: contra.id, decision: "accept-new" },
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    // Must NOT be an error response — alreadyClosed is a graceful idempotent no-op.
    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.alreadyClosed).toBe(true);
    expect(parsed.contradictionId).toBe(contra.id);
    expect(typeof parsed.contradictionStatus).toBe("string");

    core.close();
  });
});

// ---- Fix B — temporal backfill migration matrix -----------------------------

describe("Fix B — temporal backfill migration matrix", () => {
  it("State A: pre-0.6 store, graph-DISABLED first open → backfill happens immediately; structural write AFTER does not affect already-backfilled values; later graph-enabled open leaves temporal values byte-unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-fixb-stateA-disabled-"));
    const dbPath = join(dir, "test.db");
    try {
      // Stage 1: fresh open, graph-disabled (State A: columns added, backfill runs atomically).
      const core1 = new MonetCore(dbPath, { graphEnabled: false, tauAttach: 1.1, tauAmbiguous: 1.1 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db1 = (core1 as any).db as import("../storage").StoragePort;

      // Store a concept — it must get last_confirmed_at immediately (not NULL).
      const r1 = await core1.store("Fact stored on graph-disabled first open.");
      const row1 = db1.prepare(`SELECT last_confirmed_at, updated_at FROM concepts WHERE id = ?`)
        .get(r1.conceptId) as { last_confirmed_at: number | null; updated_at: number };
      expect(row1.last_confirmed_at).not.toBeNull(); // Fix B: backfill ran atomically in column-guard

      const lcaBefore = row1.last_confirmed_at!;

      // Structural write: bump updated_at without evidence (simulate synthesize/checkpoint).
      db1.prepare(`UPDATE concepts SET updated_at = updated_at + 10000 WHERE id = ?`).run(r1.conceptId);

      const rowAfterStructural = db1.prepare(`SELECT last_confirmed_at, updated_at FROM concepts WHERE id = ?`)
        .get(r1.conceptId) as { last_confirmed_at: number | null; updated_at: number };
      // last_confirmed_at must be byte-unchanged by the structural write.
      expect(rowAfterStructural.last_confirmed_at).toBe(lcaBefore);

      core1.close();

      // Stage 2: graph-enabled open — runs graph backfill (0→1) + temporal bump (1→2) + arousal bump (2→3).
      // Temporal values must be byte-unchanged (WHERE-NULL pass updates 0 rows).
      const core2 = new MonetCore(dbPath, { graphEnabled: true, tauAttach: 1.1, tauAmbiguous: 1.1 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db2 = (core2 as any).db as import("../storage").StoragePort;

      const version2 = db2.pragma("user_version", { simple: true }) as number;
      expect(version2).toBe(10); // SOURCE_FILE_CONCEPT_SCHEMA_VERSION

      const rowAfterGraphEnabled = db2.prepare(`SELECT last_confirmed_at FROM concepts WHERE id = ?`)
        .get(r1.conceptId) as { last_confirmed_at: number | null };
      // Temporal value must be byte-identical to what the first open set.
      expect(rowAfterGraphEnabled.last_confirmed_at).toBe(lcaBefore);

      core2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("State B: stranded store (columns exist, values NULL, user_version 0) → WHERE-NULL catch-up path fires, excluding kind='workstream'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-fixb-stateB-stranded-"));
    const dbPath = join(dir, "test.db");
    try {
      // Build a store, then manually craft the stranded state: NULL last_confirmed_at, user_version=0.
      const core0 = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      const r0 = await core0.store("Concept written before the simulated crash.");
      const ws0 = await core0.saveWorkstream({ status: "active", nextSteps: ["catch up"] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db0 = (core0 as any).db as import("../storage").StoragePort;
      // Force stranded state: NULL temporal fields, user_version=0.
      db0.prepare(`UPDATE concepts SET last_confirmed_at = NULL WHERE last_confirmed_at IS NOT NULL`).run();
      db0.pragma("user_version = 0");

      // Verify the workstream row is NULL (it was NULL by design or just set to NULL above).
      const wsRowBefore = db0.prepare(`SELECT last_confirmed_at, kind FROM concepts WHERE id = ?`)
        .get(ws0.id) as { last_confirmed_at: number | null; kind: string };
      expect(wsRowBefore.kind).toBe("workstream");
      expect(wsRowBefore.last_confirmed_at).toBeNull();

      core0.close();

      // Re-open under new code (graph-enabled). WHERE-NULL catch-up pass must fire.
      const core1 = new MonetCore(dbPath, { graphEnabled: true, tauAttach: 1.1, tauAmbiguous: 1.1 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db1 = (core1 as any).db as import("../storage").StoragePort;

      const rowAfterCatchUp = db1.prepare(`SELECT last_confirmed_at, updated_at FROM concepts WHERE id = ?`)
        .get(r0.conceptId) as { last_confirmed_at: number | null; updated_at: number };
      // Non-workstream concept must be backfilled.
      expect(rowAfterCatchUp.last_confirmed_at).not.toBeNull();
      expect(rowAfterCatchUp.last_confirmed_at).toBe(rowAfterCatchUp.updated_at);

      // Workstream row must still be NULL — excluded by kind != 'workstream' guard.
      const wsRowAfter = db1.prepare(`SELECT last_confirmed_at FROM concepts WHERE id = ?`)
        .get(ws0.id) as { last_confirmed_at: number | null };
      expect(wsRowAfter.last_confirmed_at).toBeNull();

      core1.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("State C: already-migrated store (columns exist, values backfilled, user_version 3) → open is a pure no-op; all temporal values byte-unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-fixb-stateC-migrated-"));
    const dbPath = join(dir, "test.db");
    try {
      // Build a fully migrated store.
      const core0 = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      const r0 = await core0.store("Migrated concept.");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db0 = (core0 as any).db as import("../storage").StoragePort;
      const version0 = db0.pragma("user_version", { simple: true }) as number;
      expect(version0).toBe(10); // fully migrated (SOURCE_FILE_CONCEPT_SCHEMA_VERSION)
      const lcaBefore = (db0.prepare(`SELECT last_confirmed_at FROM concepts WHERE id = ?`).get(r0.conceptId) as { last_confirmed_at: number | null }).last_confirmed_at;
      expect(lcaBefore).not.toBeNull();
      core0.close();

      // Re-open — must be a pure no-op (WHERE-NULL updates 0 rows; version-gate no-op).
      const core1 = new MonetCore(dbPath, { tauAttach: 1.1, tauAmbiguous: 1.1 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db1 = (core1 as any).db as import("../storage").StoragePort;

      const version1 = db1.pragma("user_version", { simple: true }) as number;
      expect(version1).toBe(10); // SOURCE_FILE_CONCEPT_SCHEMA_VERSION — unchanged on re-open

      const lcaAfter = (db1.prepare(`SELECT last_confirmed_at FROM concepts WHERE id = ?`).get(r0.conceptId) as { last_confirmed_at: number | null }).last_confirmed_at;
      // Must be byte-identical — no spurious update.
      expect(lcaAfter).toBe(lcaBefore);

      core1.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("State D: fresh 0.6.0 store — post-0.6.0 workstream rows keep NULL temporal fields (no false stamping by any backfill path)", async () => {
    // Workstream rows are kind='workstream'. They are NULL by design and excluded from all
    // backfill paths (kind != 'workstream' guard in both the column-guard and WHERE-NULL branches).
    const core = new MonetCore(":memory:");
    const ws = await core.saveWorkstream({ status: "active", nextSteps: ["do a thing"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (core as any).db as import("../storage").StoragePort;
    const wsRow = db.prepare(`SELECT last_confirmed_at, kind FROM concepts WHERE id = ?`)
      .get(ws.id) as { last_confirmed_at: number | null; kind: string };
    expect(wsRow.kind).toBe("workstream");
    // Workstream temporal field must remain NULL — excluded by design from staleness consumers.
    expect(wsRow.last_confirmed_at).toBeNull();
    core.close();
  });
});

// ---- Fix C — dismiss with contradiction-only fields is rejected ---------------

describe("Fix C — dismissal branch rejects contradiction-path-only fields", () => {
  it("conceptAId + conceptBId + decision → clean error naming the conflict; pair is NOT dismissed", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    const client = await mcpClient(core);
    const result = await client.callTool({
      name: "memory_resolve",
      arguments: { conceptAId: a.conceptId, conceptBId: b.conceptId, decision: "accept-new" },
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    // Must be an error response naming the conflict.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/decision.*contradiction|contradiction.*verdict/i);

    // Pair must NOT have been dismissed.
    const ov = core.overview("default");
    expect(ov.counts.possibleDuplicates).toBe(1);

    core.close();
  });

  it("conceptAId + conceptBId + body → clean error naming the conflict; pair is NOT dismissed", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    const client = await mcpClient(core);
    const result = await client.callTool({
      name: "memory_resolve",
      arguments: { conceptAId: a.conceptId, conceptBId: b.conceptId, body: "The reconciled body." },
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    // Must be an error response naming the conflict.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/body.*contradiction|contradiction.*verdict/i);

    // Pair must NOT have been dismissed.
    const ov = core.overview("default");
    expect(ov.counts.possibleDuplicates).toBe(1);

    core.close();
  });

  it("pure dismissal payload (conceptAId + conceptBId, no contradiction-only fields) still works", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0.9, tauAmbiguous: 0.1 });
    const a = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    const b = await core.store("Monet Local uses SQLite for its local storage backend.");
    expect(b.action).toBe("ambiguous");

    const client = await mcpClient(core);
    const result = await client.callTool({
      name: "memory_resolve",
      arguments: { conceptAId: a.conceptId, conceptBId: b.conceptId },
    }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    const parsed = parseResult(result);
    expect(parsed.action).toBe("duplicate-pair-dismissed");

    const ov = core.overview("default");
    expect(ov.counts.possibleDuplicates).toBe(0);

    core.close();
  });
});
