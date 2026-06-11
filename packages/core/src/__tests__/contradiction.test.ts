import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

/**
 * Contradiction & correction lifecycle (#240, ADR §4.4): detect drift instead of silently
 * absorbing it. A kind="correction" that lands on an existing concept opens a conflict and
 * flips it to disputed; resolution mediates (never silent last-write-wins); staleness surfaces.
 */
const BASE = "We decided to use SQLite as the storage backend for Monet Local.";
const CORRECTION = "We decided NOT to use SQLite as the storage backend for Monet Local.";

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
