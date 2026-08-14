/**
 * The ratification entrance and the battery record — monet-core#142.
 *
 * #142's defect, in its own words: three states are one observable — the battery ran and passed, it
 * ran and rejected, it never ran. The store could not be asked which. The measured evidence was
 * blunt: five skeleton members, every one entered by declaration, and no record anywhere that the
 * battery had ever gated anything.
 *
 * What makes the states separable is `entrance` alongside the verdict already stored. Everything
 * below is about that separation staying honest — especially about the fourth state nobody planned
 * for, `null`, which means "this verdict predates the field" and must never be quietly promoted
 * into one of the other three.
 */
import { describe, expect, it } from "vitest";
import { MonetCore } from "../engine";
import { assertBatteryShape, BATTERY_GATES } from "../lifecycle-edges";
import type { BatteryVerdict } from "../lifecycle-edges";

const FULL_BATTERY: BatteryVerdict[] = [
  { gate: "generates", passed: true, evidenceRef: "concept:abc" },
  { gate: "covers", passed: true },
  { gate: "transfers", passed: true },
  { gate: "exits", passed: true, evidenceRef: "obs:def" },
];

async function candidate(core: MonetCore): Promise<string> {
  const stored = await core.store("Explanation starts from the listener's world, not the speaker's artifact.", {
    kind: "principle",
  });
  return stored.conceptId;
}

describe("#142: the three states become distinguishable", () => {
  it("a declaration records its entrance and carries no battery, by right", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const declared = await core.declare({
      species: "principle",
      content: "Encode principles, not procedures, in anything that ships.",
      exitsEvidence: "a shipped procedure that outlived the mechanism it assumed",
      circle: "acme",
    });
    const member = core.skeletonForCuration("acme")
      .find((m) => m.conceptId === (declared as { conceptId: string }).conceptId)!;
    core.close();

    // NEVER-RAN, and legitimately so: sovereignty replaces the battery on this entrance. The point
    // is not that it was tested — it is that "untested" is now readable instead of buried.
    expect(member.entrance).toBe("declaration");
  });

  it("an extraction approval records its entrance and the four gates that gated it", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const id = await candidate(core);
    await core.ratify({ candidateId: id, verdict: "approve", entrance: "extraction", battery: FULL_BATTERY });
    const member = core.skeletonForCuration("acme").find((m) => m.conceptId === id)!;
    core.close();
    expect(member.entrance).toBe("extraction");
  });

  /**
   * THE STATE NOBODY PLANNED FOR, and the one this design is most careful about. Every ratification
   * written before the column existed carries null, and null is never promoted into a guess. A
   * live store's own rows show why: three carry the battery as PROSE inside `packet` ("all four
   * passed, run conversationally with John") — true, and unaskable. Mining that into a structured
   * verdict would manufacture a precision the record never had.
   */
  it("a ruling that does not name its entrance records null, never a guess", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const id = await candidate(core);
    await core.ratify({ candidateId: id, verdict: "approve", packet: JSON.stringify({ note: "ruled in conversation" }) });
    const member = core.skeletonForCuration("acme").find((m) => m.conceptId === id)!;
    core.close();
    expect(member.entrance).toBeNull();
  });
});

describe("#142: the entrance's claims are backed, on form alone", () => {
  // Claiming the battery ran means showing it. This never judges an ANSWER — it makes
  // not-answering impossible, which is all a checklist can do (§2's stubbornness).
  it("refuses an extraction verdict with no battery", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const id = await candidate(core);
    await expect(core.ratify({ candidateId: id, verdict: "approve", entrance: "extraction" }))
      .rejects.toThrow(/must carry the battery/);
    core.close();
  });

  it("refuses an extraction verdict whose battery leaves a gate unanswered", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const id = await candidate(core);
    await expect(
      core.ratify({
        candidateId: id, verdict: "approve", entrance: "extraction",
        battery: FULL_BATTERY.filter((verdict) => verdict.gate !== "exits"),
      }),
    ).rejects.toThrow(/exits unanswered/);
    core.close();
  });

  // A rejection's entire value is WHICH gate it failed — the design's own worked example rejects a
  // candidate for failing Exits, "inadmissible mechanically, no human judgment needed".
  it("requires the battery on a rejection too, and keeps a failed gate on the record", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const id = await candidate(core);
    await expect(core.ratify({ candidateId: id, verdict: "reject", entrance: "extraction" }))
      .rejects.toThrow(/must carry the battery/);
    await core.ratify({
      candidateId: id, verdict: "reject", entrance: "extraction",
      battery: [
        { gate: "generates", passed: true }, { gate: "covers", passed: true },
        { gate: "transfers", passed: true }, { gate: "exits", passed: false, evidenceRef: "nothing could impeach it" },
      ],
    });
    const rows = core.getRatifications(id);
    core.close();
    const battery = JSON.parse(rows[0]!.battery!) as BatteryVerdict[];
    expect(rows[0]!.entrance).toBe("extraction");
    expect(battery.find((verdict) => verdict.gate === "exits")!.passed).toBe(false);
  });

  // A battery on a declaration would be a test nobody ran — worse than an admitted absence.
  it("refuses a battery on a declaration, where sovereignty replaced the test", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const id = await candidate(core);
    await expect(
      core.ratify({ candidateId: id, verdict: "approve", entrance: "declaration", battery: FULL_BATTERY }),
    ).rejects.toThrow(/carries no battery/);
    core.close();
  });

  it("assertBatteryShape refuses a duplicate gate and an unknown one", () => {
    expect(() => assertBatteryShape([...FULL_BATTERY, { gate: "exits", passed: true }])).toThrow(/answered twice/);
    expect(() => assertBatteryShape([{ gate: "nonsense" as never, passed: true }])).toThrow(/is not one of/);
    expect(BATTERY_GATES).toEqual(["generates", "covers", "transfers", "exits"]);
  });

  // CODEX P1 ON PR #144: gate names and duplicates alone accepted four recognized gates and not one
  // actual answer. "All four are answered" has to mean answered.
  it("refuses a gate with no boolean answer", () => {
    const unanswered = FULL_BATTERY.map((v) => (v.gate === "exits" ? { gate: v.gate } : v)) as BatteryVerdict[];
    expect(() => assertBatteryShape(unanswered)).toThrow(/no boolean answer/);
    const stringy = FULL_BATTERY.map((v) => (v.gate === "exits" ? { gate: v.gate, passed: "yes" } : v)) as never;
    expect(() => assertBatteryShape(stringy)).toThrow(/no boolean answer/);
  });

  // CODEX P2 ON PR #144: `entrance = NULL, battery != NULL` is an impossible pair — curation reads
  // the ruling as unrecorded while the evidence sits right there, and the next sync discards it.
  /**
   * CODEX P1 ON PR #144. The battery IS the gate on this entrance — the design's own worked example
   * rejects a candidate for failing Exits, "inadmissible mechanically, no human judgment needed" —
   * so entering the always-on skeleton over a failed answer would have the record say the battery
   * passed something it refused. A sovereign override has its own explicit route.
   */
  it("refuses an extraction APPROVAL whose battery failed a gate", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const id = await candidate(core);
    const failedExits = FULL_BATTERY.map((v) => (v.gate === "exits" ? { ...v, passed: false } : v));
    await expect(
      core.ratify({ candidateId: id, verdict: "approve", entrance: "extraction", battery: failedExits }),
    ).rejects.toThrow(/failed exits/);
    core.close();
  });

  // A rejection KEEPS its failed answers — which gate refused is the whole value of one.
  it("still accepts a failed gate on a rejection", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const id = await candidate(core);
    const failedExits = FULL_BATTERY.map((v) => (v.gate === "exits" ? { ...v, passed: false } : v));
    await core.ratify({ candidateId: id, verdict: "reject", entrance: "extraction", battery: failedExits });
    const row = core.getRatifications(id)[0]!;
    core.close();
    expect(JSON.parse(row.battery!).find((v: { gate: string }) => v.gate === "exits").passed).toBe(false);
  });

  it("refuses a battery whose entrance is not named", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const id = await candidate(core);
    await expect(core.ratify({ candidateId: id, verdict: "approve", battery: FULL_BATTERY }))
      .rejects.toThrow(/needs its entrance named/);
    core.close();
  });

  // The structured battery has to be readable where curation actually looks, or structuring it
  // bought nothing (Codex P2 on PR #144).
  it("exposes the battery on the curation projection", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    const id = await candidate(core);
    await core.ratify({ candidateId: id, verdict: "approve", entrance: "extraction", battery: FULL_BATTERY });
    const member = core.skeletonForCuration("acme").find((m) => m.conceptId === id)!;
    core.close();
    expect(member.battery?.map((v) => v.gate)).toEqual(["generates", "covers", "transfers", "exits"]);
    expect(member.battery?.find((v) => v.gate === "exits")?.evidenceRef).toBe("obs:def");
  });
});

describe("#142: the entrance reaches curation and stops at the agent", () => {
  /**
   * THE MINIMIZATION BOUNDARY, asserted rather than trusted. `agent_context` ships the skeleton on
   * every session start; how a principle entered changes nothing for the agent about to obey it,
   * and a field with no answer to "who consumes it, on which turn" does not ship on that surface.
   * Curation is the consumer, and curation is on demand.
   */
  it("agent_context's skeleton does not carry the entrance; the curation view does", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    await core.declare({ species: "principle", content: "A principle.", circle: "acme" });

    const delivered = core.skeleton("acme");
    expect(delivered.length).toBeGreaterThan(0);
    for (const entry of delivered) expect(entry).not.toHaveProperty("entrance");

    const curation = core.skeletonForCuration("acme");
    core.close();
    expect(curation[0]!.entrance).toBe("declaration");
  });

  it("overview carries it, so 'which entered untested' is answerable there", async () => {
    const core = new MonetCore(":memory:", { defaultCircle: "acme" });
    await core.declare({ species: "principle", content: "A declared principle.", circle: "acme" });
    const id = await candidate(core);
    await core.ratify({ candidateId: id, verdict: "approve", entrance: "extraction", battery: FULL_BATTERY });

    const overview = await core.overview("acme");
    core.close();
    const byEntrance = Object.fromEntries(overview.skeleton.map((m) => [m.entrance ?? "unrecorded", true]));
    expect(byEntrance).toHaveProperty("declaration");
    expect(byEntrance).toHaveProperty("extraction");
  });
});

describe("#142: sync carries the act, and never invents it", () => {
  it("replicates entrance and battery to a peer", async () => {
    const src = new MonetCore(":memory:", { defaultCircle: "acme", syncDeviceId: "machine-a" });
    const dst = new MonetCore(":memory:", { defaultCircle: "acme", syncDeviceId: "machine-b" });
    const id = await candidate(src);
    await src.ratify({ candidateId: id, verdict: "approve", entrance: "extraction", battery: FULL_BATTERY });

    dst.graftRows(src.exportDelta(0));
    const landed = dst.getRatifications(id)[0]!;
    src.close();
    dst.close();
    expect(landed.entrance).toBe("extraction");
    expect(JSON.parse(landed.battery!)).toHaveLength(4);
  });

  /**
   * CODEX P1 ON PR #144, and it was right. A v15 payload can claim `entrance: "extraction"` with a
   * null, partial, duplicated or malformed battery. Written verbatim, a peer could mint an
   * extraction-backed ruling with no four-gate evidence behind it — corrupting the audit
   * distinction this release adds, from the one direction that skips every local check.
   *
   * It degrades to "unrecorded" rather than refusing the payload: one bad ratification must not
   * stop a sync, and a fabricated entrance could never be told from a real one again.
   */
  it("refuses to record an extraction entrance a peer cannot back with four gates", async () => {
    const src = new MonetCore(":memory:", { defaultCircle: "acme", syncDeviceId: "machine-a" });
    const dst = new MonetCore(":memory:", { defaultCircle: "acme", syncDeviceId: "machine-b" });
    const id = await candidate(src);
    await src.ratify({ candidateId: id, verdict: "approve" }); // entrance unrecorded locally
    const payload = src.exportDelta(0);

    for (const forged of [
      { entrance: "extraction", battery: null },
      { entrance: "extraction", battery: JSON.stringify([{ gate: "exits", passed: true }]) }, // incomplete
      { entrance: "extraction", battery: "not json at all" },
      { entrance: "declaration", battery: JSON.stringify(FULL_BATTERY) }, // a test nobody ran
      { entrance: "made-up", battery: null },
    ]) {
      const tampered = {
        ...payload,
        ratifications: (payload.ratifications ?? []).map((r) => ({ ...r, ...forged })),
      };
      const peer = new MonetCore(":memory:", { defaultCircle: "acme", syncDeviceId: `m-${forged.entrance}` });
      peer.graftRows(tampered);
      const landed = peer.getRatifications(id)[0];
      peer.close();
      expect(landed?.entrance ?? null, `forged ${JSON.stringify(forged).slice(0, 60)}`).toBeNull();
      expect(landed?.battery ?? null).toBeNull();
    }
    src.close();
    dst.close();
  });

  /**
   * CODEX P2 ON PR #144, and the third time this shape appeared: a rule added on one path and not
   * the other. The relay helper never saw the verdict, so a peer could create the retirement-with-
   * entrance state the local write had just been taught to refuse. Both paths now run ONE
   * classifier; only the consequence differs.
   */
  it("degrades relayed metadata the local path would have refused", async () => {
    const src = new MonetCore(":memory:", { defaultCircle: "acme", syncDeviceId: "a" });
    const id = await candidate(src);
    await src.ratify({ candidateId: id, verdict: "approve" });
    const payload = src.exportDelta(0);
    src.close();

    const failedExits = FULL_BATTERY.map((v) => (v.gate === "exits" ? { ...v, passed: false } : v));
    for (const forged of [
      // a retirement carrying entrance evidence — impossible locally
      { verdict: "retire", entrance: "extraction", battery: JSON.stringify(FULL_BATTERY) },
      // an approval over a failed gate — inadmissible locally
      { verdict: "approve", entrance: "extraction", battery: JSON.stringify(failedExits) },
    ]) {
      const peer = new MonetCore(":memory:", { defaultCircle: "acme", syncDeviceId: `m-${forged.verdict}` });
      peer.graftRows({
        ...payload,
        ratifications: (payload.ratifications ?? []).map((r) => ({ ...r, ...forged })),
      });
      const landed = peer.getRatifications(id)[0];
      peer.close();
      expect(landed?.entrance ?? null, forged.verdict).toBeNull();
      expect(landed?.battery ?? null).toBeNull();
    }
  });

  it("still carries a WELL-FORMED extraction pair across", async () => {
    const src = new MonetCore(":memory:", { defaultCircle: "acme", syncDeviceId: "machine-a" });
    const dst = new MonetCore(":memory:", { defaultCircle: "acme", syncDeviceId: "machine-b" });
    const id = await candidate(src);
    await src.ratify({ candidateId: id, verdict: "approve", entrance: "extraction", battery: FULL_BATTERY });
    dst.graftRows(src.exportDelta(0));
    const landed = dst.getRatifications(id)[0]!;
    src.close();
    dst.close();
    expect(landed.entrance).toBe("extraction");
  });

  /**
   * A peer on an older build sends a row with no entrance. It must land as null — the act genuinely
   * has none — rather than being defaulted into a claim the sender never made. Inventing provenance
   * out of a transport detail would be #142 reintroduced from the other end.
   */
  it("lands a row that carries no entrance as null, never as a default", async () => {
    const src = new MonetCore(":memory:", { defaultCircle: "acme", syncDeviceId: "machine-a" });
    const dst = new MonetCore(":memory:", { defaultCircle: "acme", syncDeviceId: "machine-b" });
    const id = await candidate(src);
    await src.ratify({ candidateId: id, verdict: "approve" });

    const payload = src.exportDelta(0);
    // Exactly what an older sender's payload looks like: the columns are simply absent.
    const older = {
      ...payload,
      ratifications: (payload.ratifications ?? []).map(({ entrance: _e, battery: _b, ...rest }) => rest),
    };
    dst.graftRows(older);
    const landed = dst.getRatifications(id)[0]!;
    src.close();
    dst.close();
    expect(landed.entrance).toBeNull();
    expect(landed.battery).toBeNull();
  });
});
