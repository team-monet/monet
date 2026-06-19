/**
 * V-A weighting slice 1: USEFULNESS_DECAY_TAU_DAYS
 *
 * Tests in this file:
 *
 * D.1 — livingModelScore ordering with decay
 *   D.1a: old high-usefulness concept ranks BELOW a freshly-confirmed low-usefulness concept.
 *         NOTE: recency (exp(-ageDays/14)) also discriminates here because the ages differ
 *         (120d vs 0d). This test verifies the combined scoring produces the correct ordering
 *         but does NOT isolate the usefulness-decay multiplier — reverting that term still
 *         produces the right ordering because recency alone dominates at 120d.
 *   D.1b: same-age scenario — high usefulness still leads when both equally old (checks
 *         that tau=60 is not over-aggressive; recency is equal so usefulness dominates).
 *
 * D.2 — nodePrior ordering with decay
 *   Same combined-score ordering check through the nodePrior path. Recency (exp(-ageDays/30))
 *   also discriminates because ages differ (120d vs 0d); not a pure isolation of the
 *   usefulness-decay multiplier.
 *
 * D.3 — nodePrior value pin (genuine decay-multiplier mutation check)
 *   Creates a concept with known usefulness_score and a pinned 30-day age, then asserts the
 *   returned nodePrior value matches the DECAYED formula within tolerance. Reverting the
 *   exp(-ageDays/USEFULNESS_DECAY_TAU_DAYS) multiplier to 1 changes the value by ~18%,
 *   outside the ±2% tolerance → test FAILS without the multiplier, PASSES with it.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawDb(core: MonetCore): import("../storage").StoragePort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (core as any).db as import("../storage").StoragePort;
}

// USEFULNESS_DECAY_TAU_DAYS = 60 days.
// We set the "old" concept's age to 120 days so exp(-120/60) = exp(-2) ≈ 0.135 — heavy decay.
// The "new" concept's age is 0 days so exp(0) = 1 — no decay.
//
// Concept A: usefulness_score = 20, age = 120 days
//   decayed usefulness = 20 * 0.135 ≈ 2.7  → (1 + 2.7) = 3.7
//   WITHOUT decay: (1 + 20) = 21 → would rank first
//
// Concept B: usefulness_score = 3, age = 0 days
//   decayed usefulness = 3 * 1.0 = 3.0     → (1 + 3.0) = 4.0
//   WITHOUT decay: (1 + 3)  = 4  → would rank second
//
// WITH decay: B (4.0) > A (3.7) — B wins
// WITHOUT decay: A (21) > B (4) — A wins
// This is the discriminating scenario.
const HIGH_USEFULNESS = 20;
const LOW_USEFULNESS = 3;
const OLD_AGE_DAYS = 120;

describe("D.1 — livingModelScore usefulness decay discriminates (prewarm.topConcepts)", () => {
  it("old high-usefulness concept ranks BELOW freshly-confirmed low-usefulness concept after decay", async () => {
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 365 * 86_400_000, // 1 year — keep both concepts in topConcepts
    });
    const db = rawDb(core);

    // A: high usefulness, old confirmation
    const rA = await core.store("Concept A: frequently fetched long ago.");
    // B: low usefulness, confirmed just now (timestamps stay at creation time, i.e. now)
    const rB = await core.store("Concept B: recently confirmed, rarely fetched.");

    const now = Date.now();
    const oldConfirmed = now - OLD_AGE_DAYS * 86_400_000;

    // Pin A: old last_confirmed_at + old updated_at (age = 120 days), high usefulness
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, updated_at = ?, usefulness_score = ? WHERE id = ?`).run(
      oldConfirmed, oldConfirmed, HIGH_USEFULNESS, rA.conceptId,
    );
    // Pin B: now (age = 0), low usefulness
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, updated_at = ?, usefulness_score = ? WHERE id = ?`).run(
      now, now, LOW_USEFULNESS, rB.conceptId,
    );

    const top = core.prewarm("default").topConcepts;
    const ids = top.map((c) => c.id);

    // Both concepts are within the 1-year stale window.
    expect(ids).toContain(rA.conceptId);
    expect(ids).toContain(rB.conceptId);

    // WITH decay: B (1 + 3*1) * recency(0) > A (1 + 20*0.135) * recency(120)
    // The recency factor (exp(-ageDays/14)) already penalises A heavily, but the
    // discrimination test is that usefulness decay CONTRIBUTES to the correct ordering.
    // To isolate the usefulness decay contribution, we verify B outranks A:
    expect(ids.indexOf(rB.conceptId)).toBeLessThan(ids.indexOf(rA.conceptId));

    core.close();
  });

  /**
   * Same-age sanity: both concepts aged 30 days → equal recency, equal usefulness-decay factor.
   * A (usefulness=20) still outranks B (usefulness=3) because (1 + 20*factor) > (1 + 3*factor)
   * regardless of the factor value. Guards against tau=60 being set so aggressively that
   * high usefulness is erased within 30 days.
   *
   * This is NOT a decay-multiplier mutation check — reverting the multiplier to 1 still
   * keeps A above B (usefulness spread is always positive). See D.3 for the genuine pin.
   */
  it("same-age scenario — high usefulness still leads when both equally old (tau=60 not over-aggressive)", async () => {
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 365 * 86_400_000,
    });
    const db = rawDb(core);

    const rA = await core.store("Concept A: high usefulness.");
    const rB = await core.store("Concept B: low usefulness.");

    const now = Date.now();
    // Both confirmed at the same moderate age (30 days): equal recency, equal usefulness decay factor.
    // A still wins because usefulness_score dominates: (1 + 20*factor) vs (1 + 3*factor).
    const thirtyDaysAgo = now - 30 * 86_400_000;
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, updated_at = ?, usefulness_score = ? WHERE id = ?`).run(
      thirtyDaysAgo, thirtyDaysAgo, HIGH_USEFULNESS, rA.conceptId,
    );
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, updated_at = ?, usefulness_score = ? WHERE id = ?`).run(
      thirtyDaysAgo, thirtyDaysAgo, LOW_USEFULNESS, rB.conceptId,
    );

    const top = core.prewarm("default").topConcepts;
    const ids = top.map((c) => c.id);

    // Same-age, high usefulness still dominates: A before B.
    expect(ids.indexOf(rA.conceptId)).toBeLessThan(ids.indexOf(rB.conceptId));

    core.close();
  });
});

describe("D.2 — nodePrior usefulness decay discriminates", () => {
  it("old high-usefulness concept has lower nodePrior than recently-confirmed low-usefulness concept", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const db = rawDb(core);

    const rA = await core.store("Concept A: frequently fetched, confirmed long ago.");
    const rB = await core.store("Concept B: rarely fetched, confirmed recently.");

    const now = Date.now();
    const oldConfirmed = now - OLD_AGE_DAYS * 86_400_000;

    // A: old, high usefulness
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, updated_at = ?, usefulness_score = ? WHERE id = ?`).run(
      oldConfirmed, oldConfirmed, HIGH_USEFULNESS, rA.conceptId,
    );
    // B: fresh, low usefulness — support_count equal (both have 1 observation from store())
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, updated_at = ?, usefulness_score = ? WHERE id = ?`).run(
      now, now, LOW_USEFULNESS, rB.conceptId,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priorA = (core as any).nodePrior(rA.conceptId) as number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const priorB = (core as any).nodePrior(rB.conceptId) as number;

    // Combined-score ordering: recency (exp(-ageDays/30)) also discriminates because ages differ
    // (120d vs 0d). B wins due to the combined recency + usefulness-decay penalty on A.
    // NOTE: reverting the usefulness-decay multiplier to 1 would still let B win here because
    // recency alone dominates at 120d. This is an ordering check, not a decay-term pin.
    // See D.3 for the genuine value-level mutation check.
    expect(priorB).toBeGreaterThan(priorA);

    core.close();
  });
});

describe("D.3 — nodePrior value pin (genuine decay-multiplier mutation check)", () => {
  /**
   * Pins the nodePrior return value for a concept with:
   *   usefulness_score = 20, support_count = 0, confidence = 0.6 (DB default), age = 30 days.
   *
   * Expected (with decay multiplier exp(-ageDays/USEFULNESS_DECAY_TAU_DAYS)):
   *   usefulnessDecayed = 20 * exp(-30/60) = 20 * exp(-0.5) ≈ 12.13
   *   nodePrior = 0.6 * log1p(12.13 + 0) * exp(-30/30) ≈ 0.568
   *
   * Without the decay multiplier (reverted to 1):
   *   usefulnessDecayed = 20 * 1 = 20
   *   nodePrior = 0.6 * log1p(20 + 0) * exp(-30/30) ≈ 0.672
   *
   * The two values differ by ~18%, well outside the ±2% tolerance — so this test FAILS
   * if the exp(-ageDays/USEFULNESS_DECAY_TAU_DAYS) term is removed, and PASSES when it is present.
   *
   * Technique: pin last_confirmed_at = Date.now() - 30 * 86_400_000 and support_count = 0
   * via direct UPDATE, matching the pattern used throughout temporal.test.ts.
   */
  it("nodePrior matches the DECAYED formula within 2% tolerance — fails if decay multiplier is reverted to 1", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const db = rawDb(core);

    const r = await core.store("Concept for value-pin decay test.");

    const now = Date.now();
    const AGE_DAYS = 30;
    const pinnedLca = now - AGE_DAYS * 86_400_000;
    const USEFULNESS = 20;

    // Pin age to exactly 30 days, set usefulness_score = 20, support_count = 0.
    // Confidence stays at the DB DEFAULT (0.6) — not overridden here.
    db.prepare(
      `UPDATE concepts SET last_confirmed_at = ?, updated_at = ?, usefulness_score = ?, support_count = 0 WHERE id = ?`,
    ).run(pinnedLca, pinnedLca, USEFULNESS, r.conceptId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prior = (core as any).nodePrior(r.conceptId) as number;

    // USEFULNESS_DECAY_TAU_DAYS = 60, nodePrior recency TAU = 30.
    // Expected: 0.6 * log1p(20 * exp(-30/60)) * exp(-30/30)
    const CONFIDENCE = 0.6;
    const USEFULNESS_DECAY_TAU_DAYS = 60;
    const RECENCY_TAU_DAYS = 30;
    const usefulnessDecayed = USEFULNESS * Math.exp(-AGE_DAYS / USEFULNESS_DECAY_TAU_DAYS);
    const expected = CONFIDENCE * Math.log1p(usefulnessDecayed) * Math.exp(-AGE_DAYS / RECENCY_TAU_DAYS);

    // ±2% tolerance — tight enough to reject the undecayed formula (~18% off).
    const tolerance = expected * 0.02;
    expect(prior).toBeGreaterThan(expected - tolerance);
    expect(prior).toBeLessThan(expected + tolerance);

    core.close();
  });
});
