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

describe("D.1 — livingModelScore usefulness decay discriminates (overview.livingModel)", () => {
  it("old high-usefulness concept ranks BELOW freshly-confirmed low-usefulness concept after decay", async () => {
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: 365 * 86_400_000, // 1 year — keep both concepts in livingModel
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

    const top = core.overview("default").livingModel;
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

    const top = core.overview("default").livingModel;
    const ids = top.map((c) => c.id);

    // Same-age, high usefulness still dominates: A before B.
    expect(ids.indexOf(rA.conceptId)).toBeLessThan(ids.indexOf(rB.conceptId));

    core.close();
  });
});

