import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MonetCore } from "../engine";

/**
 * Contradiction & correction lifecycle (#240, ADR §4.4): detect drift instead of silently
 * absorbing it. A kind="correction" that lands on an existing concept opens a conflict and
 * flips it to disputed; resolution mediates (never silent last-write-wins); staleness surfaces.
 */
const BASE = "We decided to use SQLite as the storage backend for Monet Local.";
const CORRECTION = "We decided NOT to use SQLite as the storage backend for Monet Local.";

/**
 * Is this specific observation superseded? getConcept().observations does NOT filter superseded
 * rows (engine.ts, the concept-observation read), so asserting on returned content cannot tell
 * whether a supersession happened. Ask the row.
 */
const isSuperseded = (core: MonetCore, observationId: string): boolean => {
  const row = (core as unknown as { db: { prepare(sql: string): { get(id: string): unknown } } }).db
    .prepare(`SELECT superseded_by FROM observations WHERE id = ?`)
    .get(observationId) as { superseded_by: string | null } | undefined;
  return row?.superseded_by != null;
};

/** Raw supersession pair for an observation — distinguishes "revived" (both null) from "terminal"
 * (superseded_at set, superseded_by null) from "superseded by a real successor" (both set). */
const supersessionOf = (core: MonetCore, observationId: string): { superseded_by: string | null; superseded_at: number | null } => {
  const row = (core as unknown as { db: { prepare(sql: string): { get(id: string): unknown } } }).db
    .prepare(`SELECT superseded_by, superseded_at FROM observations WHERE id = ?`)
    .get(observationId) as { superseded_by: string | null; superseded_at: number | null } | undefined;
  return row ?? { superseded_by: null, superseded_at: null };
};

/** Raw peek at contradictions.contradicted_observation_id — not surfaced on PrewarmContradiction. */
const contradictedObsOf = (core: MonetCore, contradictionId: string): string | null => {
  const row = (core as unknown as { db: { prepare(sql: string): { get(id: string): unknown } } }).db
    .prepare(`SELECT contradicted_observation_id FROM contradictions WHERE id = ?`)
    .get(contradictionId) as { contradicted_observation_id: string | null } | undefined;
  return row?.contradicted_observation_id ?? null;
};

async function disputed(): Promise<{ core: MonetCore; conceptId: string; contradictionId: string }> {
  const core = new MonetCore(":memory:");
  const a = await core.store(BASE);
  const corr = await core.store(CORRECTION, { kind: "correction" });
  expect(corr.conceptId).toBe(a.conceptId); // the correction attaches to the same concept
  expect(corr.contradiction).toBeDefined();
  return { core, conceptId: a.conceptId, contradictionId: corr.contradiction!.id };
}

describe("contradiction detection on store", () => {
  it("a correction that attaches flips the concept to disputed + decays confidence", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store(BASE);
    const before = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    expect(before.status).toBe("active");

    const corr = await core.store(CORRECTION, { kind: "correction" });
    expect(corr.contradiction?.status).toBe("open");

    const after = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    expect(after.status).toBe("disputed");
    expect(after.confidence).toBeLessThan(before.confidence); // decayed
    core.close();
  });

  it("a novel correction (no existing concept) just creates — nothing to contradict", async () => {
    const core = new MonetCore(":memory:");
    const r = await core.store("Totally unrelated: the office plants need watering on Mondays.", { kind: "correction" });
    expect(r.action).toBe("created");
    expect(r.contradiction).toBeUndefined();
    expect(core.getOpenContradictions()).toHaveLength(0);
    core.close();
  });
});

describe("contradictions are surfaced (prewarm + search card)", () => {
  it("an open contradiction shows in getOpenContradictions, prewarm, and the search card count", async () => {
    const { core, conceptId } = await disputed();
    expect(core.getOpenContradictions()).toHaveLength(1);

    const pw = core.prewarm();
    expect(pw.openContradictions).toHaveLength(1);
    expect(pw.openContradictions[0].conceptId).toBe(conceptId);
    expect(pw.topConcepts.map((t) => t.id)).not.toContain(conceptId); // disputed ⇒ not in the living-model top

    const hits = await core.search("sqlite storage backend");
    expect(hits.find((h) => h.id === conceptId)?.contradictions).toBe(1);
    core.close();
  });
});

describe("mediated resolution (never silent last-write-wins)", () => {
  it("stays disputed and keeps BOTH observations until explicitly resolved", async () => {
    const { core, conceptId } = await disputed();
    const c = (await core.getConcept(conceptId, { synthesize: false }))!;
    expect(c.status).toBe("disputed");
    expect(c.body.toLowerCase()).toContain("use sqlite"); // original evidence retained...
    expect(c.body).toContain("NOT to use SQLite"); // ...correction appended, not auto-applied
    core.close();
  });

  it("accept-new updates the concept, supersedes the losing observation, restores active", async () => {
    const { core, conceptId, contradictionId } = await disputed();
    expect(core.supersededObservationCount()).toBe(0);

    const resolvedRaw = core.resolveContradiction(contradictionId, {
      decision: "accept-new",
      body: "Monet Local does NOT use SQLite; the storage backend changed.",
      by: "agent",
    })!;
    // The contradiction was open — resolveContradiction returns a Concept (not alreadyClosed).
    expect("alreadyClosed" in resolvedRaw).toBe(false);
    const resolved = resolvedRaw as import("../engine").Concept;
    expect(resolved.status).toBe("active");
    expect(resolved.body).toContain("does NOT use SQLite");
    expect(core.getOpenContradictions()).toHaveLength(0);
    expect(core.supersededObservationCount()).toBe(1); // the prior observation lost
    expect(conceptId).toBe(resolved.id);
    core.close();
  });

  it("a verdict never supersedes evidence the contradiction does not name (3+ observations)", async () => {
    // THE BLAST-RADIUS REGRESSION. The fixture above builds exactly one prior, where "supersede
    // every other observation" and "supersede the single counterpart" are indistinguishable — which
    // is why this went unnoticed. With several independent findings on one concept (what automatic
    // resolution routinely produces), the old code superseded ALL of them on any verdict. Observed
    // live: one status correction destroyed six observations, four of them unrelated.
    const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 }); // force attach
    const base = await core.store(BASE);
    const findingA = await core.store("Unrelated finding A: the WAL checkpoint runs at 1000 pages.", { attachTo: base.conceptId });
    const findingB = await core.store("Unrelated finding B: the lock is connection-level, not advisory.", { attachTo: base.conceptId });
    const corr = await core.store(CORRECTION, { kind: "correction", attachTo: base.conceptId });
    expect(corr.contradiction).toBeDefined();
    expect(core.supersededObservationCount()).toBe(0);

    core.resolveContradiction(corr.contradiction!.id, {
      decision: "accept-new",
      body: "Storage backend changed; unrelated findings stand.",
      by: "agent",
    });

    // Nothing is superseded: with more than one prior, which one lost is simply not recorded.
    expect(core.supersededObservationCount()).toBe(0);

    // And every unrelated finding is still live evidence.
    const after = (await core.getConcept(base.conceptId, { synthesize: false }))!;
    const live = after.observations.map((o) => o.content).join("\n");
    expect(live).toContain("Unrelated finding A");
    expect(live).toContain("Unrelated finding B");
    expect(after.status).toBe("active");
    void findingA; void findingB;
    core.close();
  });

  it("a SECOND sequential correction still supersedes — superseded history is not a live prior (Codex P1)", async () => {
    // After one accepted correction the concept holds {superseded loser, active winner}. Counting
    // raw rows would see two "priors", call it ambiguous and supersede nothing — leaving the
    // contradicted claim live next to the accepted one. Only one prior is actually live.
    const { core, conceptId, contradictionId } = await disputed();
    core.resolveContradiction(contradictionId, { decision: "accept-new", body: "Not SQLite.", by: "agent" });
    expect(core.supersededObservationCount()).toBe(1);

    const second = await core.store("We decided to use Postgres as the storage backend for Monet Local.", {
      kind: "correction", attachTo: conceptId,
    });
    expect(second.contradiction).toBeDefined();
    core.resolveContradiction(second.contradiction!.id, { decision: "accept-new", body: "Postgres now.", by: "agent" });

    // The previous winner is now superseded too — one live prior was unambiguous.
    expect(core.supersededObservationCount()).toBe(2);
    const after = (await core.getConcept(conceptId, { synthesize: false }))!;
    expect(after.observations.map((o) => o.content).join("\n")).toContain("Postgres");
    core.close();
  });

  it("an ambiguous accept-new without a reconciled body is refused, not silently closed (Codex P1)", async () => {
    // Several live priors, nothing superseded, no body → nothing would record which claim won, yet
    // the concept would return to active. Silence presented as agreement.
    const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
    const base = await core.store(BASE);
    await core.store("Unrelated finding A: the WAL checkpoint runs at 1000 pages.", { attachTo: base.conceptId });
    const corr = await core.store(CORRECTION, { kind: "correction", attachTo: base.conceptId });

    expect(() =>
      core.resolveContradiction(corr.contradiction!.id, { decision: "accept-new", by: "agent" }),
    ).toThrow(/reconciled body/);

    // Refused means REFUSED: still disputed, still open, nothing superseded.
    expect(core.getOpenContradictions()).toHaveLength(1);
    expect(core.supersededObservationCount()).toBe(0);
    expect((await core.getConcept(base.conceptId, { synthesize: false }))!.status).toBe("disputed");

    // With a body it goes through.
    core.resolveContradiction(corr.contradiction!.id, { decision: "accept-new", body: "Storage changed.", by: "agent" });
    expect(core.getOpenContradictions()).toHaveLength(0);
    core.close();
  });

  it("keep-current never supersedes an observation belonging to another concept (Codex P1)", async () => {
    // flagContradiction does not check that observationId belongs to conceptId, so a contradiction
    // on A can name an observation of B. Resolving A must not reach into B's evidence.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 }); // keep them separate
    const a = await core.store("Concept A: the deploy runs on Tuesdays.");
    const b = await core.store("Concept B: totally unrelated, the office plants need watering.");
    expect(b.conceptId).not.toBe(a.conceptId);
    const foreignObsId = (await core.getConcept(b.conceptId, { synthesize: false }))!.observations[0]!.id;

    const contra = core.flagContradiction(a.conceptId, { observationId: foreignObsId, detail: "mis-scoped" });

    // Refused outright now — a contradiction naming foreign evidence is malformed, and resolving it
    // either way would write a cross-concept pointer.
    expect(() => core.resolveContradiction(contra.id, { decision: "keep-current", by: "agent" }))
      .toThrow(/does not belong to concept/);

    // B's evidence is untouched.
    expect(core.supersededObservationCount()).toBe(0);
    const bAfter = (await core.getConcept(b.conceptId, { synthesize: false }))!;
    expect(bAfter.observations).toHaveLength(1);
    expect(bAfter.observations[0]!.content).toContain("office plants");
    core.close();
  });

  it("refuses a contradiction whose correcting observation belongs to another concept (Codex R2-P1)", async () => {
    // Scoping the UPDATE protected the row written; it did not protect the pointer written INTO it.
    // With one live prior, accept-new would stamp A's prior with superseded_by = B's observation and
    // then leave A with no evidence at all.
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    const a = await core.store("Concept A: the deploy runs on Tuesdays.");
    const b = await core.store("Concept B: unrelated, the office plants need watering.");
    const foreignObsId = (await core.getConcept(b.conceptId, { synthesize: false }))!.observations[0]!.id;
    const contra = core.flagContradiction(a.conceptId, { observationId: foreignObsId, detail: "mis-scoped" });

    expect(() => core.resolveContradiction(contra.id, { decision: "accept-new", body: "x", by: "agent" }))
      .toThrow(/does not belong to concept/);

    // A keeps its evidence; B keeps its own; nothing superseded anywhere.
    expect(core.supersededObservationCount()).toBe(0);
    expect((await core.getConcept(a.conceptId, { synthesize: false }))!.observations).toHaveLength(1);
    expect((await core.getConcept(b.conceptId, { synthesize: false }))!.observations).toHaveLength(1);
    // dismiss remains available for the malformed row.
    core.resolveContradiction(contra.id, { decision: "dismiss", by: "agent" });
    expect(core.getOpenContradictions()).toHaveLength(0);
    core.close();
  });

  it("a terminally-superseded row is not a live prior (Codex R2-P1)", async () => {
    // supersedeObservation(id, null) leaves superseded_by NULL and superseded_at SET. Filtering on
    // superseded_by alone counts it as live, so one real prior + one removed row reads as ambiguous.
    const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
    const base = await core.store(BASE);
    const removable = await core.store("Transient note that gets withdrawn.", { attachTo: base.conceptId });
    const corr = await core.store(CORRECTION, { kind: "correction", attachTo: base.conceptId });

    // Terminal supersession: gone, but with superseded_by NULL.
    (core as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare(`UPDATE observations SET superseded_by = NULL, superseded_at = ? WHERE id = ?`)
      .run(Date.now(), removable.observationId);

    core.resolveContradiction(corr.contradiction!.id, { decision: "accept-new", body: "Not SQLite.", by: "agent" });

    // Exactly one live prior remained (base), so it is unambiguous and must be superseded.
    expect(isSuperseded(core, base.observationId)).toBe(true);
    expect((await core.getConcept(base.conceptId, { synthesize: false }))!.status).toBe("active");
    core.close();
  });

  it("evidence attached AFTER the correction is not a prior (Codex R2-P1)", async () => {
    // detach() defines priors as observations existing before the correcting observation; a guard
    // note added afterwards is not party to the dispute. Diverging here made a single-prior case
    // look ambiguous, so the contradicted claim stayed live.
    const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
    const base = await core.store(BASE);
    const corr = await core.store(CORRECTION, { kind: "correction", attachTo: base.conceptId });
    const later = await core.store("Later, unrelated context: the WAL checkpoint runs at 1000 pages.", { attachTo: base.conceptId });

    core.resolveContradiction(corr.contradiction!.id, { decision: "accept-new", body: "Not SQLite.", by: "agent" });

    expect(isSuperseded(core, base.observationId)).toBe(true);   // the one true prior lost
    expect(isSuperseded(core, later.observationId)).toBe(false); // the later note is not party to it
    core.close();
  });

  it("refuses a verdict whose correcting observation is no longer live (Codex R3-P1)", async () => {
    // If the correction has itself been superseded it is absent from liveIds, and the old fallback
    // then treated every live row as a prior — accept-new would supersede the last live prior with
    // an already-dead correction, leaving the concept with no live evidence at all.
    const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
    const base = await core.store(BASE);
    const corr = await core.store(CORRECTION, { kind: "correction", attachTo: base.conceptId });
    (core as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare(`UPDATE observations SET superseded_by = NULL, superseded_at = ? WHERE id = ?`)
      .run(Date.now(), corr.observationId);

    expect(() => core.resolveContradiction(corr.contradiction!.id, { decision: "accept-new", body: "x", by: "agent" }))
      .toThrow(/no longer live evidence/);
    expect(isSuperseded(core, base.observationId)).toBe(false);
    core.close();
  });

  it("refuses keep-current when no live prior remains to keep (Codex R3-P1)", async () => {
    // With every pre-correction observation terminally superseded, keep-current had a null winner:
    // it superseded nothing yet closed the conflict and made the concept active with only the
    // REJECTED correction live — the opposite of the verdict, recorded as success.
    const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
    const base = await core.store(BASE);
    const corr = await core.store(CORRECTION, { kind: "correction", attachTo: base.conceptId });
    (core as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare(`UPDATE observations SET superseded_by = NULL, superseded_at = ? WHERE id = ?`)
      .run(Date.now(), base.observationId);

    expect(() => core.resolveContradiction(corr.contradiction!.id, { decision: "keep-current", by: "agent" }))
      .toThrow(/no live observation predating the correction/);
    expect(core.getOpenContradictions()).toHaveLength(1); // still open, not silently closed
    expect(isSuperseded(core, corr.observationId)).toBe(false);
    core.close();
  });

  it("keep-current retires the correction with NO successor, so detach cannot resurrect it (Codex R4-P1)", async () => {
    // Naming an arbitrary prior as the correction's successor is a guess with a second-order cost:
    // detach()'s inbound-pointer cleanup clears supersession when the named successor moves away,
    // which would bring the REJECTED correction back as live evidence. Terminal supersession says
    // "retired" without claiming who replaced it, so there is no pointer to clear.
    const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
    const base = await core.store(BASE);
    const note = await core.store("Unrelated note: the WAL checkpoint runs at 1000 pages.", { attachTo: base.conceptId });
    const corr = await core.store(CORRECTION, { kind: "correction", attachTo: base.conceptId });

    core.resolveContradiction(corr.contradiction!.id, { decision: "keep-current", by: "agent" });

    const row = (core as unknown as { db: { prepare(sql: string): { get(id: string): unknown } } }).db
      .prepare(`SELECT superseded_by, superseded_at FROM observations WHERE id = ?`)
      .get(corr.observationId) as { superseded_by: string | null; superseded_at: number | null };
    expect(row.superseded_at).not.toBeNull();      // retired
    expect(row.superseded_by).toBeNull();          // but pointing at nobody
    expect(row.superseded_by).not.toBe(note.observationId); // emphatically not the unrelated note

    // Detaching the unrelated note must not revive the rejected correction.
    await core.detach(base.conceptId, [note.observationId]);
    const after = (core as unknown as { db: { prepare(sql: string): { get(id: string): unknown } } }).db
      .prepare(`SELECT superseded_at FROM observations WHERE id = ?`)
      .get(corr.observationId) as { superseded_at: number | null };
    expect(after.superseded_at).not.toBeNull();
    core.close();
  });

  it("dismiss restores the concept and supersedes nothing", async () => {
    const { core, contradictionId } = await disputed();
    const resolvedRaw = core.resolveContradiction(contradictionId, { decision: "dismiss", by: "agent" })!;
    // The contradiction was open — resolveContradiction returns a Concept (not alreadyClosed).
    expect("alreadyClosed" in resolvedRaw).toBe(false);
    const resolved = resolvedRaw as import("../engine").Concept;
    expect(resolved.status).toBe("active");
    expect(core.getOpenContradictions()).toHaveLength(0);
    expect(core.supersededObservationCount()).toBe(0);
    core.close();
  });

  it("flagContradiction works directly (not only via correction-store)", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("Use feature flags for all rollouts.");
    const k = core.flagContradiction(a.conceptId, { detail: "a newer policy bans feature flags" });
    expect(k.status).toBe("open");
    expect((await core.getConcept(a.conceptId, { synthesize: false }))!.status).toBe("disputed");
    expect(core.getOpenContradictions()).toHaveLength(1);
    core.close();
  });
});

describe("staleness (#240 / #179 class)", () => {
  it("active concepts unconfirmed past staleAfterMs are detectable and surfaced, not in topConcepts", async () => {
    const core = new MonetCore(":memory:", { staleAfterMs: 5 });
    await core.store("An old fact about the deployment process.");
    await new Promise((r) => setTimeout(r, 25)); // age past the 5ms staleness window

    expect(core.getStaleConcepts()).toHaveLength(1);
    const pw = core.prewarm();
    expect(pw.staleConcepts).toHaveLength(1);
    expect(pw.topConcepts).toHaveLength(0); // stale is partitioned out of the fresh living model
    core.close();
  });
});

describe("attach() status preservation (#fix — attach must never clear 'disputed')", () => {
  it("a plain store/attach onto a disputed concept keeps it disputed (open contradiction survives)", async () => {
    // Set up a disputed concept via a correction.
    const core = new MonetCore(":memory:");
    const a = await core.store(BASE);
    const corr = await core.store(CORRECTION, { kind: "correction" });
    expect(corr.conceptId).toBe(a.conceptId);
    const conceptId = a.conceptId;

    // Confirm disputed before attaching more evidence.
    const before = (await core.getConcept(conceptId, { synthesize: false }))!;
    expect(before.status).toBe("disputed");
    expect(core.getOpenContradictions()).toHaveLength(1);

    // Attach a plain (non-correction) observation — must NOT clear 'disputed'.
    await core.store("Additional context about our storage backend choice.", { attachTo: conceptId });

    const after = (await core.getConcept(conceptId, { synthesize: false }))!;
    expect(after.status).toBe("disputed"); // must remain disputed: open contradiction still present
    expect(core.getOpenContradictions()).toHaveLength(1); // contradiction row still open

    core.close();
  });

  it("a stale concept (status='active') receiving new evidence keeps status='active' — CASE WHEN preserves non-disputed", async () => {
    // Stale is time-based, not a status enum field; stale concepts always have status='active'.
    // The attach() CASE WHEN only guards 'disputed' → it must still write 'active' for all other statuses.
    const core = new MonetCore(":memory:", { staleAfterMs: 5 });
    const a = await core.store("Deployment process uses bare-metal servers.");
    await new Promise((r) => setTimeout(r, 25)); // age past staleness threshold

    // Verify concept is considered stale (time-based) and its status is 'active'.
    expect(core.getStaleConcepts()).toHaveLength(1);
    const staleRow = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    expect(staleRow.status).toBe("active"); // stale is time-based, status is still 'active'

    // Attach new evidence — concept status must remain 'active' (CASE WHEN does not break this).
    await core.store("Confirmed: bare-metal still in use.", { attachTo: a.conceptId });

    const after = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    expect(after.status).toBe("active"); // 'active' preserved through attach

    core.close();
  });
});

/**
 * Named-loser resolution (contradictedObservationId): the caller can now name, at resolution
 * time, exactly which observation a verdict is about — resolution is the moment the agent
 * actually has the evidence in front of it, the same moment it is already asked for a reconciled
 * `body`. This is additive: every test above this block exercises the ABSENT-parameter path and
 * must keep passing byte-for-byte unchanged (that is the regression these tests guard against).
 */
describe("named-loser resolution (contradictedObservationId)", () => {
  it("accept-new supersedes EXACTLY the named loser among several live priors — no body required", async () => {
    // Same fixture as "a verdict never supersedes evidence the contradiction does not name" above:
    // with no name, this concept's accept-new would supersede NOTHING (2+ live priors). Naming one
    // of them makes the verdict explicit instead of refusing it.
    const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
    const base = await core.store(BASE);
    const findingA = await core.store("Unrelated finding A: the WAL checkpoint runs at 1000 pages.", { attachTo: base.conceptId });
    const findingB = await core.store("Unrelated finding B: the lock is connection-level, not advisory.", { attachTo: base.conceptId });
    const corr = await core.store(CORRECTION, { kind: "correction", attachTo: base.conceptId });
    expect(corr.contradiction).toBeDefined();

    const resolved = core.resolveContradiction(corr.contradiction!.id, {
      decision: "accept-new",
      contradictedObservationId: findingA.observationId,
      by: "agent",
      // deliberately NO body — the named loser is now the record of the verdict.
    })!;
    expect("alreadyClosed" in resolved).toBe(false);

    // Exactly the named observation lost, with the correction as its real successor pointer.
    expect(core.supersededObservationCount()).toBe(1);
    expect(supersessionOf(core, findingA.observationId)).toEqual({ superseded_by: corr.observationId, superseded_at: expect.any(Number) });
    // Everything else the contradiction did not name stays untouched.
    expect(isSuperseded(core, base.observationId)).toBe(false);
    expect(isSuperseded(core, findingB.observationId)).toBe(false);
    // Recorded on the row for the caller (and any future reader) to see what this verdict named.
    expect(contradictedObsOf(core, corr.contradiction!.id)).toBe(findingA.observationId);

    const after = (await core.getConcept(base.conceptId, { synthesize: false }))!;
    expect(after.status).toBe("active");
    expect(core.getOpenContradictions()).toHaveLength(0);
    core.close();
  });

  it("without a name, the identical multi-prior fixture is still refused — the fallback is unchanged", async () => {
    // Control for the test above: same concept shape, same decision, NO contradictedObservationId.
    // This must still hit the pre-existing ambiguous-accept-new guard, proving the fallback path is
    // untouched by this feature rather than accidentally loosened.
    const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
    const base = await core.store(BASE);
    await core.store("Unrelated finding A: the WAL checkpoint runs at 1000 pages.", { attachTo: base.conceptId });
    await core.store("Unrelated finding B: the lock is connection-level, not advisory.", { attachTo: base.conceptId });
    const corr = await core.store(CORRECTION, { kind: "correction", attachTo: base.conceptId });

    expect(() =>
      core.resolveContradiction(corr.contradiction!.id, { decision: "accept-new", by: "agent" }),
    ).toThrow(/reconciled body/);
    expect(core.supersededObservationCount()).toBe(0);
    core.close();
  });

  it("keep-current with a named prior records it as KEPT, not a supersession target", async () => {
    const { core, conceptId, contradictionId } = await disputed();
    const before = (await core.getConcept(conceptId, { synthesize: false }))!;
    const baseObsId = before.observations.find((o) => o.content.includes("We decided to use SQLite"))!.id;

    const resolved = core.resolveContradiction(contradictionId, {
      decision: "keep-current",
      contradictedObservationId: baseObsId,
      by: "agent",
    })!;
    expect("alreadyClosed" in resolved).toBe(false);

    // The kept prior is untouched — naming it is not a supersession target for keep-current.
    expect(supersessionOf(core, baseObsId)).toEqual({ superseded_by: null, superseded_at: null });
    // The correction still lost, terminally (unchanged keep-current behavior).
    const corrRow = supersessionOf(core, (await core.getConcept(conceptId, { synthesize: false }))!.observations
      .find((o) => o.content.includes("NOT to use SQLite"))!.id);
    expect(corrRow.superseded_at).not.toBeNull();
    expect(corrRow.superseded_by).toBeNull();
    // But WHO was kept is now on the record.
    expect(contradictedObsOf(core, contradictionId)).toBe(baseObsId);
    core.close();
  });

  describe("validation — each failure names what to do instead", () => {
    it("throws when contradictedObservationId does not exist", async () => {
      const { core, contradictionId } = await disputed();
      expect(() =>
        core.resolveContradiction(contradictionId, { decision: "accept-new", contradictedObservationId: "nonexistent-id", body: "x" }),
      ).toThrow(/nonexistent-id.*does not exist/s);
      core.close();
    });

    it("throws when contradictedObservationId belongs to a different concept", async () => {
      const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 }); // keep concepts separate
      const a = await core.store("Concept A: the deploy runs on Tuesdays.");
      const b = await core.store("Concept B: totally unrelated, the office plants need watering.");
      const corrA = await core.store("Concept A: the deploy runs on Wednesdays now.", { kind: "correction", attachTo: a.conceptId });
      expect(corrA.contradiction).toBeDefined();

      expect(() =>
        core.resolveContradiction(corrA.contradiction!.id, {
          decision: "accept-new", contradictedObservationId: b.observationId, body: "x",
        }),
      ).toThrow(/belongs to concept/);
      expect(core.supersededObservationCount()).toBe(0);
      core.close();
    });

    it("throws when contradictedObservationId is already superseded by a real successor", async () => {
      const { core, conceptId, contradictionId } = await disputed();
      const baseObsId = (await core.getConcept(conceptId, { synthesize: false }))!.observations
        .find((o) => o.content.includes("We decided to use SQLite"))!.id;
      core.resolveContradiction(contradictionId, { decision: "accept-new", contradictedObservationId: baseObsId, by: "agent" });
      expect(isSuperseded(core, baseObsId)).toBe(true);

      // A second correction arrives; naming the already-dead prior must be refused.
      const second = await core.store("We decided to use Postgres as the storage backend for Monet Local.", {
        kind: "correction", attachTo: conceptId,
      });
      expect(() =>
        core.resolveContradiction(second.contradiction!.id, {
          decision: "accept-new", contradictedObservationId: baseObsId, body: "x",
        }),
      ).toThrow(/no longer live evidence/);
      core.close();
    });

    it("throws when contradictedObservationId is TERMINALLY superseded (superseded_by NULL, superseded_at set)", async () => {
      const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
      const base = await core.store(BASE);
      const removable = await core.store("Transient note that gets withdrawn.", { attachTo: base.conceptId });
      const corr = await core.store(CORRECTION, { kind: "correction", attachTo: base.conceptId });
      (core as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
        .prepare(`UPDATE observations SET superseded_by = NULL, superseded_at = ? WHERE id = ?`)
        .run(Date.now(), removable.observationId);

      expect(() =>
        core.resolveContradiction(corr.contradiction!.id, {
          decision: "accept-new", contradictedObservationId: removable.observationId, body: "x",
        }),
      ).toThrow(/no longer live evidence/);
      core.close();
    });

    it("throws when contradictedObservationId is the correcting observation itself", async () => {
      const { core, contradictionId } = await disputed();
      // The contradiction's own observation_id IS the correcting observation — naming it as its
      // own loser is the self-contradiction case the validation exists to catch.
      const contra = (core as unknown as { db: { prepare(sql: string): { get(id: string): unknown } } }).db
        .prepare(`SELECT observation_id FROM contradictions WHERE id = ?`)
        .get(contradictionId) as { observation_id: string };

      expect(() =>
        core.resolveContradiction(contradictionId, {
          decision: "accept-new", contradictedObservationId: contra.observation_id, body: "x",
        }),
      ).toThrow(/correcting observation itself/);
      core.close();
    });

    it("rejects contradictedObservationId with decision:\"dismiss\"", async () => {
      const { core, conceptId, contradictionId } = await disputed();
      const baseObsId = (await core.getConcept(conceptId, { synthesize: false }))!.observations
        .find((o) => o.content.includes("We decided to use SQLite"))!.id;

      expect(() =>
        core.resolveContradiction(contradictionId, { decision: "dismiss", contradictedObservationId: baseObsId }),
      ).toThrow(/dismissal reaches no verdict/);
      expect(core.getOpenContradictions()).toHaveLength(1); // refused, not silently closed
      core.close();
    });

    // Independent-audit round 2 findings: the two tests above (and the eight before them) all use a
    // correction-backed contradiction, which is exactly why neither of these paths was caught the
    // first time. Both are reproduced verbatim from the audit's repro steps.

    it("BLOCKING: rejects contradictedObservationId on a BARE contradiction (accept-new) — would otherwise zero a concept's evidence", async () => {
      // flagContradiction's observationId-less form: no correcting observation exists, so
      // `successor` in the named-loser branch would be NULL — a TERMINAL supersession of the
      // concept's ONLY observation. Unlike a real accept-new pointer, a terminal supersession has no
      // successor for detach()'s inbound cleanup to ever clear, so this is an unrevivable deletion.
      const core = new MonetCore(":memory:");
      const a = await core.store("The office plants need watering on Mondays.");
      const k = core.flagContradiction(a.conceptId, { detail: "policy changed, no specific evidence cited" });
      expect(k.observationId).toBeNull();

      expect(() =>
        core.resolveContradiction(k.id, { decision: "accept-new", contradictedObservationId: a.observationId }),
      ).toThrow(/has no correcting observation/);

      // Refused means REFUSED: the sole observation is untouched, nothing lost.
      expect(isSuperseded(core, a.observationId)).toBe(false);
      expect(core.supersededObservationCount()).toBe(0);
      const after = (await core.getConcept(a.conceptId, { synthesize: false }))!;
      expect(after.observations).toHaveLength(1);
      expect(after.status).not.toBe("retired");
      expect(core.getOpenContradictions()).toHaveLength(1); // still open, not silently closed
      core.close();
    });

    it("BLOCKING: rejects contradictedObservationId on a BARE contradiction (keep-current too — the field always means 'contradicted', and a bare contradiction contradicted nothing)", async () => {
      const core = new MonetCore(":memory:");
      const a = await core.store("The office plants need watering on Mondays.");
      const k = core.flagContradiction(a.conceptId, { detail: "policy changed, no specific evidence cited" });

      expect(() =>
        core.resolveContradiction(k.id, { decision: "keep-current", contradictedObservationId: a.observationId }),
      ).toThrow(/has no correcting observation/);
      expect(isSuperseded(core, a.observationId)).toBe(false);
      core.close();
    });

    it("MAJOR: rejects contradictedObservationId that POSTDATES the correction (accept-new) — would otherwise build a backwards-in-time pointer", async () => {
      // D1 (obs A) -> correction (obs B) -> N (obs C, AFTER the correction). C never existed when
      // the correction landed, so it was never in dispute with it. Naming C as the loser would
      // retire the concept's NEWEST evidence in favor of the stale corrected claim.
      const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
      const d1 = await core.store(BASE);
      const corr = await core.store(CORRECTION, { kind: "correction", attachTo: d1.conceptId });
      expect(corr.contradiction).toBeDefined();
      const n = await core.store("Later, unrelated context: the WAL checkpoint runs at 1000 pages.", { attachTo: d1.conceptId });

      expect(() =>
        core.resolveContradiction(corr.contradiction!.id, {
          decision: "accept-new", contradictedObservationId: n.observationId, body: "x",
        }),
      ).toThrow(/does not predate/);

      // Refused means REFUSED: nothing superseded, all three observations still live.
      expect(core.supersededObservationCount()).toBe(0);
      expect(isSuperseded(core, d1.observationId)).toBe(false);
      expect(isSuperseded(core, corr.observationId)).toBe(false);
      expect(isSuperseded(core, n.observationId)).toBe(false);
      core.close();
    });

    it("MAJOR: rejects contradictedObservationId that POSTDATES the correction (keep-current) — 'the prior being kept' must actually be a prior", async () => {
      const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
      const d1 = await core.store(BASE);
      const corr = await core.store(CORRECTION, { kind: "correction", attachTo: d1.conceptId });
      const n = await core.store("Later, unrelated context: the WAL checkpoint runs at 1000 pages.", { attachTo: d1.conceptId });

      expect(() =>
        core.resolveContradiction(corr.contradiction!.id, {
          decision: "keep-current", contradictedObservationId: n.observationId,
        }),
      ).toThrow(/does not predate/);
      expect(core.supersededObservationCount()).toBe(0);
      core.close();
    });
  });

  it("POSTCONDITION guarantee: a valid named-loser accept-new always leaves the correction (successor) live, never zeroing the concept", async () => {
    // This is the property the new postcondition check in resolveContradiction protects. It is not
    // independently reachable through the public API once the bare-contradiction and
    // priors-membership guards hold (the successor is always the already-validated-live correcting
    // observation), so this test exercises the GUARANTEE rather than the throw branch itself.
    const core = new MonetCore(":memory:", { tauAttach: 0.0, tauAmbiguous: 0.0 });
    const base = await core.store(BASE);
    const corr = await core.store(CORRECTION, { kind: "correction", attachTo: base.conceptId });
    core.resolveContradiction(corr.contradiction!.id, {
      decision: "accept-new", contradictedObservationId: base.observationId, by: "agent",
    });

    expect(isSuperseded(core, corr.observationId)).toBe(false); // the successor is always live
    const after = (await core.getConcept(base.conceptId, { synthesize: false }))!;
    expect(after.status).toBe("active");
    expect(after.confidence).toBeGreaterThan(0); // never the empty-concept projection
    core.close();
  });
});

describe("contradicted_observation_id migration (pre-existing database)", () => {
  it("a database created before this column exists gets it added as NULL, and the feature works after migration", async () => {
    // Simulate "this store predates the contradicted_observation_id column" faithfully, instead of
    // hand-rolling a whole legacy schema: build a REAL store with the current code (so every other
    // column/table/trigger is exactly what a real pre-existing store would have), then drop just the
    // one column under test with raw SQL. Reopening exercises the exact addColumn() migration path a
    // real upgrade would hit.
    const dir = mkdtempSync(join(tmpdir(), "monet-contradicted-obs-migration-"));
    const dbPath = join(dir, "monet.db");
    try {
      const core = new MonetCore(dbPath);
      const a = await core.store(BASE);
      const corr = await core.store(CORRECTION, { kind: "correction" });
      expect(corr.contradiction).toBeDefined();
      // Resolve the old way (no name) so this row is a realistic "existing row from before the
      // feature shipped" — its contradicted_observation_id was never written.
      core.resolveContradiction(corr.contradiction!.id, { decision: "accept-new", body: "Not SQLite.", by: "agent" });
      const preExistingContradictionId = corr.contradiction!.id;
      core.close();

      // Strip the column to fabricate the pre-migration shape.
      const raw = new Database(dbPath);
      const columnsBefore = raw.prepare(`PRAGMA table_info(contradictions)`).all() as Array<{ name: string }>;
      expect(columnsBefore.some((c) => c.name === "contradicted_observation_id")).toBe(true); // sanity: it was there
      raw.exec(`ALTER TABLE contradictions DROP COLUMN contradicted_observation_id`);
      const columnsAfterDrop = raw.prepare(`PRAGMA table_info(contradictions)`).all() as Array<{ name: string }>;
      expect(columnsAfterDrop.some((c) => c.name === "contradicted_observation_id")).toBe(false);
      raw.close();

      // Reopen: MonetCore's migration (ensureSyncClosureSchema's addColumn) must restore the column
      // without touching the existing row's data.
      const reopened = new MonetCore(dbPath);
      const columnsAfterMigration = (reopened as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db
        .prepare(`PRAGMA table_info(contradictions)`).all() as Array<{ name: string }>;
      expect(columnsAfterMigration.some((c) => c.name === "contradicted_observation_id")).toBe(true);
      // The pre-existing resolved row keeps NULL — migration never fabricates a value it wasn't given.
      expect(contradictedObsOf(reopened, preExistingContradictionId)).toBeNull();
      // getConcept/behavior on old data is otherwise untouched by the migration.
      expect((await reopened.getConcept(a.conceptId, { synthesize: false }))!.status).toBe("active");

      // And the feature itself works normally post-migration: a NEW contradiction on this same
      // (migrated) store can use contradictedObservationId end to end.
      const second = await reopened.store("We decided to use Postgres as the storage backend for Monet Local.", {
        kind: "correction", attachTo: a.conceptId,
      });
      expect(second.contradiction).toBeDefined();
      const survivorObsId = (await reopened.getConcept(a.conceptId, { synthesize: false }))!.observations
        .find((o) => o.content.includes("NOT to use SQLite"))!.id;
      reopened.resolveContradiction(second.contradiction!.id, {
        decision: "accept-new", contradictedObservationId: survivorObsId, by: "agent",
      });
      expect(contradictedObsOf(reopened, second.contradiction!.id)).toBe(survivorObsId);
      expect(isSuperseded(reopened, survivorObsId)).toBe(true);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
