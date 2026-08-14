import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine";

const removedFields = [
  "openContradictions",
  "topConcepts",
  "activeWorkstreams",
  "staleCount",
  "curationAttention",
  "otherCircles",
  "agentId",
  "mode",
  "staleConcepts",
] as const;

describe("prewarm — session-start orientation", () => {
  it("carries none of the task or curation fields retired from resident state", async () => {
    const core = new MonetCore(":memory:");
    const stored = await core.store("We use SQLite for local storage.");
    await core.saveWorkstream({ status: "active", open: [{ slot: "step" as const, text: "continue implementation" }] });
    core.flagContradiction(stored.conceptId, { detail: "new evidence disagrees" });

    const state = core.prewarm() as Record<string, unknown>;
    for (const key of removedFields) expect(state).not.toHaveProperty(key);
    core.close();
  });

  it("carries the stage index and omits it when empty", async () => {
    const core = new MonetCore(":memory:");
    await core.store("We use SQLite for Monet Local storage.");
    expect(core.prewarm().stageIndex).toBeUndefined();

    await core.store("Never force-push to a shared branch.", {
      kind: "rule",
      rule: { stage: "git force push", scope: "agent", modelTag: "test-model" },
    });
    expect(core.prewarm().stageIndex).toEqual(["git force push"]);
    core.close();
  });
});
