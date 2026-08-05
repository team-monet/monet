/**
 * 0.8.0 feature tests:
 *
 * A. stats(circle?) — circle-scoped stats with alias resolution.
 *    1. No-arg back-compat: store-wide counts, shape unchanged.
 *    2. Circle-filtered correctness across ≥2 circles.
 *    3. Alias resolution: renameCircle old→new, then stats(old) returns new circle's counts
 *       plus resolvedFrom.
 *    4. Unknown circle → zero counts, no throw.
 *    5. Workstream split correct per circle.
 *
 * B. Ranking divergence (livingModelScore uses last_confirmed_at).
 *    6. Concept A: confirmed long ago but structurally touched recently (updated_at fresh,
 *       last_confirmed_at old). Concept B: confirmed recently. Under new source B outranks A
 *       in overview.livingModel; under old source A would have ranked higher.
 *
 * C. nodePrior path (last_confirmed_at fallback).
 *    7. Direct divergence test via (core as any).nodePrior(): two concepts with equal structural
 *       scores but opposite last_confirmed_at vs updated_at profiles. Under the new source
 *       (last_confirmed_at ?? updated_at) the recently-confirmed concept wins; under the old
 *       source (updated_at) the recently-structurally-touched concept would win.
 */
import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

// ---- helpers -----------------------------------------------------------------

function freshCore(opts: ConstructorParameters<typeof MonetCore>[1] = {}): MonetCore {
  return new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1, ...opts });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawDb(core: MonetCore): import("../storage").StoragePort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (core as any).db as import("../storage").StoragePort;
}

// ---- A. stats(circle?) -------------------------------------------------------

describe("A.1 — stats() no-arg back-compat (store-wide shape unchanged)", () => {
  it("returns 5 numeric fields with no circle/resolvedFrom", async () => {
    const core = freshCore();
    await core.store("Concept one.", { circle: "alpha" });
    await core.store("Concept two.", { circle: "beta" });
    const s = core.stats();
    // Exact field set — must not have circle or resolvedFrom.
    expect(typeof s.concepts).toBe("number");
    expect(typeof s.observations).toBe("number");
    expect(typeof s.dirty).toBe("number");
    expect(typeof s.workstreams).toBe("number");
    expect(typeof s.sessions).toBe("number");
    expect((s as Record<string, unknown>).circle).toBeUndefined();
    expect((s as Record<string, unknown>).resolvedFrom).toBeUndefined();
    // Store-wide: both circles counted.
    expect(s.concepts).toBe(2);
    core.close();
  });

  it("sessions count comes from the sessions table (existing behavior)", async () => {
    const core = freshCore();
    await core.store("Some fact.");
    core.endSessionForEval();
    await core.store("Another fact after session end.");
    const s = core.stats();
    expect(s.sessions).toBe(2);
    core.close();
  });

  it("PINS sessions-count asymmetry: workstream-only session counts store-wide but not per-circle", async () => {
    // Asymmetry is intentional: the sessions table is not circle-keyed, so the only computable
    // per-circle definition is DISTINCT session_ids from observations. A session that only calls
    // saveWorkstream writes no observations, so it contributes to stats().sessions (store-wide,
    // sessions-table rows) but NOT to stats(circle).sessions (observation-contributing sessions only).
    // This mirrors overview()'s precedent. The asymmetry is a deliberate design choice.
    const core = freshCore();
    // Session 1: ONLY saveWorkstream — writes a session row but no observation rows.
    await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "plan step" }] }, { circle: "mycirc" });
    core.endSessionForEval();
    // Session 2: normal store — writes both a session row and an observation row.
    await core.store("Observed fact.", { circle: "mycirc" });
    core.endSessionForEval();

    // Store-wide stats see both sessions (sessions-table rows).
    expect(core.stats().sessions).toBe(2);
    // Per-circle stats see only the observation-contributing session.
    expect(core.stats("mycirc").sessions).toBe(1);
    core.close();
  });
});

describe("A.2 — stats(circle) circle-filtered correctness across ≥2 circles", () => {
  it("counts only concepts / observations / dirty / workstreams / sessions for the specified circle", async () => {
    const core = freshCore();
    // alpha gets 2 facts + 1 workstream.
    await core.store("Alpha fact one.", { circle: "alpha" });
    await core.store("Alpha fact two.", { circle: "alpha" });
    await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "alpha step" }] }, { circle: "alpha" });
    // beta gets 1 fact.
    await core.store("Beta fact.", { circle: "beta" });

    const alpha = core.stats("alpha");
    expect(alpha.circle).toBe("alpha");
    expect(alpha.concepts).toBe(2); // 2 facts (workstream excluded)
    expect(alpha.observations).toBe(2);
    expect(alpha.workstreams).toBe(1);
    expect(alpha.dirty).toBeGreaterThanOrEqual(0);
    expect(alpha.sessions).toBeGreaterThanOrEqual(1);
    expect((alpha as Record<string, unknown>).resolvedFrom).toBeUndefined();

    const beta = core.stats("beta");
    expect(beta.circle).toBe("beta");
    expect(beta.concepts).toBe(1);
    expect(beta.observations).toBe(1);
    expect(beta.workstreams).toBe(0);

    // Store-wide still reflects both.
    const all = core.stats();
    expect(all.concepts).toBe(3); // 2 + 1 (no workstreams)
    core.close();
  });
});

describe("A.3 — stats(old) after renameCircle resolves through alias + returns resolvedFrom", () => {
  it("stats(old-name) resolves to new circle's counts and carries resolvedFrom", async () => {
    const core = freshCore();
    await core.store("Archived knowledge.", { circle: "proj-old" });
    await core.store("More archived knowledge.", { circle: "proj-old" });

    // Rename the circle.
    core.renameCircle("proj-old", "proj-new");

    // stats with the OLD name should resolve through the alias.
    const s = core.stats("proj-old");
    expect(s.circle).toBe("proj-new");
    expect(s.resolvedFrom).toBe("proj-old");
    expect(s.concepts).toBe(2); // still sees the 2 concepts (now in proj-new)

    // stats with the NEW name directly: no resolvedFrom.
    const sNew = core.stats("proj-new");
    expect(sNew.circle).toBe("proj-new");
    expect((sNew as Record<string, unknown>).resolvedFrom).toBeUndefined();
    expect(sNew.concepts).toBe(2);

    core.close();
  });
});

describe("A.4 — stats(unknown-circle) → zero counts, no throw", () => {
  it("returns zero counts for an unknown circle without throwing", () => {
    const core = freshCore();
    let s: ReturnType<typeof core.stats>;
    expect(() => { s = core.stats("circle-that-does-not-exist"); }).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(s!.concepts).toBe(0);
    expect(s!.observations).toBe(0);
    expect(s!.dirty).toBe(0);
    expect(s!.workstreams).toBe(0);
    expect(s!.sessions).toBe(0);
    expect(s!.circle).toBe("circle-that-does-not-exist");
    core.close();
  });
});

describe("A.5 — workstream split correct per circle", () => {
  it("workstreams field counts only workstream-kind concepts, facts excluded", async () => {
    // saveWorkstream upserts a single workstream per circle (slug = 'workstream:<circle>').
    // So c1 has 1 workstream and 1 fact; c2 has 0 workstreams and 1 fact.
    const core = freshCore();
    await core.store("Fact in c1.", { circle: "c1" });
    await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "do X" }] }, { circle: "c1" });
    await core.store("Fact in c2.", { circle: "c2" });

    const s1 = core.stats("c1");
    expect(s1.workstreams).toBe(1);
    expect(s1.concepts).toBe(1); // the fact, not workstreams

    const s2 = core.stats("c2");
    expect(s2.workstreams).toBe(0);
    expect(s2.concepts).toBe(1);

    // Store-wide: workstreams=1, concepts=2 (both facts, no workstreams in count).
    const all = core.stats();
    expect(all.workstreams).toBe(1);
    expect(all.concepts).toBe(2);

    core.close();
  });
});

// ---- B. Ranking divergence (livingModelScore uses last_confirmed_at) ---------

describe("B.6 — livingModelScore ranking divergence: confirmed-recently beats structurally-touched-recently", () => {
  it("concept B (confirmed recently) outranks concept A (confirmed long ago but updated recently) in overview.livingModel", async () => {
    // Staleness window must be LARGER than concept A's confirmation age so both A and B stay
    // in the fresh (non-stale) pool and compete in livingModel. With a 14-day decay half-life,
    // 5 days of confirmation age gives meaningful decay (exp(-5/14) ≈ 0.70) but stays well
    // inside a 90-day stale window.
    const STALE_AFTER_MS = 90 * 86_400_000; // 90 days
    const core = new MonetCore(":memory:", {
      tauAttach: 1.1,
      tauAmbiguous: 1.1,
      staleAfterMs: STALE_AFTER_MS,
    });
    const db = rawDb(core);

    // Create concept A and concept B.
    const rA = await core.store("Concept A: some architectural fact about the system.");
    const rB = await core.store("Concept B: a freshly confirmed design decision.");

    const now = Date.now();
    // 5 days ago: within the 90-day stale window but meaningfully decayed under 14-day half-life.
    const fiveDaysAgo = now - 5 * 86_400_000;

    // Pin concept A: last_confirmed_at is 5 days ago (decayed), updated_at is NOW (as if synthesis
    // touched it recently). Under the OLD source (updated_at) ageDays ≈ 0 → ranks high.
    // Under the NEW source (last_confirmed_at) ageDays ≈ 5 → decayed recency → ranks below B.
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, updated_at = ? WHERE id = ?`).run(
      fiveDaysAgo, now, rA.conceptId,
    );

    // Pin concept B: both timestamps NOW (confirmed recently). Ranks high under both sources.
    db.prepare(`UPDATE concepts SET last_confirmed_at = ?, updated_at = ? WHERE id = ?`).run(
      now, now, rB.conceptId,
    );

    const top = core.overview("default").livingModel;
    const ids = top.map((c) => c.id);

    // Both concepts are non-stale (last_confirmed_at < 90 days old) → both in livingModel.
    expect(ids).toContain(rA.conceptId);
    expect(ids).toContain(rB.conceptId);

    // Give B a slightly older updated_at than A so the old source (updated_at) would rank A
    // first, but the new source (last_confirmed_at) ranks B first (B confirmed now, A 5 days ago).
    const slightlyOlder = now - 1000; // 1 second older updated_at for B
    db.prepare(`UPDATE concepts SET updated_at = ? WHERE id = ?`).run(slightlyOlder, rB.conceptId);

    // Re-run overview with the updated timestamps.
    const top2 = core.overview("default").livingModel;
    const ids2 = top2.map((c) => c.id);

    // Under OLD source (updated_at): A.updated_at=now > B.updated_at=now-1s → A ranks first.
    // Under NEW source (last_confirmed_at): B.last_confirmed_at=now > A.last_confirmed_at=5daysAgo → B ranks first.
    expect(ids2.indexOf(rB.conceptId)).toBeLessThan(ids2.indexOf(rA.conceptId));

    core.close();
  });
});

// ---- C. nodePrior direct divergence test ------------------------------------

describe("C.7 — nodePrior uses last_confirmed_at ?? updated_at (direct divergence)", () => {
  it("concept B (confirmed recently, updated long ago) beats concept A (updated recently, confirmed long ago)", async () => {
    // Two concepts: equal confidence, usefulness, and support (one observation each, no attaches,
    // no contradictions). Timestamps pinned via direct SQLite so the only variable is the
    // last_confirmed_at / updated_at profile.
    //
    // nodePrior calls Date.now() internally — not injectable — but 30-day-scale separation
    // dwarfs any millisecond drift between the pin and the call.
    //
    // Concept A: updated_at = now (structurally fresh), last_confirmed_at = 30 days ago (stale).
    //   Under NEW source: ageDays ≈ 30 → exp(-30/30) ≈ 0.368
    //   Under OLD source: ageDays ≈ 0  → exp(0)       ≈ 1.0
    //
    // Concept B: updated_at = 30 days ago (structurally stale), last_confirmed_at = now (fresh).
    //   Under NEW source: ageDays ≈ 0  → exp(0)       ≈ 1.0
    //   Under OLD source: ageDays ≈ 30 → exp(-30/30)  ≈ 0.368
    //
    // New source → B > A.  Old source → A > B.  Any revert of the nodePrior line fails this test.
    const core = freshCore();
    const db = rawDb(core);

    const rA = await core.store("Concept A: structurally touched recently, confirmed long ago.");
    const rB = await core.store("Concept B: confirmed recently, structurally untouched for a month.");

    const now = Date.now();
    const thirtyDaysAgo = now - 30 * 86_400_000;

    // A: updated_at = now, last_confirmed_at = 30 days ago.
    db.prepare(`UPDATE concepts SET updated_at = ?, last_confirmed_at = ? WHERE id = ?`).run(
      now, thirtyDaysAgo, rA.conceptId,
    );
    // B: updated_at = 30 days ago, last_confirmed_at = now.
    db.prepare(`UPDATE concepts SET updated_at = ?, last_confirmed_at = ? WHERE id = ?`).run(
      thirtyDaysAgo, now, rB.conceptId,
    );

    const priorA = (core as any).nodePrior(rA.conceptId) as number;
    const priorB = (core as any).nodePrior(rB.conceptId) as number;

    // Under the new source (last_confirmed_at ?? updated_at): B is confirmed now → B wins.
    expect(priorB).toBeGreaterThan(priorA);

    core.close();
  });
});
