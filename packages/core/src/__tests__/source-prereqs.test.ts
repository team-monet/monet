import { describe, expect, it } from "vitest";
import { MonetCore } from "../engine";
import type { GraftPayload } from "../sync-types";

const sourceRef = "source://source-a/docs/guide.md#intro~1";

describe("source-pipeline core prerequisites", () => {
  it("returns the original operation receipt before re-entering a multi-line attach", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const base = await core.store("Base memory.");
      const first = await core.store("First line.\nSecond line.", {
        attachTo: base.conceptId,
        operationId: "source-a:binding-a:fingerprint-a:snapshot-a",
      });
      const retry = await core.store("First line.\nSecond line.", {
        attachTo: base.conceptId,
        operationId: "source-a:binding-a:fingerprint-a:snapshot-a",
      });

      expect(retry).toMatchObject({
        action: first.action,
        conceptId: first.conceptId,
        observationId: first.observationId,
      });
      expect((await core.getConcept(base.conceptId, { synthesize: false }))!.observations).toHaveLength(2);
    } finally {
      core.close();
    }
  });

  it("does not duplicate a whole multi-line observation without an operation id", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const base = await core.store("Base memory.");
      const multiLine = "First complete line.\nSecond complete line.";
      await core.store(multiLine, { attachTo: base.conceptId });
      await core.store(multiLine, { attachTo: base.conceptId });
      const body = (await core.getConcept(base.conceptId, { synthesize: false }))!.body;
      expect(body.split(multiLine)).toHaveLength(2);
    } finally {
      core.close();
    }
  });

  it("rejects operation-id replays across native and source ownership boundaries", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      await core.store("Native receipt.", { operationId: "shared-operation-id" });
      await expect(core.storeSource("Source cannot claim native receipt.", {
        sourceRefs: [sourceRef],
        operationId: "shared-operation-id",
      })).rejects.toThrow("writer domain");

      const source = await core.storeSource("Source receipt.", {
        sourceRefs: [sourceRef],
        operationId: "source-operation-id",
      });
      await expect(core.store("Native cannot claim source receipt.", {
        operationId: "source-operation-id",
      })).rejects.toThrow("writer domain");

      const otherSource = await core.storeSource("Other source.", {
        sourceRefs: ["source://source-b/docs/guide.md#intro~1"],
        operationId: "other-source-operation-id",
      });
      await expect(core.storeSource("Wrong source replay.", {
        attachTo: otherSource.conceptId,
        sourceRefs: ["source://source-b/docs/guide.md#intro~1"],
        operationId: "source-operation-id",
      })).rejects.toThrow("different source concept");

      core.retireConcept(source.conceptId);
      await expect(core.storeSource("Retired source replay.", {
        sourceRefs: [sourceRef],
        operationId: "source-operation-id",
      })).rejects.toThrow("retired source concept");
    } finally {
      core.close();
    }
  });

  it("does not replay a native idempotency receipt for a retired concept (mirrors the source fence)", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const stored = await core.store("Native retirement replay target.", { operationId: "native-retire-replay-op" });
      core.retireConcept(stored.conceptId);
      await expect(core.store("Native retirement replay target.", {
        operationId: "native-retire-replay-op",
      })).rejects.toThrow("retired concept");
    } finally {
      core.close();
    }
  });

  it("keeps source concepts connector-owned while refreshing their current body and embedding", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      await expect(core.store("Forged source.", { kind: "source" })).rejects.toThrow("reserved");
      await expect(core.store("Forged provenance.", { sourceRefs: [sourceRef] })).rejects.toThrow("reserved");

      const first = await core.storeSource("Version one: source-backed content.", {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v1:snapshot-v1",
      });
      expect(first.concept.kind).toBe("source");
      expect(first.concept.dirty).toBe(false);
      expect(core.overview().livingModel.map((c) => c.id)).not.toContain(first.conceptId);
      expect(core.listDirty()).toEqual([]);
      expect(await core.checkpoint()).toBe(0);

      const second = await core.storeSource("Version two: refreshed source-backed content.", {
        attachTo: first.conceptId,
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v2:snapshot-v2",
      });
      // Generic fetch remains fenced both before and after the connector commits its read model.
      expect(await core.getConcept(first.conceptId, { synthesize: false })).toBeNull();
      // File=concept (Phase 1): supersedeSourceChunkObservation only flips the observation pair —
      // the concept's own title/body/embedding are recomputeSourceConceptBody's job, strictly
      // post-publish (item 4), driven from the LEDGER's active chunk set (source_chunks). This
      // low-level unit test never runs a ledger publish (no registered source run at all), so
      // there is nothing for recomputeSourceConceptBody to read — exactly as a genuinely
      // unpublished concept should behave. What IS verified at this level is the observation-pair
      // supersession itself, directly.
      await core.supersedeSourceChunkObservation(first.conceptId, second.observationId, first.observationId);
      const observations = core
        // @ts-expect-error test-only raw observation-state assertion
        .db.prepare(`SELECT id, superseded_by, superseded_at FROM observations WHERE id IN (?, ?)`)
        .all(first.observationId, second.observationId) as Array<{ id: string; superseded_by: string | null; superseded_at: number | null }>;
      const firstObs = observations.find((o) => o.id === first.observationId)!;
      const secondObs = observations.find((o) => o.id === second.observationId)!;
      expect(firstObs.superseded_by).toBe(second.observationId);
      expect(firstObs.superseded_at).not.toBeNull();
      expect(secondObs.superseded_by).toBeNull();
      expect(secondObs.superseded_at).toBeNull();
      expect(await core.getConcept(first.conceptId, { synthesize: false })).toBeNull();

      await expect(core.store("Native evidence.", { attachTo: first.conceptId })).rejects.toThrow("source concept");
      await expect(core.detach(first.conceptId, [second.observationId])).rejects.toThrow("source concept");
      expect(() => core.reassignCircle(first.conceptId, "other")).toThrow("source concept");
      await expect(core.mergeCircle("default", "other")).rejects.toThrow("source concepts");
      expect(() => core.flagContradiction(first.conceptId, { detail: "Forged contradiction." })).toThrow("source concept");
      expect(core.dismissPossibleDuplicate(first.conceptId, first.conceptId)).toMatchObject({ dismissed: false });
      await expect(core.applySynthesis(first.conceptId, "Forged body.")).rejects.toThrow("source concept");
    } finally {
      core.close();
    }
  });

  it("excludes source concepts from conceptCount and stats().concepts/observations, consistent with stats().dirty", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      await core.store("Native concept.", { resolution: "forceNew" });
      await core.storeSource("Source concept.", {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v1:snapshot-v1",
      });
      expect(core.conceptCount()).toBe(1);
      expect(core.stats().concepts).toBe(1);
      expect(core.stats().observations).toBe(1);
    } finally {
      core.close();
    }
  });

  it("excludes a source-only circle's session from stats().sessions and overview() sessions/observations, while a native circle counts normally", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      await core.storeSource("Source-only circle activity.", {
        circle: "source-only",
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v1:snapshot-v1",
      });
      await core.store("Native circle activity.", { circle: "native-circle", resolution: "forceNew" });

      expect(core.stats("source-only").sessions).toBe(0);
      expect(core.overview("source-only").counts.sessions).toBe(0);
      expect(core.overview("source-only").counts.observations).toBe(0);
      expect(core.listCircles().map((entry) => entry.circle)).not.toContain("source-only");

      // Same engine instance, same underlying session_id — the native circle still counts it
      // normally, proving the exclusion is scoped to the source-only circle's observation kind,
      // not a store-wide session miscount.
      expect(core.stats("native-circle").sessions).toBe(1);
      expect(core.overview("native-circle").counts.sessions).toBe(1);
      expect(core.overview("native-circle").counts.observations).toBe(1);
      expect(core.listCircles().find((entry) => entry.circle === "native-circle")?.concepts).toBe(1);
    } finally {
      core.close();
    }
  });

  it("never exposes source assertions through generic graph reads", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const target = await core.store("Target record.", { resolution: "forceNew" });
      const oldText = `Old source supports: #${target.concept.slug}.`;
      const source = await core.storeSource(oldText, {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v1:snapshot-v1",
      });
      expect(core.edges({ circle: "default", type: "supports" }).some((e) => e.srcId === source.conceptId && e.dstId === target.conceptId)).toBe(false);

      const successor = await core.storeSource("This replacement has no asserted target.", {
        attachTo: source.conceptId,
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v2:snapshot-v2",
      });
      await core.supersedeSourceChunkObservation(source.conceptId, successor.observationId, source.observationId);
      await core.recomputeSourceConceptBody(source.conceptId);
      expect(core.edges({ circle: "default", type: "supports" }).some((e) => e.srcId === source.conceptId && e.dstId === target.conceptId)).toBe(false);
    } finally {
      core.close();
    }
  });

  it("binds source concepts and refreshes to one canonical source identity", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const sourceA = await core.storeSource("Source A version one.", {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v1:snapshot-v1",
      });
      await expect(core.storeSource("Forged source B attachment.", {
        attachTo: sourceA.conceptId,
        sourceRefs: ["source://source-b/docs/guide.md#intro~1"],
        operationId: "source-b:binding-b:fingerprint-v1:snapshot-v1",
      })).rejects.toThrow("identity does not match");
      // The idempotency fast path is identity-fenced too; a reused receipt cannot bypass the
      // attach validation by presenting source B under source A's prior operation id.
      await expect(core.storeSource("Forged source B replay.", {
        attachTo: sourceA.conceptId,
        sourceRefs: ["source://source-b/docs/guide.md#intro~1"],
        operationId: "source-a:binding-a:fingerprint-v1:snapshot-v1",
      })).rejects.toThrow("different source identity");

      const sourceB = await core.storeSource("Source B version one.", {
        sourceRefs: ["source://source-b/docs/guide.md#intro~1"],
        operationId: "source-b:binding-b:fingerprint-v1:snapshot-v1",
      });
      // Test-only ledger corruption cannot cross the concept's persisted source identity either.
      core
        // @ts-expect-error test-only source-ledger identity corruption
        .db.prepare(`UPDATE observations SET concept_id = ? WHERE id = ?`)
        .run(sourceA.conceptId, sourceB.observationId);
      await expect(core.supersedeSourceChunkObservation(sourceA.conceptId, sourceB.observationId, sourceA.observationId))
        .rejects.toThrow("identity does not match");
    } finally {
      core.close();
    }
  });

  it("refreshes only the exact current source observation across A→B→A", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const a = await core.storeSource("Version A.", {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-a1:snapshot-a1",
      });
      const b = await core.storeSource("Version B.", {
        attachTo: a.conceptId,
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-b:snapshot-b",
      });
      const aAgain = await core.storeSource("Version A.", {
        attachTo: a.conceptId,
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-a2:snapshot-a2",
      });
      // File=concept (Phase 1): body verification is recomputeSourceConceptBody's job now, driven
      // from the ledger's active chunk set (source_chunks) — this low-level unit test has no
      // registered source run to populate it, so it verifies the real compensation directly: the
      // observation-pair state (a superseded by aAgain).
      await core.supersedeSourceChunkObservation(a.conceptId, aAgain.observationId, a.observationId);
      const refreshedObs = core
        // @ts-expect-error test-only raw observation-state assertion
        .db.prepare(`SELECT superseded_by, superseded_at FROM observations WHERE id = ?`).get(a.observationId) as
        { superseded_by: string | null; superseded_at: number | null };
      expect(refreshedObs.superseded_by).toBe(aAgain.observationId);
      expect(refreshedObs.superseded_at).not.toBeNull();
      await expect(core.supersedeSourceChunkObservation(a.conceptId, b.observationId, a.observationId)).rejects.toThrow("compare-and-swap failed");
    } finally {
      core.close();
    }
  });

  it("uses the observation-pair CAS so delayed B cannot replace activated C", async () => {
    // File=concept (Phase 1): there is no concept-level active_observation_id CAS any more (a
    // file concept legitimately holds many simultaneously-active observations) — the safety
    // property this test protects is now observation-pair-scoped: once A's predecessor slot has
    // been claimed by C, a delayed B naming the SAME stale predecessor must fail, and C's own
    // evidence must stay exactly as activated (live, unsuperseded).
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const a = await core.storeSource("Version A.", {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-cas:fingerprint-a:snapshot-a",
      });
      const b = await core.storeSource("Version B.", {
        attachTo: a.conceptId,
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-cas:fingerprint-b:snapshot-b",
      });
      const c = await core.storeSource("Version C.", {
        attachTo: a.conceptId,
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-cas:fingerprint-c:snapshot-c",
      });
      // File=concept (Phase 1): body verification is recomputeSourceConceptBody's job now, driven
      // from the ledger's active chunk set — this low-level unit test has no registered source
      // run to populate it, so the observation-pair state below is the real assertion.
      await core.supersedeSourceChunkObservation(a.conceptId, c.observationId, a.observationId);
      await expect(core.supersedeSourceChunkObservation(a.conceptId, b.observationId, a.observationId))
        .rejects.toThrow("compare-and-swap failed");
      const observations = core
        // @ts-expect-error test-only raw observation-state assertion
        .db.prepare(`SELECT id, superseded_by, superseded_at FROM observations WHERE id IN (?, ?)`)
        .all(a.observationId, c.observationId) as Array<{ id: string; superseded_by: string | null; superseded_at: number | null }>;
      const aRow = observations.find((o) => o.id === a.observationId)!;
      const cRow = observations.find((o) => o.id === c.observationId)!;
      expect(aRow.superseded_by).toBe(c.observationId);
      expect(aRow.superseded_at).not.toBeNull();
      expect(cRow.superseded_by).toBeNull();
      expect(cRow.superseded_at).toBeNull();
    } finally {
      core.close();
    }
  });

  it("replays an exact already-committed source supersession idempotently", async () => {
    // File=concept (Phase 1): supersedeSourceChunkObservation's replay check is purely
    // observation-pair-scoped now (no concept-level active_observation_id topology to compare —
    // see the method's own docstring). A genuine crash-window replay (identical args, nothing
    // else changed) must be a silent no-op; this also documents the one deliberate simplification
    // versus the old CAS: because there is no concept-level pointer to protect any more, directly
    // corrupting an observation's own bookkeeping back to "live" is no longer distinguishable from
    // a fresh predecessor, so a retry in that exact shape just re-applies (and correctly
    // reconverges) rather than rejecting — a narrower guarantee than before, but the one thing
    // that actually mattered (never silently overwriting a DIFFERENT successor's claim) still
    // holds, proven separately above ("uses the observation-pair CAS...").
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const predecessor = await core.storeSource("Replay predecessor.", {
        sourceRefs: [sourceRef], operationId: "source-a:binding-replay:fingerprint-a:snapshot-a",
      });
      const successor = await core.storeSource("Replay successor.", {
        attachTo: predecessor.conceptId, sourceRefs: [sourceRef],
        operationId: "source-a:binding-replay:fingerprint-b:snapshot-b",
      });
      await core.supersedeSourceChunkObservation(
        predecessor.conceptId, successor.observationId, predecessor.observationId,
      );
      const afterFirst = core
        // @ts-expect-error test-only raw observation-state assertion
        .db.prepare(`SELECT superseded_by, superseded_at FROM observations WHERE id = ?`)
        .get(predecessor.observationId) as { superseded_by: string | null; superseded_at: number | null };
      // Exact replay (identical args, nothing else changed) is a silent no-op.
      await core.supersedeSourceChunkObservation(
        predecessor.conceptId, successor.observationId, predecessor.observationId,
      );
      const afterReplay = core
        // @ts-expect-error test-only raw observation-state assertion
        .db.prepare(`SELECT superseded_by, superseded_at FROM observations WHERE id = ?`)
        .get(predecessor.observationId) as { superseded_by: string | null; superseded_at: number | null };
      expect(afterReplay).toEqual(afterFirst);
    } finally {
      core.close();
    }
  });

  it("supports terminal deletion, retirement, and restoration without stale retrieval", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const native = await core.store("Terminally removed native evidence.");
      const terminal = core.supersedeObservation(native.observationId, null);
      expect(terminal).toEqual({
        oldObservationId: native.observationId,
        newObservationId: null,
        terminal: true,
        alreadySuperseded: false,
      });
      expect(core.supersedeObservation(native.observationId, null).alreadySuperseded).toBe(true);

      const source = await core.storeSource("Retire me from source retrieval.", {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v1:snapshot-v1",
      });

      const retired = core.retireConcept(source.conceptId)!;
      expect(retired.status).toBe("retired");
      await expect(core.supersedeSourceChunkObservation(source.conceptId, source.observationId, source.observationId)).rejects.toThrow("non-active source concept");
      expect((await core.search("retire source retrieval")).map((c) => c.id)).not.toContain(source.conceptId);
      expect((await core.gather("retire source retrieval")).ranked.map((c) => c.id)).not.toContain(source.conceptId);
      expect(core.overview().livingModel.map((c) => c.id)).not.toContain(source.conceptId);

      expect(() => core.restoreConcept(source.conceptId)).toThrow(/source sync\/rebuild owns restoration/);
      expect((await core.search("retire source retrieval")).map((c) => c.id)).not.toContain(source.conceptId);
    } finally {
      core.close();
    }
  });

  it("terminally supersedes a source concept's active observation and clears the active pointer", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const source = await core.storeSource("Content to be deleted upstream.", {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v1:snapshot-v1",
      });
      const terminal = core.supersedeObservation(source.observationId, null);
      expect(terminal).toEqual({
        oldObservationId: source.observationId,
        newObservationId: null,
        terminal: true,
        alreadySuperseded: false,
      });
      const row = core
        // @ts-expect-error test-only active-pointer assertion
        .db.prepare(`SELECT active_observation_id FROM concepts WHERE id = ?`).get(source.conceptId) as { active_observation_id: string | null };
      expect(row.active_observation_id).toBeNull();
    } finally {
      core.close();
    }
  });

  it("documents the husk contract: a terminally-superseded source observation cannot be reused, and new evidence does not revive the vestigial pointer", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const source = await core.storeSource("Content to be deleted upstream.", {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v1:snapshot-v1",
      });
      core.supersedeObservation(source.observationId, null);

      // File=concept (Phase 1): supersedeSourceChunkObservation rejects outright — the
      // observation itself is already terminally superseded, so it cannot serve as either the
      // successor or the predecessor of a fresh supersession.
      await expect(core.supersedeSourceChunkObservation(source.conceptId, source.observationId, source.observationId))
        .rejects.toThrow("already superseded");

      // storeSourceChunk's attachTo path (new evidence attached to the still-active concept) does
      // not touch active_observation_id — it is permanently vestigial once set at creation, never
      // revived or reused by any write path (see classifyOperationOwnership/rollbackSourceRunBinding
      // in source-ledger.ts for why it can no longer mean "the" current observation).
      await core.storeSource("New evidence arriving after the chunk was deleted.", {
        attachTo: source.conceptId,
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v2:snapshot-v2",
      });
      const row = core
        // @ts-expect-error test-only active-pointer assertion
        .db.prepare(`SELECT active_observation_id FROM concepts WHERE id = ?`).get(source.conceptId) as { active_observation_id: string | null };
      expect(row.active_observation_id).toBeNull();

      // The caller's required cleanup step still succeeds cleanly.
      const retired = core.retireConcept(source.conceptId)!;
      expect(retired.status).toBe("retired");
    } finally {
      core.close();
    }
  });

  it("rejects a successor replacement on a source observation — activation stays supersedeSourceChunkObservation's job", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const first = await core.storeSource("Version one.", {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v1:snapshot-v1",
      });
      const second = await core.storeSource("Version two.", {
        attachTo: first.conceptId,
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v2:snapshot-v2",
      });
      expect(() => core.supersedeObservation(first.observationId, second.observationId))
        .toThrow("source observations are superseded only by supersedeSourceChunkObservation activation");
    } finally {
      core.close();
    }
  });

  it("supersedes a native observation via old→new successor, validating same-concept and non-superseded-successor constraints", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const a1 = await core.store("Concept A observation one.", { resolution: "forceNew" });
      const a2 = await core.store("Concept A observation two.", { attachTo: a1.conceptId });
      const a3 = await core.store("Concept A observation three.", { attachTo: a1.conceptId });
      const a4 = await core.store("Concept A observation four.", { attachTo: a1.conceptId });
      const b1 = await core.store("Concept B observation.", { resolution: "forceNew" });

      // Same-concept validation: a successor from a different concept is rejected.
      expect(() => core.supersedeObservation(a1.observationId, b1.observationId))
        .toThrow("successor observation must belong to the same concept");

      // Happy path: native old→new successor replacement within the same concept.
      const result = core.supersedeObservation(a1.observationId, a2.observationId);
      expect(result).toEqual({
        oldObservationId: a1.observationId,
        newObservationId: a2.observationId,
        terminal: false,
        alreadySuperseded: false,
      });

      // Make a3 itself superseded (by a4) so it becomes an invalid successor candidate below.
      core.supersedeObservation(a3.observationId, a4.observationId);

      // Already-superseded-successor rejection: a3 cannot be reused as a successor once superseded.
      expect(() => core.supersedeObservation(a2.observationId, a3.observationId))
        .toThrow("successor observation is already superseded");
    } finally {
      core.close();
    }
  });

  it("preserves the dirty flag across a retire/restore round-trip", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const stored = await core.store("Concept pending synthesis.", { resolution: "forceNew" });
      expect(core.isDirty(stored.conceptId)).toBe(true);
      expect(core.listDirty().map((d) => d.id)).toContain(stored.conceptId);
      expect(core.stats().dirty).toBe(1);
      expect(core.overview().counts.dirty).toBe(1);

      core.retireConcept(stored.conceptId);
      expect(core.listDirty().map((d) => d.id)).not.toContain(stored.conceptId);
      expect(core.stats().dirty).toBe(0);
      expect(core.overview().counts.dirty).toBe(0);

      core.restoreConcept(stored.conceptId);
      expect(core.isDirty(stored.conceptId)).toBe(true);
      expect(core.listDirty().map((d) => d.id)).toContain(stored.conceptId);
      expect(core.stats().dirty).toBe(1);
      expect(core.overview().counts.dirty).toBe(1);
    } finally {
      core.close();
    }
  });

  it("does not revive retired concepts through ordinary mutation or inventory", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 0, tauAmbiguous: 0 });
    try {
      const original = await core.store("Retired native concept.", { resolution: "forceNew" });
      core.retireConcept(original.conceptId);
      await expect(core.getConcept(original.conceptId)).resolves.toBeNull();
      await expect(core.store("Attempted revive.", { attachTo: original.conceptId })).rejects.toThrow("retired concept");
      expect(() => core.flagContradiction(original.conceptId, { detail: "Attempted revive." })).toThrow("retired concept");
      const replacement = await core.store("Retired native concept.");
      expect(replacement.conceptId).not.toBe(original.conceptId);
      expect(core.listMemories().map((entry) => entry.id)).not.toContain(original.conceptId);
      expect(core.conceptCount()).toBe(1);
      expect(core.stats().concepts).toBe(1);
    } finally {
      core.close();
    }
  });

  it("closes graph reads and direct mutations over retired concepts", async () => {
    const core = new MonetCore(":memory:", { tauAttach: 1.1, tauAmbiguous: 1.1 });
    try {
      const target = await core.store("Target native record.", { resolution: "forceNew" });
      const referrer = await core.store(`Retired referrer supports: #${target.concept.slug}.`, { resolution: "forceNew" });
      expect(core.edges({ circle: "default", type: "supports" }).some((edge) => edge.srcId === referrer.conceptId)).toBe(true);
      core.retireConcept(referrer.conceptId);
      await core.store("Target native record updated.", { attachTo: target.conceptId });

      expect(core.edges({ circle: "default" }).some((edge) => edge.srcId === referrer.conceptId || edge.dstId === referrer.conceptId)).toBe(false);
      expect(core.topConnectedConcepts().map((concept) => concept.id)).not.toContain(referrer.conceptId);
      expect(core.topThread()?.members.map((concept) => concept.id) ?? []).not.toContain(referrer.conceptId);

      const retired = await core.store("Retired mutable source.", { resolution: "forceNew" });
      core.retireConcept(retired.conceptId);
      expect(() => core.reassignCircle(retired.conceptId, "other")).toThrow("retired concept");
      await expect(core.detach(retired.conceptId, [retired.observationId])).rejects.toThrow("retired concept");
      expect(core.batchReassignCircle([retired.conceptId], "other").counts.error).toBe(1);

      const retiredCircle = await core.store("Retired circle member.", { circle: "retired-circle", resolution: "forceNew" });
      core.retireConcept(retiredCircle.conceptId);
      expect(() => core.renameCircle("retired-circle", "renamed-circle")).toThrow("retired concepts");
      await expect(core.mergeCircle("retired-circle", "other-circle")).rejects.toThrow("retired concepts");

      const active = await core.store("Active split source.", { resolution: "forceNew" });
      const movable = await core.store("Movable observation.", { attachTo: active.conceptId });
      const retiredDestination = await core.store("Retired destination.", { resolution: "forceNew" });
      core.retireConcept(retiredDestination.conceptId);
      await expect(core.detach(active.conceptId, [movable.observationId], {
        destConceptId: retiredDestination.conceptId,
      })).rejects.toThrow("retired concept");
    } finally {
      core.close();
    }
  });

  it("keeps workstreams on their dedicated active/archive lifecycle", async () => {
    const core = new MonetCore(":memory:");
    try {
      const workstream = await core.saveWorkstream({ status: "active", decisions: ["Keep the workstream lifecycle separate."] });
      expect(() => core.retireConcept(workstream.id)).toThrow("workstream concept");
      expect(() => core.restoreConcept(workstream.id)).toThrow("workstream concept");
      expect(core.getActiveWorkstreams().map((item) => item.id)).toContain(workstream.id);
    } finally {
      core.close();
    }
  });

  it("keeps source concepts outside generic sync and rejects forged source grafts", async () => {
    const source = new MonetCore(":memory:");
    const replica = new MonetCore(":memory:");
    try {
      const stored = await source.storeSource("Connector-owned source text.", {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-a:fingerprint-v1:snapshot-v1",
      });
      expect(source.exportDelta(0).concepts).toEqual([]);

      const sourceRow = source
        // @ts-expect-error test-only inspection of a forged generic-sync payload
        .db.prepare(`SELECT * FROM concepts WHERE id = ?`)
        .get(stored.conceptId) as GraftPayload["concepts"][number];
      const forged = { ...source.exportDelta(0), concepts: [sourceRow] };
      expect(() => replica.graftRows(forged)).toThrow("source-owned");

      const localSource = await replica.storeSource("Replica source text.", {
        sourceRefs: [sourceRef],
        operationId: "source-a:binding-b:fingerprint-v1:snapshot-v1",
      });
      const observationForge: GraftPayload = {
        ...source.exportDelta(0),
        observations: [{
          id: "forged-source-observation",
          content: "Forged native-looking evidence.",
          embedding: "[]",
          kind: "statement",
          circle: "default",
          concept_id: localSource.conceptId,
          superseded_by: null,
          superseded_at: null,
          session_id: null,
          author_agent_id: "attacker",
          source_refs: null,
          created_at: Date.now(),
        }],
      };
      expect(() => replica.graftRows(observationForge)).toThrow("source-owned");

      // A forged tombstone naming a local source id must reject the WHOLE payload — not just
      // silently skip that row — otherwise a generic sync could retire a connector-owned concept.
      const tombstoneForge: GraftPayload = {
        ...source.exportDelta(0),
        tombstones: [{ concept_id: localSource.conceptId, retired_at: Date.now() }],
      };
      expect(() => replica.graftRows(tombstoneForge)).toThrow("source-owned");

      // Same backdoor, the other direction: a forged restoration could revive a source concept
      // the connector (or a legitimate retireConcept call) had retired.
      const restorationForge: GraftPayload = {
        ...source.exportDelta(0),
        restorations: [{ concept_id: localSource.conceptId, restored_at: Date.now() }],
      };
      expect(() => replica.graftRows(restorationForge)).toThrow("source-owned");
    } finally {
      source.close();
      replica.close();
    }
  });
});
