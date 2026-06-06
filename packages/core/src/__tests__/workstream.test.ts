import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonetCore } from "../engine.js";

/**
 * Session-state survival (#241, ADR §3.6/§4.3): the agent compresses a session into a
 * workstream payload at checkpoint; it survives as a single `workstream` concept that the
 * next session restores.
 */
describe("workstream + checkpoint (session-state survival, #241)", () => {
  it("saveWorkstream creates then UPDATES one concept (versioned, never dirty)", async () => {
    const core = new MonetCore(":memory:");

    const w1 = await core.saveWorkstream({
      status: "active",
      openQuestions: ["how to tune dedup thresholds?"],
      nextSteps: ["wire prewarm"],
    });
    expect(w1.payload.openQuestions).toEqual(["how to tune dedup thresholds?"]);
    expect(w1.version).toBe(0);
    expect(core.isDirty(w1.id)).toBe(false); // agent-authored → no synthesis needed

    const w2 = await core.saveWorkstream({
      status: "active",
      openQuestions: [],
      nextSteps: ["wire prewarm", "add contradiction tier"],
      decisions: ["use MiniLM-384 locally"],
    });
    expect(w2.id).toBe(w1.id); // same workstream, updated in place
    expect(w2.version).toBe(1);
    expect(w2.payload.decisions).toEqual(["use MiniLM-384 locally"]);
    expect(core.getActiveWorkstreams()).toHaveLength(1);

    core.close();
  });

  it("restores active workstreams in a NEW session (DB reopen = next session)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monet-ws-"));
    const dbPath = join(dir, "ws.db");
    try {
      const s1 = new MonetCore(dbPath);
      await s1.saveWorkstream(
        { status: "active", openQuestions: ["resume #242?"], nextSteps: ["build prewarm ranking"] },
        { summary: "end of session 1" },
      );
      s1.close();

      const s2 = new MonetCore(dbPath); // "next session" — fresh instance, same store
      const restored = s2.getActiveWorkstreams();
      expect(restored).toHaveLength(1);
      expect(restored[0].payload.openQuestions).toEqual(["resume #242?"]);
      expect(restored[0].payload.nextSteps).toEqual(["build prewarm ranking"]);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compresses many observations into one workstream update", async () => {
    const core = new MonetCore(":memory:");
    for (const c of ["tried approach A", "approach A failed on X", "switched to approach B", "B works", "next: write tests"]) {
      await core.store(c);
    }
    expect(core.observationCount()).toBe(5);

    const w = await core.saveWorkstream({
      status: "active",
      decisions: ["use approach B"],
      discardedAlternatives: ["approach A — failed on X"],
      nextSteps: ["write tests"],
    });
    expect(core.getActiveWorkstreams()).toHaveLength(1); // five turns → one durable workstream
    expect(w.payload.discardedAlternatives?.[0]).toContain("approach A");
    core.close();
  });

  it("a normal store() never folds into a workstream, and search excludes workstreams", async () => {
    const core = new MonetCore(":memory:");
    // payload text deliberately overlaps a real concept we then store
    const w = await core.saveWorkstream({ status: "active", nextSteps: ["use SQLite for storage backend"] });

    const s = await core.store("We decided to use SQLite as the storage backend for Monet Local.");
    expect(s.conceptId).not.toBe(w.id); // did NOT attach to the workstream
    expect(s.action).toBe("created");

    const hits = await core.search("sqlite storage backend");
    expect(hits.some((h) => h.id === w.id)).toBe(false); // workstream never appears as a search card
    expect(core.conceptCount()).toBe(1); // conceptCount excludes the workstream
    core.close();
  });

  it("'done' workstreams drop out of the active restore set", async () => {
    const core = new MonetCore(":memory:");
    await core.saveWorkstream({ status: "active", nextSteps: ["ship it"] });
    expect(core.getActiveWorkstreams()).toHaveLength(1);
    await core.saveWorkstream({ status: "done", nextSteps: [] });
    expect(core.getActiveWorkstreams()).toHaveLength(0);
    core.close();
  });

  it("checkpoint ends the session; the next write opens a fresh one", async () => {
    const core = new MonetCore(":memory:");
    await core.store("a"); // session 1 opens
    expect(core.stats().sessions).toBe(1);
    await core.saveWorkstream({ status: "active" }, { summary: "done for now" }); // ends session 1
    await core.store("b"); // session 2 opens
    expect(core.stats().sessions).toBe(2);
    expect(core.stats().workstreams).toBe(1);
    core.close();
  });
});
