/**
 * V-A Ranking Probe — empirical validation of valence-arousal signals
 *
 * What this proves:
 *   Group 1 — the driver API (getConcept, flagContradiction) actually increments the V-A columns.
 *             The static coding-eval couldn't test this: it seeded a fresh store where
 *             usefulness/arousal were always 0 by the time any ranking ran.
 *
 *   Group 2 — the V-A signals reorder prewarm().topConcepts as designed when every other
 *             input is held equal between siblings (confound closure).  A separate mutation
 *             pass that zeros AROUSAL_WEIGHT_LIVING and neutralises the usefulness term MUST
 *             cause these tests to FAIL — if they wouldn't, the isolation is broken.
 *
 * Clock control: Date.now() is hardwired in engine.ts.  We back-date timestamp columns via
 * the raw sqlite3 handle — the proven house pattern from usefulness-decay.test.ts.
 *
 * Keyless, deterministic, no network, no ONNX model.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cast the private db handle so we can write raw SQL. */
function rawDb(core: MonetCore): import("../storage").StoragePort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (core as any).db as import("../storage").StoragePort;
}

/** Read the V-A columns for a concept. */
function vaRow(core: MonetCore, id: string): {
  usefulness_score: number;
  usefulness_last_fetched_at: number | null;
  arousal_score: number;
  arousal_last_updated_at: number | null;
} {
  const db = rawDb(core);
  return db
    .prepare(
      `SELECT usefulness_score, usefulness_last_fetched_at,
              arousal_score, arousal_last_updated_at
         FROM concepts WHERE id = ?`,
    )
    .get(id) as {
    usefulness_score: number;
    usefulness_last_fetched_at: number | null;
    arousal_score: number;
    arousal_last_updated_at: number | null;
  };
}

/**
 * Pin the fields that determine livingModelScore for a concept so that two siblings
 * are held identical on every dimension EXCEPT the one under test.
 *
 *   confidence × (1 + usefulnessDecayed) × recency × (1 + 0.5 × effectiveArousal)
 *
 * confidence, last_confirmed_at (→ recency and usefulness fallback), and support_count
 * are the "baseline" inputs; the caller supplies the V-A overrides.
 */
function pin(
  core: MonetCore,
  id: string,
  opts: {
    confidence: number;
    supportCount: number;
    lastConfirmedAt: number;
    /** raw usefulness_score column */
    usefulnessScore?: number;
    /** raw usefulness_last_fetched_at column (ms since epoch) */
    usefulnessFetchedAt?: number | null;
    /** raw arousal_score column */
    arousalScore?: number;
    /** raw arousal_last_updated_at column (ms since epoch) */
    arousalUpdatedAt?: number | null;
  },
): void {
  const db = rawDb(core);
  const {
    confidence,
    supportCount,
    lastConfirmedAt,
    usefulnessScore = 0,
    usefulnessFetchedAt = null,
    arousalScore = 0,
    arousalUpdatedAt = null,
  } = opts;

  db.prepare(
    `UPDATE concepts
        SET confidence            = ?,
            support_count         = ?,
            last_confirmed_at     = ?,
            updated_at            = ?,
            usefulness_score      = ?,
            usefulness_last_fetched_at = ?,
            arousal_score         = ?,
            arousal_last_updated_at    = ?
      WHERE id = ?`,
  ).run(
    confidence,
    supportCount,
    lastConfirmedAt,
    lastConfirmedAt, // keep updated_at in sync so recency fallback is identical
    usefulnessScore,
    usefulnessFetchedAt,
    arousalScore,
    arousalUpdatedAt,
    id,
  );
}

// ---------------------------------------------------------------------------
// Group 1 — DRIVERS
// These tests prove the public API actually writes the V-A columns.
// ---------------------------------------------------------------------------

describe("Group 1 — DRIVERS: real API moves V-A columns off zero", () => {
  it("1.1 usefulness driver: getConcept increments usefulness_score and sets usefulness_last_fetched_at", async () => {
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 365 * 86_400_000,
    });

    const r = await core.store("Usefulness driver test concept.");
    const before = vaRow(core, r.conceptId);
    expect(before.usefulness_score).toBe(0);
    expect(before.usefulness_last_fetched_at).toBeNull();

    // Three fetches should give usefulness_score == 3.
    await core.getConcept(r.conceptId, { synthesize: false });
    await core.getConcept(r.conceptId, { synthesize: false });
    await core.getConcept(r.conceptId, { synthesize: false });

    const after = vaRow(core, r.conceptId);
    expect(after.usefulness_score).toBe(3);
    expect(after.usefulness_last_fetched_at).not.toBeNull();

    core.close();
  });

  it("1.2 arousal driver: flagContradiction sets arousal_score = 3 and arousal_last_updated_at non-null", async () => {
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 365 * 86_400_000,
    });

    const r = await core.store("Arousal driver test concept.");
    const before = vaRow(core, r.conceptId);
    expect(before.arousal_score).toBe(0);
    expect(before.arousal_last_updated_at).toBeNull();

    core.flagContradiction(r.conceptId, { detail: "conflicting evidence" });

    const after = vaRow(core, r.conceptId);
    // flagContradiction adds +3 to arousal_score (engine.ts:1188).
    expect(after.arousal_score).toBe(3);
    expect(after.arousal_last_updated_at).not.toBeNull();

    core.close();
  });
});

// ---------------------------------------------------------------------------
// Group 2 — RANKING EFFECT
// Siblings A and B are pinned to identical baseline values; only the tested
// V-A dimension differs.  prewarm.topConcepts ordering reflects V-A.
// ---------------------------------------------------------------------------

describe("Group 2 — RANKING EFFECT: V-A signals reorder prewarm.topConcepts", () => {
  /**
   * 2.1 — Usefulness BOOST
   *
   * Both siblings start at usefulness_score = 0.
   * B is fetched 5× via the real getConcept API → usefulness_score = 5.
   * A is left unfetched → usefulness_score = 0.
   * Then baseline fields are pinned identically.  B must rank before A.
   *
   * livingModelScore = confidence × (1 + usefulnessDecayed) × recency × (1 + 0.5×arousal)
   * arousal=0 for both, so only the (1 + usefulnessDecayed) term differs.
   * B: (1 + 5×exp(~0)) ≈ 6  vs  A: (1 + 0) = 1  → B wins by 6×.
   *
   * Fails with V-A off: both would score identically (usefulness term removed → 1×1=1 each),
   * and tiebreak falls to id — ordering would not be guaranteed to match.
   */
  it("2.1 usefulness boost: fetched concept outranks unfetched sibling", async () => {
    // idGen: loser (A) created first → smaller id (tiebreak-winning).
    //         winner (B) created second → larger id (tiebreak-LOSING).
    // V-A ON:  B's usefulness boost overcomes the adverse tiebreak → B ranks first ✓
    // V-A OFF: scores tie → id-asc tiebreak puts A first → assertion fails ✓ (discriminates)
    let _n = 0;
    const idGen = () => `c-${String(++_n).padStart(4, "0")}`;
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 365 * 86_400_000,
      idGen,
    });

    const rA = await core.store("Sibling A — usefulness boost test."); // gets c-0001 (smaller, tiebreak-winning)
    const rB = await core.store("Sibling B — usefulness boost test."); // gets c-0002 (larger, tiebreak-LOSING)

    // Fetch B five times with the real API (not raw UPDATE) — this is the driver under test.
    for (let i = 0; i < 5; i++) {
      await core.getConcept(rB.conceptId, { synthesize: false });
    }

    // Now pin both siblings to identical baseline so the only difference is the usefulness_score
    // that getConcept already wrote.  We read B's fetched_at to carry it through.
    const bVa = vaRow(core, rB.conceptId);
    const now = Date.now();
    const baselineLca = now - 1_000; // 1 s ago — equal age

    pin(core, rA.conceptId, {
      confidence: 0.6,
      supportCount: 1,
      lastConfirmedAt: baselineLca,
      usefulnessScore: 0,
      usefulnessFetchedAt: null,
      arousalScore: 0,
      arousalUpdatedAt: null,
    });
    pin(core, rB.conceptId, {
      confidence: 0.6,
      supportCount: 1,
      lastConfirmedAt: baselineLca,
      usefulnessScore: bVa.usefulness_score, // 5 from getConcept calls
      usefulnessFetchedAt: bVa.usefulness_last_fetched_at, // preserve the real fetch ts
      arousalScore: 0,
      arousalUpdatedAt: null,
    });

    const top = core.prewarm("default", { conceptLimit: 10 }).topConcepts;
    const ids = top.map((c) => c.id);

    console.log(
      `[2.1 usefulness boost] ordering: ${ids.map((id, i) => {
        const label = id === rB.conceptId ? "B" : id === rA.conceptId ? "A" : id;
        return `#${i + 1}:${label}`;
      }).join(" ")}`,
    );

    expect(ids).toContain(rA.conceptId);
    expect(ids).toContain(rB.conceptId);
    // Polarity guard: winner B must hold the larger id so tiebreak opposes this assertion.
    // Green can only come from V-A — the tiebreak alone would put A (smaller id) first.
    expect(rB.conceptId > rA.conceptId).toBe(true); // tiebreak opposes the V-A assertion
    // B (usefulness_score=5) must rank before A (usefulness_score=0).
    expect(ids.indexOf(rB.conceptId)).toBeLessThan(ids.indexOf(rA.conceptId));

    core.close();
  });

  /**
   * 2.2 — Usefulness DECAY
   *
   * Both siblings get usefulness_score = 5 (equal raw score).
   * A's usefulness_last_fetched_at = now (fresh fetch).
   * B's usefulness_last_fetched_at = 180 days ago (decayed: exp(-180/60) = exp(-3) ≈ 0.050).
   *
   * A: usefulnessDecayed = 5 × 1.0 = 5.0  → (1 + 5.0) = 6.0
   * B: usefulnessDecayed = 5 × 0.05 = 0.25 → (1 + 0.25) = 1.25
   *
   * A ranks before B by a factor of ~4.8.
   *
   * Fails with V-A off: both would score identically (usefulness term removed), tiebreak by id.
   */
  it("2.2 usefulness decay: freshly-fetched ranks above same-score concept with stale fetch timestamp", async () => {
    // idGen: loser (B) created first → smaller id (tiebreak-winning).
    //         winner (A) created second → larger id (tiebreak-LOSING).
    // V-A ON:  A's fresh-fetch usefulness overcomes the adverse tiebreak → A ranks first ✓
    // V-A OFF: scores tie → id-asc tiebreak puts B first → assertion fails ✓ (discriminates)
    let _n = 0;
    const idGen = () => `c-${String(++_n).padStart(4, "0")}`;
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 365 * 86_400_000,
      idGen,
    });

    // IMPORTANT: B (loser) is stored FIRST so it gets the smaller id (tiebreak-winning).
    //            A (winner) is stored SECOND so it gets the larger id (tiebreak-LOSING).
    const rB = await core.store("Sibling B — usefulness decay test."); // gets c-0001 (smaller, tiebreak-winning)
    const rA = await core.store("Sibling A — usefulness decay test."); // gets c-0002 (larger, tiebreak-LOSING)

    const now = Date.now();
    const baselineLca = now - 1_000; // 1 s ago — equal recency
    const staleFetchTs = now - 180 * 86_400_000; // 180 days ago — heavy decay

    // Both siblings: equal confidence, support, recency.
    // Same raw usefulness_score = 5.
    // Difference: A has a fresh fetch timestamp (now), B has a stale one (180d ago).
    pin(core, rA.conceptId, {
      confidence: 0.6,
      supportCount: 1,
      lastConfirmedAt: baselineLca,
      usefulnessScore: 5,
      usefulnessFetchedAt: now,
      arousalScore: 0,
      arousalUpdatedAt: null,
    });
    pin(core, rB.conceptId, {
      confidence: 0.6,
      supportCount: 1,
      lastConfirmedAt: baselineLca,
      usefulnessScore: 5,
      usefulnessFetchedAt: staleFetchTs, // 180d old → exp(-180/60) ≈ 0.050
      arousalScore: 0,
      arousalUpdatedAt: null,
    });

    const top = core.prewarm("default", { conceptLimit: 10 }).topConcepts;
    const ids = top.map((c) => c.id);

    console.log(
      `[2.2 usefulness decay] ordering: ${ids.map((id, i) => {
        const label = id === rA.conceptId ? "A(fresh)" : id === rB.conceptId ? "B(stale)" : id;
        return `#${i + 1}:${label}`;
      }).join(" ")}`,
    );

    expect(ids).toContain(rA.conceptId);
    expect(ids).toContain(rB.conceptId);
    // Polarity guard: winner A must hold the larger id so tiebreak opposes this assertion.
    // Green can only come from V-A — the tiebreak alone would put B (smaller id) first.
    expect(rA.conceptId > rB.conceptId).toBe(true); // tiebreak opposes the V-A assertion
    // A (fresh fetch) must rank before B (stale fetch, same raw score).
    expect(ids.indexOf(rA.conceptId)).toBeLessThan(ids.indexOf(rB.conceptId));

    core.close();
  });

  /**
   * 2.3 — Arousal BOOST
   *
   * A: arousal_score = 0.
   * B: arousal_score = 3 (raw, pinned directly).
   * B's arousal_last_updated_at = now (fresh → exp(-0/120) = 1.0, no decay).
   *
   * effectiveArousal(B) = max(3×0.1, 3×1.0) = 3.0
   * livingModelScore boost on B: (1 + 0.5×3.0) = 2.5 vs A: (1 + 0.5×0) = 1.0  → B wins 2.5×.
   *
   * Fails with AROUSAL_WEIGHT_LIVING zeroed: both equal → tiebreak by id, ordering not guaranteed.
   */
  it("2.3 arousal boost: concept with arousal outranks zero-arousal sibling", async () => {
    // idGen: loser (A) created first → smaller id (tiebreak-winning).
    //         winner (B) created second → larger id (tiebreak-LOSING).
    // V-A ON:  B's arousal boost overcomes the adverse tiebreak → B ranks first ✓
    // V-A OFF: scores tie → id-asc tiebreak puts A first → assertion fails ✓ (discriminates)
    let _n = 0;
    const idGen = () => `c-${String(++_n).padStart(4, "0")}`;
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 365 * 86_400_000,
      idGen,
    });

    const rA = await core.store("Sibling A — arousal boost test."); // gets c-0001 (smaller, tiebreak-winning)
    const rB = await core.store("Sibling B — arousal boost test."); // gets c-0002 (larger, tiebreak-LOSING)

    const now = Date.now();
    const baselineLca = now - 1_000;

    // Pin identically except arousal.
    pin(core, rA.conceptId, {
      confidence: 0.6,
      supportCount: 1,
      lastConfirmedAt: baselineLca,
      usefulnessScore: 0,
      usefulnessFetchedAt: null,
      arousalScore: 0,
      arousalUpdatedAt: null,
    });
    pin(core, rB.conceptId, {
      confidence: 0.6,
      supportCount: 1,
      lastConfirmedAt: baselineLca,
      usefulnessScore: 0,
      usefulnessFetchedAt: null,
      arousalScore: 3, // pinned directly — no flagContradiction needed, avoids status side-effect
      arousalUpdatedAt: now,
    });

    const top = core.prewarm("default", { conceptLimit: 10 }).topConcepts;
    const ids = top.map((c) => c.id);

    console.log(
      `[2.3 arousal boost] ordering: ${ids.map((id, i) => {
        const label = id === rB.conceptId ? "B(arousal=3)" : id === rA.conceptId ? "A(arousal=0)" : id;
        return `#${i + 1}:${label}`;
      }).join(" ")}`,
    );

    expect(ids).toContain(rA.conceptId);
    expect(ids).toContain(rB.conceptId);
    // Polarity guard: winner B must hold the larger id so tiebreak opposes this assertion.
    // Green can only come from V-A — the tiebreak alone would put A (smaller id) first.
    expect(rB.conceptId > rA.conceptId).toBe(true); // tiebreak opposes the V-A assertion
    // B (arousal=3, fresh) must rank before A (arousal=0).
    expect(ids.indexOf(rB.conceptId)).toBeLessThan(ids.indexOf(rA.conceptId));

    core.close();
  });

  /**
   * 2.4 — Arousal FLOOR (V-A's signature discriminator)
   *
   * B has high cumulative arousal (arousal_score = 9, from 3 flagContradiction events = 3×3).
   * B's arousal_last_updated_at is backdated 400 days — well past the ~276-day floor crossover
   * (where 10% floor > pure-decay: floor crossover = tau × ln(1/FLOOR_FRAC) = 120×ln(10) ≈ 276d).
   *
   * Math at 400 days:
   *   pure decay:  9 × exp(-400/120) = 9 × exp(-3.33) ≈ 9 × 0.036 = 0.324
   *   floor:       9 × 0.1 = 0.90
   *   effectiveArousal = max(0.90, 0.324) = 0.90  ← floor dominates
   *   boost(B): (1 + 0.5 × 0.90) = 1.45×
   *   boost(A): (1 + 0.5 × 0.0)  = 1.00×
   *
   * B STILL outranks A despite 400 days of idle time.
   *
   * Without the floor (pure decay only):
   *   effectiveArousal = 0.324 → boost = 1.162× vs A 1.00× — B still wins slightly, but this
   *   confirms the floor mechanism is what makes the margin decisive.  The critical discriminating
   *   assertion is that B ranks above A at 400 days: with the floor this is clearly true (1.45×
   *   factor); without any arousal weight the ordering reverts to id tiebreak.
   *
   * Fails with AROUSAL_WEIGHT_LIVING zeroed: both concepts score equally → tiebreak by id.
   */
  it("2.4 arousal floor: high-arousal concept retains ranking advantage after 400 days (floor > pure decay)", async () => {
    // idGen: loser (A) created first → smaller id (tiebreak-winning).
    //         winner (B) created second → larger id (tiebreak-LOSING).
    // V-A ON:  B's arousal floor boost (1.45×) overcomes the adverse tiebreak → B ranks first ✓
    // V-A OFF: scores tie → id-asc tiebreak puts A first → assertion fails ✓ (discriminates)
    let _n = 0;
    const idGen = () => `c-${String(++_n).padStart(4, "0")}`;
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 365 * 2 * 86_400_000, // 2 years so nothing goes stale
      idGen,
    });

    const rA = await core.store("Sibling A — arousal floor test."); // gets c-0001 (smaller, tiebreak-winning)
    const rB = await core.store("Sibling B — arousal floor test."); // gets c-0002 (larger, tiebreak-LOSING)

    const now = Date.now();
    const baselineLca = now - 1_000; // 1 s ago — equal recency
    const arousalTs400dAgo = now - 400 * 86_400_000; // 400 days ago

    // Pin identically except arousal.
    // A: zero arousal.
    // B: arousal_score=9, last updated 400d ago.
    //   Floor calculation: max(9×0.1, 9×exp(-400/120)) = max(0.9, 0.324) = 0.9
    //   Boost: (1 + 0.5 × 0.9) = 1.45× — B still leads A (1.0×) by 45%.
    pin(core, rA.conceptId, {
      confidence: 0.6,
      supportCount: 1,
      lastConfirmedAt: baselineLca,
      usefulnessScore: 0,
      usefulnessFetchedAt: null,
      arousalScore: 0,
      arousalUpdatedAt: null,
    });
    pin(core, rB.conceptId, {
      confidence: 0.6,
      supportCount: 1,
      lastConfirmedAt: baselineLca,
      usefulnessScore: 0,
      usefulnessFetchedAt: null,
      arousalScore: 9, // 3 × flagContradiction worth of arousal
      arousalUpdatedAt: arousalTs400dAgo, // 400d idle — past the ~276d floor crossover
    });

    const topBefore = core.prewarm("default", { conceptLimit: 10 }).topConcepts;
    const idsBefore = topBefore.map((c) => c.id);
    console.log(
      `[2.4 arousal floor] ordering AFTER 400d idle (floor should dominate): ${idsBefore
        .map((id, i) => {
          const label =
            id === rB.conceptId
              ? "B(arousal=9,400d)"
              : id === rA.conceptId
                ? "A(arousal=0)"
                : id;
          return `#${i + 1}:${label}`;
        })
        .join(" ")}`,
    );
    console.log(
      `[2.4 arousal floor] math: pure decay = 9×exp(-400/120)=${(9 * Math.exp(-400 / 120)).toFixed(3)}, ` +
        `floor = 9×0.1=0.9, effectiveArousal=0.9 → boost=(1+0.5×0.9)=1.45× vs A=1.00×`,
    );

    expect(idsBefore).toContain(rA.conceptId);
    expect(idsBefore).toContain(rB.conceptId);
    // Polarity guard: winner B must hold the larger id so tiebreak opposes this assertion.
    // Green can only come from V-A — the tiebreak alone would put A (smaller id) first.
    expect(rB.conceptId > rA.conceptId).toBe(true); // tiebreak opposes the V-A assertion
    // B STILL ranks before A at 400d — the floor keeps it on top.
    expect(idsBefore.indexOf(rB.conceptId)).toBeLessThan(idsBefore.indexOf(rA.conceptId));

    core.close();
  });
});

// ---------------------------------------------------------------------------
// Group 3 — gather nodePrior arousal effect
// ---------------------------------------------------------------------------

/**
 * Stub embedder for Group 3.
 *
 * Returns unit vectors keyed on exact text strings so we can control the
 * gather topology precisely:
 *
 *   e1 = [1, 0, 0, 0, 0, 0, 0, 0]  — query text and SEED concept text
 *   e2 = [0, 1, 0, 0, 0, 0, 0, 0]  — sibling A and sibling B texts
 *
 * cos(e1, e1) = 1.0  → SEED gets cosine > 0 → enters `sim` → viaSeed=true
 * cos(e1, e2) = 0.0  → A and B get cosine = 0 → excluded from `sim`
 *                       → forced onto the pure-graph path → viaSeed=false
 *
 * A and B share e2 so their cosine to the query is identically 0;
 * only their nodePrior (driven by arousal) distinguishes their scores.
 */
const DIM = 8;
const E1 = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
const E2 = new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]);

const SEED_TEXT = "xyzzy-seed-concept-arousal-group3";
const QUERY_TEXT = SEED_TEXT; // query == seed text → cos=1, enters sim → viaSeed=true
const SIBLING_A_TEXT = "frobnitz-sibling-alpha-arousal-group3";
const SIBLING_B_TEXT = "frobnitz-sibling-beta-arousal-group3";

function makeStubEmbedder(): import("../embedding").EmbeddingProvider {
  return {
    modelId: "test:va-ranking-group3:dim=8",
    dim: DIM,
    embed(text: string): Float32Array {
      if (text === SEED_TEXT || text === QUERY_TEXT) return E1;
      if (text === SIBLING_A_TEXT || text === SIBLING_B_TEXT) return E2;
      // Fallback: zero vector — cosine=0, won't enter sim
      return new Float32Array(DIM);
    },
  };
}

describe("Group 3 — gather nodePrior arousal effect", () => {
  /**
   * 3.1 — Mechanism (robust; must-have)
   *
   * Validates that arousal_score is wired into nodePrior, independent of
   * gather topology.  A and B are pinned identically on every field EXCEPT
   * arousal: A=0, B=3 (fresh).
   *
   * nodePrior factor for B:  (1 + 0.3 × effectiveArousal) = (1 + 0.3×3) = 1.9
   * nodePrior factor for A:  (1 + 0.3 × 0)               = 1.0
   * → nodePrior(B) > nodePrior(A) by 1.9×.
   *
   * Polarity guard: B gets the larger id (tiebreak-losing), so the assertion
   * can only pass because the arousal term actually exists and is positive.
   */
  it("3.1 nodePrior arousal mechanism: nodePrior(B, arousal=3) > nodePrior(A, arousal=0)", async () => {
    let _n = 0;
    const idGen = () => `c-${String(++_n).padStart(4, "0")}`;
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 365 * 86_400_000,
      idGen,
    });

    // A created first → smaller id (c-0001); B second → larger id (c-0002).
    // B holds the tiebreak-losing id — passes only via arousal.
    const rA = await core.store("Sibling A — nodePrior arousal mechanism test.");
    const rB = await core.store("Sibling B — nodePrior arousal mechanism test.");

    const now = Date.now();
    const baselineLca = now - 1_000;

    pin(core, rA.conceptId, {
      confidence: 0.7,
      supportCount: 5,
      lastConfirmedAt: baselineLca,
      usefulnessScore: 0,
      usefulnessFetchedAt: null,
      arousalScore: 0,
      arousalUpdatedAt: null,
    });
    pin(core, rB.conceptId, {
      confidence: 0.7,
      supportCount: 5,
      lastConfirmedAt: baselineLca,
      usefulnessScore: 0,
      usefulnessFetchedAt: null,
      arousalScore: 3, // fresh → effectiveArousal=3 → factor (1+0.3×3)=1.9
      arousalUpdatedAt: now,
    });

    // Polarity guard: B must hold the larger id.
    expect(rB.conceptId > rA.conceptId).toBe(true);

    const priorA = (core as any).nodePrior(rA.conceptId) as number;
    const priorB = (core as any).nodePrior(rB.conceptId) as number;

    console.log(
      `[3.1 nodePrior mechanism] nodePrior(A,arousal=0)=${priorA.toFixed(5)}, ` +
        `nodePrior(B,arousal=3)=${priorB.toFixed(5)}, ratio=${(priorB / priorA).toFixed(3)}`,
    );

    expect(priorB).toBeGreaterThan(priorA);

    core.close();
  });

  /**
   * 3.2 — Integration (headline)
   *
   * Validates that arousal reorders real gather() output on the pure-graph
   * (viaSeed=false) path.
   *
   * Topology:
   *   SEED S  (text → e1, cosine=1 to query → viaSeed=true, enters sim)
   *     │ co_occurred
   *   ──┼──────────────
   *     ├─→ A  (text → e2, cosine=0 → viaSeed=false; arousal_score=0)
   *     └─→ B  (text → e2, cosine=0 → viaSeed=false; arousal_score=3 fresh)
   *
   * Activation reaching A and B (one hop from S):
   *   delta = seedStrength(S) × gamma × wType['co_occurred'] × edgeWeight
   *         = 1.0 × 0.5 × 0.85 × 0.85 ≈ 0.361
   *   (A and B receive equal activation — only nodePrior differs)
   *
   * score = beta × activation × nodePrior^priorExp
   *       = 0.6 × 0.361 × nodePrior^0.5
   *
   * nodePrior(A): 0.7 × log1p(5) × 1 × 1.0 ≈ 1.254  → score ≈ 0.243
   * nodePrior(B): 0.7 × log1p(5) × 1 × 1.9 ≈ 2.383  → score ≈ 0.335  (+38%)
   * includeFloor: 0.1 — both clear it comfortably.
   *
   * B holds the larger id (tiebreak-losing): a green assertion requires the
   * arousal boost to genuinely overcome the id tiebreak.
   */
  it("3.2 gather arousal integration: high-arousal sibling ranks above zero-arousal sibling via pure-graph path", async () => {
    let _n = 0;
    const idGen = () => `c-${String(++_n).padStart(4, "0")}`;
    const embedder = makeStubEmbedder();

    const core = new MonetCore(":memory:", {
      embedder,
      idGen,
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 365 * 86_400_000,
    });

    // Store S first (c-0001), then A (c-0002), then B (c-0003).
    // A < B ensures B is the tiebreak-losing id — the assertion can only pass via arousal.
    const rS = await core.store(SEED_TEXT);   // c-0001
    const rA = await core.store(SIBLING_A_TEXT); // c-0002 (smaller id, tiebreak-winning)
    const rB = await core.store(SIBLING_B_TEXT); // c-0003 (larger id, tiebreak-LOSING)

    // store() auto-creates co_occurred edges between all three (same session).
    // We also call upsertEdgeBoth explicitly for S→A and S→B to be explicit
    // and robust if the session auto-wiring had already done it (idempotent).
    (core as any).upsertEdgeBoth(rS.conceptId, rA.conceptId, "co_occurred", 0.85, "test", "default");
    (core as any).upsertEdgeBoth(rS.conceptId, rB.conceptId, "co_occurred", 0.85, "test", "default");

    const now = Date.now();
    const baselineLca = now - 1_000;

    // Pin A and B identically on every ranking input except arousal.
    // confidence=0.7, support=5 so nodePrior >> includeFloor on both.
    pin(core, rA.conceptId, {
      confidence: 0.7,
      supportCount: 5,
      lastConfirmedAt: baselineLca,
      usefulnessScore: 0,
      usefulnessFetchedAt: null,
      arousalScore: 0,
      arousalUpdatedAt: null,
    });
    pin(core, rB.conceptId, {
      confidence: 0.7,
      supportCount: 5,
      lastConfirmedAt: baselineLca,
      usefulnessScore: 0,
      usefulnessFetchedAt: null,
      arousalScore: 3, // fresh → effectiveArousal=3 → nodePrior factor 1.9
      arousalUpdatedAt: now,
    });

    const { ranked } = await core.gather(QUERY_TEXT, { limit: 10, depth: 2 });

    const ids = ranked.map((c) => c.id);
    const scoreMap = new Map(ranked.map((c) => [c.id, c.score]));

    console.log(
      `[3.2 gather arousal integration] ranked: ${ranked
        .map((c, i) => {
          const label =
            c.id === rB.conceptId
              ? "B(arousal=3)"
              : c.id === rA.conceptId
                ? "A(arousal=0)"
                : c.id === rS.conceptId
                  ? "S(seed)"
                  : c.id;
          return `#${i + 1}:${label}(score=${c.score.toFixed(4)},viaSeed=${c.viaSeed})`;
        })
        .join(" ")}`,
    );

    // Floor sanity: both A and B must be present and on the pure-graph path.
    // If either is missing, it dropped below includeFloor — the test config needs adjustment.
    expect(ids).toContain(rA.conceptId);
    expect(ids).toContain(rB.conceptId);
    const cardA = ranked.find((c) => c.id === rA.conceptId)!;
    const cardB = ranked.find((c) => c.id === rB.conceptId)!;
    expect(cardA.viaSeed).toBe(false);
    expect(cardB.viaSeed).toBe(false);

    // Polarity guard: B holds the larger (tiebreak-losing) id.
    expect(rB.conceptId > rA.conceptId).toBe(true);

    // The headline assertion: arousal boost on B must overcome the tiebreak.
    expect(scoreMap.get(rB.conceptId)!).toBeGreaterThan(scoreMap.get(rA.conceptId)!);
    expect(ids.indexOf(rB.conceptId)).toBeLessThan(ids.indexOf(rA.conceptId));

    core.close();
  });
});
