import { describe, it, expect } from "vitest";
import { MonetCore } from "../engine.js";

/**
 * The agent-as-Synthesizer dance (ADR §4.6) at the engine level — what the MCP
 * memory_fetch → (agent writes body) → memory_synthesize round-trip drives:
 */
describe("agent-driven synthesis (the MCP dance)", () => {
  it("fetch without auto-synthesis flags needsSynthesis + returns raw evidence", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("We use SQLite for Monet Local storage.");
    await core.store("Monet Local stores its data in SQLite.");

    const raw = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    expect(raw.needsSynthesis).toBe(true); // dirty, not auto-cleaned
    expect(raw.synthesizedNow).toBe(false); // the engine did NOT synthesize
    expect(raw.observations).toHaveLength(2); // the agent gets the evidence to work from
    core.close();
  });

  it("applySynthesis writes the agent's body back and clears dirty", async () => {
    const core = new MonetCore(":memory:");
    const a = await core.store("We use SQLite for Monet Local storage.");
    await core.store("Monet Local stores its data in SQLite.");

    const updated = (await core.applySynthesis(
      a.conceptId,
      "Monet Local persists memory in a local SQLite database.",
    ))!;
    expect(updated.dirty).toBe(false);
    expect(updated.body).toContain("SQLite");

    const after = (await core.getConcept(a.conceptId, { synthesize: false }))!;
    expect(after.needsSynthesis).toBe(false); // clean now
    expect(after.revisions).toBe(1); // the synthesis was recorded
    core.close();
  });

  it("listDirty surfaces concepts + evidence for batch synthesis (checkpoint)", async () => {
    const core = new MonetCore(":memory:");
    await core.store("We use SQLite for storage.");
    await core.store("The team prefers pytest for testing.");
    const dirty = core.listDirty();
    expect(dirty).toHaveLength(2);
    expect(dirty[0].observations.length).toBeGreaterThan(0);
    core.close();
  });
});
